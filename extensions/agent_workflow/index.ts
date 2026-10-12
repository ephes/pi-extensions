import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import { getMarkdownTheme, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { type AgentConfig, discoverBundledAgents, formatAgentList } from "./agents.js";
import { resolveAgentModel, type ModelRef } from "./model_resolution.js";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;
const MAX_CHAIN_CONTEXT_CHARS = 12000;

interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

interface SingleResult {
  agent: string;
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  warnings: string[];
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
}

interface AgentWorkflowDetails {
  mode: "single" | "parallel" | "chain";
  agentsDir: string;
  results: SingleResult[];
}

type DisplayItem =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; args: Record<string, unknown> };

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: AgentWorkflowDetails;
  isError?: boolean;
};

type OnUpdateCallback = (partial: ToolResult) => void;

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextTokens?: number;
    turns?: number;
  },
  model?: string,
): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens && usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

type DisplayThemeColor = "muted" | "toolOutput" | "accent" | "warning" | "dim";

function formatToolCall(toolName: string, args: Record<string, unknown>, themeFg: (color: DisplayThemeColor, text: string) => string): string {
  const shortenPath = (value: string) => {
    const home = os.homedir();
    return value.startsWith(home) ? `~${value.slice(home.length)}` : value;
  };

  switch (toolName) {
    case "bash": {
      const command = typeof args.command === "string" ? args.command : "...";
      const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
      return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
    }
    case "read": {
      const rawPath = typeof args.path === "string" ? args.path : "...";
      const filePath = shortenPath(rawPath);
      const offset = typeof args.offset === "number" ? args.offset : undefined;
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      let text = themeFg("accent", filePath);
      if (offset !== undefined || limit !== undefined) {
        const startLine = offset ?? 1;
        const endLine = limit !== undefined ? startLine + limit - 1 : "";
        text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
      }
      return themeFg("muted", "read ") + text;
    }
    case "write": {
      const rawPath = typeof args.path === "string" ? args.path : "...";
      const filePath = shortenPath(rawPath);
      return themeFg("muted", "write ") + themeFg("accent", filePath);
    }
    case "edit": {
      const rawPath = typeof args.path === "string" ? args.path : "...";
      return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
    }
    case "ls": {
      const rawPath = typeof args.path === "string" ? args.path : ".";
      return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
    }
    case "find": {
      const pattern = typeof args.pattern === "string" ? args.pattern : "*";
      const rawPath = typeof args.path === "string" ? args.path : ".";
      return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
    }
    case "grep": {
      const pattern = typeof args.pattern === "string" ? args.pattern : "";
      const rawPath = typeof args.path === "string" ? args.path : ".";
      return themeFg("muted", "grep ") + themeFg("accent", `/${pattern}/`) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
    }
    default: {
      const argsStr = JSON.stringify(args);
      const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
      return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
    }
  }
}

function getFinalOutput(messages: Message[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type === "text") return part.text;
    }
  }
  return "";
}

function getDisplayItems(messages: Message[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type === "text") {
        items.push({ type: "text", text: part.text });
      } else if (part.type === "toolCall") {
        items.push({ type: "toolCall", name: part.name, args: (part.arguments ?? {}) as Record<string, unknown> });
      }
    }
  }
  return items;
}

function formatWarningsBlock(warnings: string[]): string {
  if (warnings.length === 0) return "";
  return `Warnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}`;
}

function combineTextWithWarnings(text: string, warnings: string[]): string {
  const warningsBlock = formatWarningsBlock(warnings);
  if (!warningsBlock) return text;
  return text ? `${warningsBlock}\n\n${text}` : warningsBlock;
}

function getErrorText(result: SingleResult): string {
  const baseText = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
  const warnings = result.warnings.filter((warning) => warning !== baseText);
  return combineTextWithWarnings(baseText, warnings);
}

function getSuccessText(result: SingleResult): string {
  return combineTextWithWarnings(getFinalOutput(result.messages) || "(no output)", result.warnings);
}

async function mapWithConcurrencyLimit<TInput, TOutput>(
  items: TInput[],
  concurrency: number,
  fn: (item: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<TOutput>(items.length);
  let nextIndex = 0;

  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  });

  await Promise.all(workers);
  return results;
}

function writePromptToTempFile(agentName: string, prompt: string): { dir: string; filePath: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-workflow-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tempDir, `prompt-${safeName}.md`);
  fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  return { dir: tempDir, filePath };
}

function truncatePreviousOutput(previousOutput: string): string {
  if (previousOutput.length <= MAX_CHAIN_CONTEXT_CHARS) {
    return previousOutput;
  }

  const preserved = previousOutput.slice(0, MAX_CHAIN_CONTEXT_CHARS);
  return [
    `[Previous agent workflow output truncated from ${previousOutput.length} to ${MAX_CHAIN_CONTEXT_CHARS} characters.]`,
    preserved,
  ].join("\n\n");
}

async function runSingleAgent(
  defaultCwd: string,
  agents: AgentConfig[],
  availableModels: ModelRef[],
  currentModel: ModelRef | undefined,
  agentName: string,
  task: string,
  cwd: string | undefined,
  step: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (results: SingleResult[]) => AgentWorkflowDetails,
): Promise<SingleResult> {
  const agent = agents.find((candidate) => candidate.name === agentName);

  if (!agent) {
    return {
      agent: agentName,
      task,
      exitCode: 1,
      messages: [],
      stderr: `Unknown agent: ${agentName}`,
      warnings: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      step,
    };
  }

  const modelSelection = resolveAgentModel(agent.model, availableModels, currentModel);
  if (!modelSelection.resolvedModel) {
    return {
      agent: agent.name,
      task,
      exitCode: 1,
      messages: [],
      stderr: "No authenticated Pi models are configured. Run /login or configure an API key.",
      warnings: modelSelection.warning ? [modelSelection.warning] : [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
      model: agent.model,
      step,
    };
  }

  const args: string[] = [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--no-extensions",
    "--no-prompt-templates",
    "--no-skills",
    "--model",
    modelSelection.resolvedModel,
  ];
  if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

  let tempPromptDir: string | null = null;
  let tempPromptPath: string | null = null;
  let aborted = false;

  const currentResult: SingleResult = {
    agent: agent.name,
    task,
    exitCode: 0,
    messages: [],
    stderr: "",
    warnings: modelSelection.warning ? [modelSelection.warning] : [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    model: modelSelection.resolvedModel,
    step,
  };

  const emitUpdate = () => {
    if (!onUpdate) return;
    onUpdate({
      content: [{ type: "text", text: combineTextWithWarnings(getFinalOutput(currentResult.messages) || "(running...)", currentResult.warnings) }],
      details: makeDetails([currentResult]),
    });
  };

  try {
    if (agent.systemPrompt.trim()) {
      const temp = writePromptToTempFile(agent.name, agent.systemPrompt);
      tempPromptDir = temp.dir;
      tempPromptPath = temp.filePath;
      args.push("--append-system-prompt", tempPromptPath);
    }

    args.push(`Task: ${task}`);

    const exitCode = await new Promise<number>((resolve) => {
      const proc = spawn("pi", args, {
        cwd: cwd ?? defaultCwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let buffer = "";
      let settled = false;
      let closed = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (killTimer) clearTimeout(killTimer);
        signal?.removeEventListener("abort", killProc);
      };
      const finish = (code: number) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(code);
      };
      const killProc = () => {
        if (settled || closed) return;
        aborted = true;
        proc.kill("SIGTERM");
        killTimer = setTimeout(() => {
          if (!closed) proc.kill("SIGKILL");
        }, 5000);
      };

      const processLine = (line: string) => {
        if (!line.trim()) return;

        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }

        if (!event || typeof event !== "object") return;
        const maybeEvent = event as {
          type?: string;
          message?: Message;
        };

        if (maybeEvent.type === "message_end" && maybeEvent.message) {
          const message = maybeEvent.message;
          currentResult.messages.push(message);
          if (message.role === "assistant") {
            currentResult.usage.turns += 1;
            const usage = message.usage;
            if (usage) {
              currentResult.usage.input += usage.input || 0;
              currentResult.usage.output += usage.output || 0;
              currentResult.usage.cacheRead += usage.cacheRead || 0;
              currentResult.usage.cacheWrite += usage.cacheWrite || 0;
              currentResult.usage.cost += usage.cost?.total || 0;
              currentResult.usage.contextTokens = usage.totalTokens || 0;
            }
            if (!currentResult.model && message.model) currentResult.model = message.model;
            if (message.stopReason) currentResult.stopReason = message.stopReason;
            if (message.errorMessage) currentResult.errorMessage = message.errorMessage;
          }
          emitUpdate();
        }

        if (maybeEvent.type === "tool_result_end" && maybeEvent.message) {
          currentResult.messages.push(maybeEvent.message);
          emitUpdate();
        }
      };

      proc.stdout.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });

      proc.stderr.on("data", (chunk) => {
        currentResult.stderr += chunk.toString();
      });

      proc.on("close", (code, closeSignal) => {
        closed = true;
        if (buffer.trim()) processLine(buffer);
        if (closeSignal) {
          currentResult.errorMessage = `Agent subprocess terminated by ${closeSignal}. Output may be incomplete.`;
        } else if (code === null) {
          currentResult.errorMessage = "Agent subprocess closed without an exit code. Output may be incomplete.";
        }
        finish(closeSignal ? 1 : (code ?? 1));
      });

      proc.on("error", (error) => {
        currentResult.errorMessage = error.message;
        // Spawn failures have no child to reap; running children still settle on close.
        if (proc.pid === undefined) finish(1);
      });

      if (signal?.aborted) killProc();
      else signal?.addEventListener("abort", killProc, { once: true });
    });

    currentResult.exitCode = exitCode;
    if (aborted) throw new Error("Agent workflow was aborted.");
    return currentResult;
  } finally {
    if (tempPromptPath) {
      try {
        fs.unlinkSync(tempPromptPath);
      } catch {
        // Ignore cleanup failures for temp prompt files.
      }
    }
    if (tempPromptDir) {
      try {
        fs.rmSync(tempPromptDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup failures for temp prompt directories.
      }
    }
  }
}

const TaskItem = Type.Object({
  agent: Type.String({ description: "Name of the bundled agent to invoke." }),
  task: Type.String({ description: "Task to delegate to the bundled agent." }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent workflow process." })),
});

const AgentWorkflowParams = Type.Object({
  agent: Type.Optional(Type.String({ description: "Name of the bundled agent to invoke (single mode)." })),
  task: Type.Optional(Type.String({ description: "Task to delegate (single mode)." })),
  tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution." })),
  chain: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for sequential execution. Use {previous} to insert prior output." })),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent workflow process (single mode)." })),
  mode: Type.Optional(StringEnum(["single", "parallel", "chain"] as const, { description: "Optional explicit mode for readability." })),
});

export default function agentWorkflowExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "agent_workflow",
    label: "Agent Workflow",
    description: "Run bundled specialist agent workflows with isolated context. Supports single, parallel, and chain modes.",
    promptSnippet: "Run bundled specialist agent workflows with isolated context.",
    promptGuidelines: [
      "Use the bundled implementer for implementation tasks that benefit from an isolated context window.",
      "Use the bundled reviewer for review tasks and keep it read-only.",
      "Use chain mode when a later agent should consume the previous agent's output via {previous}.",
    ],
    parameters: AgentWorkflowParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const discovery = discoverBundledAgents();
      const agents = discovery.agents;
      const availableModels: ModelRef[] = ctx.modelRegistry.getAvailable().map((model) => ({
        provider: model.provider,
        id: model.id,
      }));
      const currentModel: ModelRef | undefined = ctx.model
        ? { provider: ctx.model.provider, id: ctx.model.id }
        : undefined;

      const hasChain = (params.chain?.length ?? 0) > 0;
      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = Boolean(params.agent && params.task);
      const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

      const makeDetails = (mode: "single" | "parallel" | "chain") => (results: SingleResult[]): AgentWorkflowDetails => ({
        mode,
        agentsDir: discovery.agentsDir,
        results,
      });

      if (modeCount !== 1) {
        return {
          content: [{ type: "text", text: `Invalid parameters. Available bundled agents: ${formatAgentList(agents)}` }],
          details: makeDetails("single")([]),
        };
      }

      if (params.chain && params.chain.length > 0) {
        const results: SingleResult[] = [];
        let previousOutput = "";

        for (let index = 0; index < params.chain.length; index += 1) {
          const step = params.chain[index];
          const taskWithContext = step.task.replace(/\{previous\}/g, truncatePreviousOutput(previousOutput));
          const chainUpdate: OnUpdateCallback | undefined = onUpdate
            ? (partial) => {
                const current = partial.details?.results[0];
                if (!current) return;
                onUpdate({
                  content: partial.content,
                  details: makeDetails("chain")([...results, current]),
                });
              }
            : undefined;

          const result = await runSingleAgent(
            ctx.cwd,
            agents,
            availableModels,
            currentModel,
            step.agent,
            taskWithContext,
            step.cwd,
            index + 1,
            signal,
            chainUpdate,
            makeDetails("chain"),
          );
          results.push(result);

          const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
          if (isError) {
            return {
              content: [{ type: "text", text: `Chain stopped at step ${index + 1} (${step.agent}): ${getErrorText(result)}` }],
              details: makeDetails("chain")(results),
              isError: true,
            };
          }

          previousOutput = getFinalOutput(result.messages);
        }

        return {
          content: [{ type: "text", text: getSuccessText(results[results.length - 1]) }],
          details: makeDetails("chain")(results),
        };
      }

      if (params.tasks && params.tasks.length > 0) {
        if (params.tasks.length > MAX_PARALLEL_TASKS) {
          return {
            content: [{ type: "text", text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
            details: makeDetails("parallel")([]),
          };
        }

        const allResults: SingleResult[] = new Array(params.tasks.length).fill(null).map((_, index) => ({
          agent: params.tasks?.[index]?.agent ?? "unknown",
          task: params.tasks?.[index]?.task ?? "",
          exitCode: -1,
          messages: [],
          stderr: "",
          warnings: [],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        }));

        const emitParallelUpdate = () => {
          if (!onUpdate) return;
          const running = allResults.filter((result) => result.exitCode === -1).length;
          const done = allResults.filter((result) => result.exitCode !== -1).length;
          onUpdate({
            content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
            details: makeDetails("parallel")([...allResults]),
          });
        };

        const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (taskItem, index) => {
          const result = await runSingleAgent(
            ctx.cwd,
            agents,
            availableModels,
            currentModel,
            taskItem.agent,
            taskItem.task,
            taskItem.cwd,
            undefined,
            signal,
            (partial) => {
              const current = partial.details?.results[0];
              if (!current) return;
              allResults[index] = current;
              emitParallelUpdate();
            },
            makeDetails("parallel"),
          );
          allResults[index] = result;
          emitParallelUpdate();
          return result;
        });

        const successCount = results.filter((result) => result.exitCode === 0).length;
        const summaries = results.map((result) => {
          const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
          const resultText = isError ? getErrorText(result) : getSuccessText(result);
          const preview = resultText.length > 100 ? `${resultText.slice(0, 100)}...` : resultText;
          return `[${result.agent}] ${isError ? "failed" : "completed"}: ${preview || "(no output)"}`;
        });

        return {
          content: [{ type: "text", text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}` }],
          details: makeDetails("parallel")(results),
        };
      }

      if (params.agent && params.task) {
        const result = await runSingleAgent(
          ctx.cwd,
          agents,
          availableModels,
          currentModel,
          params.agent,
          params.task,
          params.cwd,
          undefined,
          signal,
          onUpdate,
          makeDetails("single"),
        );
        const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
        if (isError) {
          return {
            content: [{ type: "text", text: `Agent ${result.agent} failed: ${getErrorText(result)}` }],
            details: makeDetails("single")([result]),
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: getSuccessText(result) }],
          details: makeDetails("single")([result]),
        };
      }

      return {
        content: [{ type: "text", text: `Invalid parameters. Available bundled agents: ${formatAgentList(agents)}` }],
        details: makeDetails("single")([]),
      };
    },

    renderCall(args, theme) {
      if (Array.isArray(args.chain) && args.chain.length > 0) {
        let text = theme.fg("toolTitle", theme.bold("agent_workflow ")) + theme.fg("accent", `chain (${args.chain.length} steps)`);
        for (const [index, step] of args.chain.slice(0, 3).entries()) {
          const task = typeof step.task === "string" ? step.task.replace(/\{previous\}/g, "").trim() : "";
          const preview = task.length > 40 ? `${task.slice(0, 40)}...` : task;
          text += `\n  ${theme.fg("muted", `${index + 1}.`)} ${theme.fg("accent", String(step.agent ?? "..."))}${theme.fg("dim", ` ${preview}`)}`;
        }
        if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
        return new Text(text, 0, 0);
      }

      if (Array.isArray(args.tasks) && args.tasks.length > 0) {
        let text = theme.fg("toolTitle", theme.bold("agent_workflow ")) + theme.fg("accent", `parallel (${args.tasks.length} tasks)`);
        for (const task of args.tasks.slice(0, 3)) {
          const preview = typeof task.task === "string" && task.task.length > 40 ? `${task.task.slice(0, 40)}...` : String(task.task ?? "...");
          text += `\n  ${theme.fg("accent", String(task.agent ?? "..."))}${theme.fg("dim", ` ${preview}`)}`;
        }
        if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
        return new Text(text, 0, 0);
      }

      const agentName = String(args.agent ?? "...");
      const task = String(args.task ?? "...");
      const preview = task.length > 60 ? `${task.slice(0, 60)}...` : task;
      return new Text(
        theme.fg("toolTitle", theme.bold("agent_workflow ")) + theme.fg("accent", agentName) + `\n  ${theme.fg("dim", preview)}`,
        0,
        0,
      );
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as AgentWorkflowDetails | undefined;
      if (!details || details.results.length === 0) {
        const first = result.content.find((item) => item.type === "text");
        return new Text(first?.text ?? "(no output)", 0, 0);
      }

      const markdownTheme = getMarkdownTheme();
      const aggregateUsage = (results: SingleResult[]) => results.reduce(
        (total, current) => ({
          input: total.input + current.usage.input,
          output: total.output + current.usage.output,
          cacheRead: total.cacheRead + current.usage.cacheRead,
          cacheWrite: total.cacheWrite + current.usage.cacheWrite,
          cost: total.cost + current.usage.cost,
          turns: total.turns + current.usage.turns,
        }),
        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
      );

      const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
        const itemsToShow = limit ? items.slice(-limit) : items;
        const skipped = limit && items.length > limit ? items.length - limit : 0;
        let text = "";
        if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
        for (const item of itemsToShow) {
          if (item.type === "text") {
            const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
            text += `${theme.fg("toolOutput", preview)}\n`;
          } else {
            text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
          }
        }
        return text.trimEnd();
      };

      if (details.mode === "single" && details.results.length === 1) {
        const single = details.results[0];
        const isError = single.exitCode !== 0 || single.stopReason === "error" || single.stopReason === "aborted";
        const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
        const displayItems = getDisplayItems(single.messages);
        const finalOutput = getFinalOutput(single.messages);

        if (expanded) {
          const container = new Container();
          let header = `${icon} ${theme.fg("toolTitle", theme.bold(single.agent))}`;
          if (isError && single.stopReason) header += ` ${theme.fg("error", `[${single.stopReason}]`)}`;
          container.addChild(new Text(header, 0, 0));
          if (isError && single.errorMessage) container.addChild(new Text(theme.fg("error", `Error: ${single.errorMessage}`), 0, 0));
          if (single.warnings.length > 0) container.addChild(new Text(theme.fg("warning", formatWarningsBlock(single.warnings)), 0, 0));
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
          container.addChild(new Text(theme.fg("dim", single.task), 0, 0));
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
          for (const item of displayItems) {
            if (item.type === "toolCall") {
              container.addChild(new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0));
            }
          }
          if (finalOutput) {
            container.addChild(new Spacer(1));
            container.addChild(new Markdown(finalOutput.trim(), 0, 0, markdownTheme));
          }
          const usage = formatUsageStats(single.usage, single.model);
          if (usage) {
            container.addChild(new Spacer(1));
            container.addChild(new Text(theme.fg("dim", usage), 0, 0));
          }
          return container;
        }

        let text = `${icon} ${theme.fg("toolTitle", theme.bold(single.agent))}`;
        if (single.warnings.length > 0) text += `\n${theme.fg("warning", formatWarningsBlock(single.warnings))}`;
        if (displayItems.length === 0) {
          text += `\n${theme.fg("muted", finalOutput || "(no output)")}`;
        } else {
          text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
          if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
        }
        const usage = formatUsageStats(single.usage, single.model);
        if (usage) text += `\n${theme.fg("dim", usage)}`;
        return new Text(text, 0, 0);
      }

      if (details.mode === "chain") {
        const successCount = details.results.filter((entry) => entry.exitCode === 0).length;
        const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");
        let text = `${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", `${successCount}/${details.results.length} steps`)}`;

        if (expanded) {
          const container = new Container();
          container.addChild(new Text(text, 0, 0));
          for (const entry of details.results) {
            const itemIcon = entry.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
            const displayItems = getDisplayItems(entry.messages);
            const finalOutput = getFinalOutput(entry.messages);
            container.addChild(new Spacer(1));
            container.addChild(new Text(`${theme.fg("muted", `─── Step ${entry.step}: `)}${theme.fg("accent", entry.agent)} ${itemIcon}`, 0, 0));
            container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", entry.task), 0, 0));
            if (entry.warnings.length > 0) container.addChild(new Text(theme.fg("warning", formatWarningsBlock(entry.warnings)), 0, 0));
            for (const item of displayItems) {
              if (item.type === "toolCall") container.addChild(new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0));
            }
            if (finalOutput) {
              container.addChild(new Spacer(1));
              container.addChild(new Markdown(finalOutput.trim(), 0, 0, markdownTheme));
            }
            const usage = formatUsageStats(entry.usage, entry.model);
            if (usage) container.addChild(new Text(theme.fg("dim", usage), 0, 0));
          }
          const totalUsage = formatUsageStats(aggregateUsage(details.results));
          if (totalUsage) {
            container.addChild(new Spacer(1));
            container.addChild(new Text(theme.fg("dim", `Total: ${totalUsage}`), 0, 0));
          }
          return container;
        }

        for (const entry of details.results) {
          const itemIcon = entry.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
          text += `\n\n${theme.fg("muted", `─── Step ${entry.step}: `)}${theme.fg("accent", entry.agent)} ${itemIcon}`;
          if (entry.warnings.length > 0) text += `\n${theme.fg("warning", formatWarningsBlock(entry.warnings))}`;
          const displayItems = getDisplayItems(entry.messages);
          text += `\n${displayItems.length === 0 ? theme.fg("muted", "(no output)") : renderDisplayItems(displayItems, 5)}`;
        }
        const totalUsage = formatUsageStats(aggregateUsage(details.results));
        if (totalUsage) text += `\n\n${theme.fg("dim", `Total: ${totalUsage}`)}`;
        text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
        return new Text(text, 0, 0);
      }

      const running = details.results.filter((entry) => entry.exitCode === -1).length;
      const successCount = details.results.filter((entry) => entry.exitCode === 0).length;
      const failureCount = details.results.filter((entry) => entry.exitCode > 0).length;
      const isRunning = running > 0;
      const icon = isRunning ? theme.fg("warning", "⏳") : failureCount > 0 ? theme.fg("warning", "◐") : theme.fg("success", "✓");
      const status = isRunning ? `${successCount + failureCount}/${details.results.length} done, ${running} running` : `${successCount}/${details.results.length} tasks`;

      if (expanded && !isRunning) {
        const container = new Container();
        container.addChild(new Text(`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`, 0, 0));
        for (const entry of details.results) {
          const itemIcon = entry.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
          const displayItems = getDisplayItems(entry.messages);
          const finalOutput = getFinalOutput(entry.messages);
          container.addChild(new Spacer(1));
          container.addChild(new Text(`${theme.fg("muted", "─── ")}${theme.fg("accent", entry.agent)} ${itemIcon}`, 0, 0));
          container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", entry.task), 0, 0));
          if (entry.warnings.length > 0) container.addChild(new Text(theme.fg("warning", formatWarningsBlock(entry.warnings)), 0, 0));
          for (const item of displayItems) {
            if (item.type === "toolCall") container.addChild(new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0));
          }
          if (finalOutput) {
            container.addChild(new Spacer(1));
            container.addChild(new Markdown(finalOutput.trim(), 0, 0, markdownTheme));
          }
          const usage = formatUsageStats(entry.usage, entry.model);
          if (usage) container.addChild(new Text(theme.fg("dim", usage), 0, 0));
        }
        const totalUsage = formatUsageStats(aggregateUsage(details.results));
        if (totalUsage) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("dim", `Total: ${totalUsage}`), 0, 0));
        }
        return container;
      }

      let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
      for (const entry of details.results) {
        const itemIcon = entry.exitCode === -1 ? theme.fg("warning", "⏳") : entry.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
        const displayItems = getDisplayItems(entry.messages);
        text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", entry.agent)} ${itemIcon}`;
        if (entry.warnings.length > 0) text += `\n${theme.fg("warning", formatWarningsBlock(entry.warnings))}`;
        text += `\n${displayItems.length === 0 ? theme.fg("muted", entry.exitCode === -1 ? "(running...)" : "(no output)") : renderDisplayItems(displayItems, 5)}`;
      }
      if (!isRunning) {
        const totalUsage = formatUsageStats(aggregateUsage(details.results));
        if (totalUsage) text += `\n\n${theme.fg("dim", `Total: ${totalUsage}`)}`;
      }
      if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
      return new Text(text, 0, 0);
    },
  });
}



