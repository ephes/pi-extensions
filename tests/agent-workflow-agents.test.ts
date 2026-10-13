import fs from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import agentWorkflowExtension from "../extensions/agent_workflow/index.js";
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

function fixtureDiscovery(t: import("node:test").TestContext, definitions: Record<string, string | Error>) {
  const agentsDir = discoverBundledAgents().agentsDir;
  const originalRead = fs.readFileSync;
  const originalReaddir = fs.readdirSync;
  t.mock.method(fs, "readdirSync", (directory: string, options: unknown) => directory === agentsDir
    ? Object.keys(definitions).map((name) => ({ name, isFile: () => true, isSymbolicLink: () => false }))
    : originalReaddir(directory, options as never));
  t.mock.method(fs, "readFileSync", (file: string, options: unknown) => {
    if (path.dirname(file) !== agentsDir) return originalRead(file, options as never);
    const value = definitions[path.basename(file)];
    if (value instanceof Error) throw value;
    return value;
  });
  const warn = t.mock.method(console, "warn", () => undefined);
  syncBuiltinESMExports();
  t.after(() => {
    try { assert.equal(warn.mock.callCount(), 0, "discovery must not write to stderr"); }
    finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  });
  return { agentsDir };
}

function definition(fields: string) {
  return `---\n${fields}\n---\nPrivate prompt content`;
}

for (const fields of [
  "name: [unterminated",
  "name: 123\ndescription: valid",
  "name: invalid\ndescription: false",
  "name: invalid\ndescription: valid\ntools: [read, bash]",
  "name: invalid\ndescription: valid\ntools: true",
  "name: invalid\ndescription: valid\nmodel: 123",
  "name: '  '\ndescription: valid",
  "name: invalid\ndescription: '  '",
]) {
  test(`invalid definition is isolated: ${fields.replaceAll("\n", "; ")}`, (t) => {
    const { agentsDir } = fixtureDiscovery(t, {
      "bad.md": definition(fields),
      "valid.md": definition("name: valid\ndescription: healthy\ntools: read, bash\nmodel: openai/example"),
    });
    const { agents, diagnostics } = discoverBundledAgents();
    assert.deepEqual(agents.map((agent) => agent.name), ["valid"]);
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0], /bad\.md/);
    assert.ok(!diagnostics[0].includes(agentsDir));
    assert.ok(!diagnostics[0].includes("Private prompt"));
    assert.ok(!diagnostics[0].includes(fields));
  });
}

test("all duplicate names are excluded and cannot be invoked", async (t) => {
  const { agentsDir } = fixtureDiscovery(t, {
    "one.md": definition("name: duplicate\ndescription: first"),
    "two.md": definition("name: duplicate\ndescription: second"),
    "three.md": definition("name: duplicate\ndescription: third"),
    "valid.md": definition("name: valid\ndescription: healthy"),
  });
  const { agents, diagnostics } = discoverBundledAgents();
  assert.deepEqual(agents.map((agent) => agent.name), ["valid"]);
  assert.deepEqual(diagnostics, ["one.md", "two.md", "three.md"].map((name) => `Duplicate bundled agent definition: ${name}`));
  assert.ok(diagnostics.every((message) => !message.includes(agentsDir) && !message.includes("Private prompt")));
  let tool: {
    execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }>;
    renderResult: (...args: unknown[]) => { render: (width: number) => string[] };
  };
  agentWorkflowExtension({ registerTool(value: typeof tool) { tool = value; } } as never);
  let spawns = 0;
  t.mock.method(childProcess, "spawn", () => { spawns += 1; throw new Error("must not spawn"); });
  syncBuiltinESMExports();
  const result = await tool!.execute("test", { agent: "duplicate", task: "test" }, undefined, undefined, {
    cwd: process.cwd(), modelRegistry: { getAvailable: () => [] },
  });
  assert.match(JSON.stringify(result), /Unknown agent/);
  assert.equal(spawns, 0);
  for (const diagnostic of diagnostics) assert.ok(result.content[0].text.includes(diagnostic));
  for (const expanded of [false, true]) {
    const rendered = tool!.renderResult(result, { expanded }, {
      fg: (_color: string, text: string) => text, bold: (text: string) => text,
    }).render(120).join("\n");
    for (const diagnostic of diagnostics) assert.ok(rendered.includes(diagnostic));
  }
});

test("read errors are isolated and diagnostics omit error contents and full paths", (t) => {
  const { agentsDir } = fixtureDiscovery(t, {
    "unreadable.md": new Error("EACCES /private/secret/definition.md Private prompt content"),
    "valid.md": definition("name: valid\ndescription: healthy"),
  });
  const { agents, diagnostics } = discoverBundledAgents();
  assert.deepEqual(agents.map((agent) => agent.name), ["valid"]);
  assert.deepEqual(diagnostics, ["Invalid bundled agent definition: unreadable.md"]);
  assert.ok(!diagnostics[0].includes(agentsDir));
});
