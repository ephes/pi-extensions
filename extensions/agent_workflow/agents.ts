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
const MAX_DEFINITION_BYTES = 256 * 1024;
const MAX_DISCOVERY_ENTRIES = 256;
const MAX_DISCOVERY_BYTES = 4 * 1024 * 1024;
class DiscoveryLimitError extends Error {}

function sameGeneration(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function closeDiscoveryHandle(close: () => void, limitExceeded: boolean): void {
  try {
    close();
  } catch (error) {
    // The shared limit must reach the inventory-level refusal.
    if (!limitExceeded) throw error;
  }
}

function readDefinition(filePath: string, remainingBytes: number, charge: (bytes: number) => void): string {
  // Follow intentional links, but never block opening a FIFO swapped into place.
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  let limitExceeded = false;
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.size > MAX_DEFINITION_BYTES) throw new Error("Invalid definition file.");
    // One extra byte detects growth or exhaustion of the shared read budget.
    const bytes = Buffer.alloc(Math.min(Number(stat.size), remainingBytes) + 1);
    let used = 0;
    while (used < bytes.length) {
      const read = fs.readSync(fd, bytes, used, bytes.length - used, null);
      if (read === 0) {
        const after = fs.fstatSync(fd, { bigint: true });
        // stat follows intentional links, just like open; a stable linked target is valid.
        const named = fs.statSync(filePath, { bigint: true });
        if (BigInt(used) !== stat.size || !sameGeneration(stat, after) || !sameGeneration(after, named)) {
          throw new Error("Definition changed while reading.");
        }
        return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, used));
      }
      charge(read);
      used += read;
    }
    throw new Error("Definition grew while reading.");
  } catch (error) {
    limitExceeded = error instanceof DiscoveryLimitError;
    throw error;
  } finally {
    closeDiscoveryHandle(() => fs.closeSync(fd), limitExceeded);
  }
}

export function discoverBundledAgents(): AgentDiscoveryResult {
  const agents: AgentConfig[] = [];
  const diagnostics: string[] = [];

  if (!fs.existsSync(AGENTS_DIR)) {
    return { agents, agentsDir: AGENTS_DIR, diagnostics };
  }

  let definitionBytes = 0;
  try {
    const directory = fs.opendirSync(AGENTS_DIR);
    let limitExceeded = false;
    try {
      let entries = 0;
      let entry: fs.Dirent | null;
      while ((entry = directory.readSync()) !== null) {
        if (++entries > MAX_DISCOVERY_ENTRIES) throw new DiscoveryLimitError();
        if (!entry.name.endsWith(".md")) continue;
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;

        const filePath = path.join(AGENTS_DIR, entry.name);
        try {
          const content = readDefinition(filePath, MAX_DISCOVERY_BYTES - definitionBytes, (bytes) => {
            definitionBytes += bytes;
            if (definitionBytes > MAX_DISCOVERY_BYTES) throw new DiscoveryLimitError();
          });
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
        } catch (error) {
          if (error instanceof DiscoveryLimitError) throw error;
          // Do not expose parser errors, file paths, or definition contents.
          diagnostics.push(`Invalid bundled agent definition: ${entry.name}`);
        }
      }
    } catch (error) {
      limitExceeded = error instanceof DiscoveryLimitError;
      throw error;
    } finally {
      closeDiscoveryHandle(() => directory.closeSync(), limitExceeded);
    }
  } catch (error) {
    // Never publish an arbitrary partial allowlist or a partial set of warnings.
    return { agents: [], agentsDir: AGENTS_DIR, diagnostics: [error instanceof DiscoveryLimitError
      ? "Bundled agent discovery refused: limit exceeded (256 entries; 4 MiB total definition bytes)."
      : "Bundled agent discovery failed: unable to read definitions directory."] };
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
