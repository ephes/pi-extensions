import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  filePath: string;
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  agentsDir: string;
  diagnostics: string[];
}

// Delegates disable extensions; accept only explicit built-in tool names.
const TOOL_NAMES = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);

const AGENTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../agents");

export function discoverBundledAgents(): AgentDiscoveryResult {
  const agents: AgentConfig[] = [];
  const diagnostics: string[] = [];

  if (!fs.existsSync(AGENTS_DIR)) {
    return { agents, agentsDir: AGENTS_DIR, diagnostics };
  }

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(AGENTS_DIR, { withFileTypes: true });
  } catch {
    return { agents, agentsDir: AGENTS_DIR, diagnostics };
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(AGENTS_DIR, entry.name);
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
      if (
        typeof frontmatter.name !== "string" || !frontmatter.name.trim() ||
        typeof frontmatter.description !== "string" || !frontmatter.description.trim() ||
        (frontmatter.tools !== undefined && typeof frontmatter.tools !== "string") ||
        (frontmatter.model !== undefined && typeof frontmatter.model !== "string")
      ) {
        diagnostics.push(`Invalid bundled agent definition: ${entry.name}`);
        continue;
      }

      const tools = (frontmatter.tools as string | undefined)
        ?.split(",")
        .map((tool) => tool.trim())
        .filter(Boolean);

      if (tools && (tools.length === 0 || tools.some((tool) => !TOOL_NAMES.has(tool)))) {
        diagnostics.push(`Invalid bundled agent definition: ${entry.name}`);
        continue;
      }

      agents.push({
        name: frontmatter.name,
        description: frontmatter.description,
        tools,
        model: frontmatter.model as string | undefined,
        systemPrompt: body.trim(),
        filePath,
      });
    } catch {
      // Do not expose parser errors, file paths, or definition contents.
      diagnostics.push(`Invalid bundled agent definition: ${entry.name}`);
    }
  }

  const counts = new Map<string, number>();
  for (const agent of agents) counts.set(agent.name, (counts.get(agent.name) ?? 0) + 1);
  const uniqueAgents = agents.filter((agent) => {
    if (counts.get(agent.name) === 1) return true;
    diagnostics.push(`Duplicate bundled agent definition: ${path.basename(agent.filePath)}`);
    return false;
  });

  uniqueAgents.sort((left, right) => left.name.localeCompare(right.name));
  return { agents: uniqueAgents, agentsDir: AGENTS_DIR, diagnostics };
}

export function formatAgentList(agents: AgentConfig[]): string {
  if (agents.length === 0) return "none";
  return agents.map((agent) => `${agent.name}: ${agent.description}`).join("; ");
}
