import fs from "node:fs";
import path from "node:path";
import os from "node:os";
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
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-definitions-"));
  for (const [name, content] of Object.entries(definitions)) {
    if (typeof content === "string") fs.writeFileSync(path.join(fixtureDir, name), content);
    else fs.symlinkSync(path.join(fixtureDir, "missing"), path.join(fixtureDir, name));
  }
  const originalReaddir = fs.readdirSync;
  t.mock.method(fs, "readdirSync", (directory: string, options: unknown) => directory === agentsDir
    ? originalReaddir(fixtureDir, options as never)
    : originalReaddir(directory, options as never));
  const originalOpen = fs.openSync;
  t.mock.method(fs, "openSync", (file: string, flags: number) => originalOpen(
    path.dirname(file) === agentsDir ? path.join(fixtureDir, path.basename(file)) : file, flags,
  ));
  // Keep the pre-admission implementation testable for the red regression run.
  const originalRead = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (file: string, options: unknown) => {
    return originalRead(typeof file === "string" && path.dirname(file) === agentsDir
      ? path.join(fixtureDir, path.basename(file)) : file, options as never);
  });
  const warn = t.mock.method(console, "warn", () => undefined);
  syncBuiltinESMExports();
  t.after(() => {
    try { assert.equal(warn.mock.callCount(), 0, "discovery must not write to stderr"); }
    finally { t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(fixtureDir, { recursive: true, force: true }); }
  });
  return { agentsDir, fixtureDir };
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
  assert.deepEqual([...diagnostics].sort(), ["one.md", "two.md", "three.md"].map((name) => `Duplicate bundled agent definition: ${name}`).sort());
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

test("oversize definitions are refused before parsing while regular symlinks remain supported", (t) => {
  const { fixtureDir } = fixtureDiscovery(t, {
    "large.md": definition("name: large\ndescription: too large") + "x".repeat(256 * 1024),
    "valid.md": definition("name: valid\ndescription: healthy"),
  });
  const linked = path.join(fixtureDir, "linked.txt");
  fs.writeFileSync(linked, definition("name: linked\ndescription: supported"));
  fs.symlinkSync(linked, path.join(fixtureDir, "linked.md"));
  const discovery = discoverBundledAgents();
  assert.deepEqual(discovery.agents.map(agent => agent.name), ["linked", "valid"]);
  assert.deepEqual(discovery.diagnostics, ["Invalid bundled agent definition: large.md"]);
});

test("descriptor growth cannot bypass the actual definition byte budget and closes the descriptor", (t) => {
  fixtureDiscovery(t, {
    "growing.md": definition("name: growing\ndescription: starts small") + "x".repeat(256 * 1024),
    "valid.md": definition("name: valid\ndescription: healthy"),
  });
  const stat = fs.fstatSync;
  t.mock.method(fs, "fstatSync", (fd: number) => Object.assign(stat(fd), { size: 1 }));
  const close = t.mock.method(fs, "closeSync", fs.closeSync);
  const read = t.mock.method(fs, "readSync", fs.readSync);
  syncBuiltinESMExports();
  const discovery = discoverBundledAgents();
  assert.deepEqual(discovery.agents.map(agent => agent.name), ["valid"]);
  assert.equal(close.mock.callCount(), 2);
  const totalBytes = read.mock.calls.reduce((sum, call) => sum + Number(call.result), 0);
  assert.ok(totalBytes < 257 * 1024, "reads stop at the budget plus one overflow byte");
});

test("symlink to FIFO is refused without blocking discovery", (t) => {
  const { fixtureDir } = fixtureDiscovery(t, { "valid.md": definition("name: valid\ndescription: healthy") });
  const fifo = path.join(fixtureDir, "pipe");
  const mkfifo = childProcess.spawnSync("mkfifo", [fifo]);
  assert.equal(mkfifo.status, 0);
  fs.symlinkSync(fifo, path.join(fixtureDir, "pipe.md"));
  // Isolate the potentially blocking old reader in a disposable process.
  const moduleUrl = new URL("../extensions/agent_workflow/agents.ts", import.meta.url).href;
  const script = `import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { discoverBundledAgents } from ${JSON.stringify(moduleUrl)};
    const root = discoverBundledAgents().agentsDir;
    const fixture = ${JSON.stringify(fixtureDir)};
    const readdir = fs.readdirSync, open = fs.openSync, read = fs.readFileSync;
    fs.readdirSync = (dir, opts) => readdir(dir === root ? fixture : dir, opts);
    const mapped = file => typeof file === 'string' && file.startsWith(root + '/') ? fixture + file.slice(root.length) : file;
    fs.openSync = (file, ...args) => open(mapped(file), ...args);
    fs.readFileSync = (file, ...args) => read(mapped(file), ...args);
    syncBuiltinESMExports();
    console.log(JSON.stringify(discoverBundledAgents()));`;
  const probe = childProcess.spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { timeout: 10000, killSignal: "SIGKILL", encoding: "utf8" });
  assert.equal(probe.error, undefined, "discovery must not wait for a FIFO writer");
  assert.equal(probe.status, 0, probe.stderr);
  const discovery = JSON.parse(probe.stdout);
  assert.deepEqual(discovery.agents.map((agent: { name: string }) => agent.name), ["valid"]);
  assert.deepEqual(discovery.diagnostics, ["Invalid bundled agent definition: pipe.md"]);
});
