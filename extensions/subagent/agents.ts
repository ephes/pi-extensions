import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";

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
}

const AGENTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../agents");

export function discoverBundledAgents(): AgentDiscoveryResult {
  const agents: AgentConfig[] = [];

  if (!fs.existsSync(AGENTS_DIR)) {
    return { agents, agentsDir: AGENTS_DIR };
  }

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(AGENTS_DIR, { withFileTypes: true });
  } catch {
    return { agents, agentsDir: AGENTS_DIR };
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(AGENTS_DIR, entry.name);
    let content = "";
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
    if (!frontmatter.name || !frontmatter.description) continue;

    const tools = frontmatter.tools
      ?.split(",")
      .map((tool) => tool.trim())
      .filter(Boolean);

    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: tools && tools.length > 0 ? tools : undefined,
      model: frontmatter.model,
      systemPrompt: body.trim(),
      filePath,
    });
  }

  agents.sort((left, right) => left.name.localeCompare(right.name));
  return { agents, agentsDir: AGENTS_DIR };
}

export function formatAgentList(agents: AgentConfig[]): string {
  if (agents.length === 0) return "none";
  return agents.map((agent) => `${agent.name}: ${agent.description}`).join("; ");
}
