import test from "node:test";
import assert from "node:assert/strict";
import { discoverBundledAgents } from "../extensions/agent_workflow/agents.js";

test("discoverBundledAgents finds bundled implementer and reviewer definitions", () => {
  const discovery = discoverBundledAgents();

  assert.match(discovery.agentsDir, /agents$/);
  assert.ok(discovery.agents.length >= 2, "expected bundled agents to be discovered");

  const implementer = discovery.agents.find((agent) => agent.name === "implementer");
  assert.ok(implementer, "implementer agent should exist");
  assert.equal(implementer?.model, "openai/gpt-5.4");
  assert.deepEqual(implementer?.tools, ["read", "bash", "edit", "write"]);
  assert.match(implementer?.systemPrompt ?? "", /Run `just check` before finishing/);

  const reviewer = discovery.agents.find((agent) => agent.name === "reviewer");
  assert.ok(reviewer, "reviewer agent should exist");
  assert.equal(reviewer?.model, "anthropic/claude-opus-4-6");
  assert.deepEqual(reviewer?.tools, ["read", "grep", "find", "ls", "bash"]);
  assert.match(reviewer?.systemPrompt ?? "", /read-only/);
});
