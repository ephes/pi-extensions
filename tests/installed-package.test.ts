import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import net from "node:net";
import tls from "node:tls";
import { DefaultResourceLoader, SettingsManager, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";

const repo = fileURLToPath(new URL("../", import.meta.url));

async function installedSmoke(t: import("node:test").TestContext, damage?: string) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-installed-smoke-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Pack the actual publish allowlist, using the lockfile-installed development peers.
  const packed = JSON.parse(childProcess.execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--offline", "--pack-destination", root], {
    cwd: repo, encoding: "utf8", env: { ...process.env, npm_config_cache: path.join(root, "npm-cache") },
  })) as Array<{ filename: string }>;
  childProcess.execFileSync("tar", ["-xzf", path.join(root, packed[0].filename), "-C", root]);
  const installed = path.join(root, "package");
  fs.symlinkSync(path.join(repo, "node_modules"), path.join(installed, "node_modules"), "dir");
  if (damage) fs.rmSync(path.join(installed, damage));
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(cwd);
  fs.mkdirSync(agentDir);

  const blockedProcesses = (["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const)
    .map((method) => t.mock.method(childProcess, method, () => { throw new Error("unexpected subprocess during package loading"); }));
  const blockedConnections = [
    t.mock.method(net, "connect", () => { throw new Error("unexpected TCP connection during package loading"); }),
    t.mock.method(tls, "connect", () => { throw new Error("unexpected TLS connection during package loading"); }),
  ];
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected network during package loading"); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const loader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager: SettingsManager.inMemory({ packages: [installed] }),
    noSkills: true, noThemes: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, [], "installed extensions must import successfully");
  const tools = loaded.extensions.flatMap((extension) => [...extension.tools.values()]);
  assert.deepEqual(tools.map((tool) => tool.definition.name).sort(), ["agent_workflow", "kagi_search", "web_content"], "installed tool registrations");
  const workflow = tools.find((tool) => tool.definition.name === "agent_workflow")!;
  const result = await workflow.definition.execute("smoke", {}, undefined, undefined, {
    cwd, modelRegistry: { getAvailable: () => [] },
  } as unknown as ExtensionToolContext);
  assert.match(JSON.stringify(result.content), /implementer/, "installed implementer discovery");
  assert.match(JSON.stringify(result.content), /reviewer/, "installed reviewer discovery");
  assert.equal((result.details as { agentsDir: string }).agentsDir, path.join(installed, "agents"));
  assert.deepEqual((result.details as { diagnostics: string[] }).diagnostics, []);
  const prompts = loader.getPrompts();
  assert.deepEqual(prompts.diagnostics, [], "installed prompt diagnostics");
  assert.deepEqual(prompts.prompts.map((prompt) => prompt.name).sort(), ["implement", "implement-and-review", "review"], "installed prompt registrations");
  for (const prompt of prompts.prompts) assert.ok(prompt.content.trim());
  for (const mock of [...blockedProcesses, ...blockedConnections]) assert.equal(mock.mock.callCount(), 0);
  assert.equal(fetch.mock.callCount(), 0);
  return { workflow, installed, cwd };
}

test("installed package loads each tool once and discovers bundled assets offline", async (t) => {
  await installedSmoke(t);
});

for (const damage of ["extensions/kagi_search.ts", "shared/web.ts", "agents/reviewer.md", "prompts/review.md"]) {
  test(`installed smoke detects missing packaged ${damage}`, async (t) => {
    await assert.rejects(installedSmoke(t, damage), (error: unknown) => {
      assert.ok(error instanceof assert.AssertionError);
      const expected: Record<string, RegExp> = {
        "extensions/kagi_search.ts": /installed tool registrations/,
        "shared/web.ts": /installed extensions must import successfully/,
        "agents/reviewer.md": /installed reviewer discovery/,
        "prompts/review.md": /installed prompt registrations/,
      };
      assert.match(error.message, expected[damage]);
      return true;
    });
  });
}


function fakeAgents(t: import("node:test").TestContext, inspect: (args: string[]) => void) {
  // Model the supported process-group platform; never launch or signal a real agent.
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "linux" });
  t.after(() => Object.defineProperty(process, "platform", platform));
  let spawns = 0;
  t.mock.method(childProcess, "spawn", (_command: string, args: string[]) => {
    spawns += 1;
    inspect(args);
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
    queueMicrotask(() => {
      child.stdout.emit("data", JSON.stringify({ type: "message_end", message: {
        role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop",
      } }) + "\n");
      child.emit("close", 0, null);
    });
    return child;
  });
  syncBuiltinESMExports();
  return () => spawns;
}

const fakeContext = (cwd: string) => ({
  cwd, modelRegistry: { getAvailable: () => [{ provider: "openai", id: "gpt-5.4" }] },
}) as unknown as ExtensionToolContext;

test("installed tool policies reject empty and unknown lists without default-capability launches", async (t) => {
  const { workflow, installed, cwd } = await installedSmoke(t);
  const argv: string[][] = [];
  const spawns = fakeAgents(t, (args) => argv.push(args));
  for (const tools of ['""', '"  "', '", ,"', 'read, unknown', '*', '+bash']) {
    fs.writeFileSync(path.join(installed, "agents/policy.md"), `---\nname: policy\ndescription: synthetic\ntools: ${tools}\n---\npolicy`);
    const result = await workflow.definition.execute("policy", { agent: "policy", task: "test" }, undefined, undefined, fakeContext(cwd));
    assert.equal(result.isError, true, `must reject ${tools}`);
    assert.match(JSON.stringify(result), /Invalid bundled agent definition: policy.md/);
  }
  assert.equal(spawns(), 0);
  for (const [agent, tools] of [
    ["reviewer", "read,grep,find,ls,bash"], ["implementer", "read,bash,edit,write"],
  ]) {
    const result = await workflow.definition.execute("valid", { agent, task: "test" }, undefined, undefined, fakeContext(cwd));
    assert.equal(result.isError, undefined);
    const args = argv.at(-1)!;
    assert.equal(args[args.indexOf("--tools") + 1], tools);
  }
  fs.writeFileSync(path.join(installed, "agents/policy.md"), "---\nname: policy\ndescription: synthetic\n---\npolicy");
  await workflow.definition.execute("omitted", { agent: "policy", task: "test" }, undefined, undefined, fakeContext(cwd));
  assert.equal(argv.at(-1)!.includes("--tools"), false, "omitted tools retain host defaults");
});

test("installed large literal task travels in a private file outside argv and is cleaned", async (t) => {
  const { workflow, installed, cwd } = await installedSmoke(t);
  const task = "private-task-sentinel 🦊 $& $` $' {previous}\n".repeat(32000) + "  \n";
  let taskPath = "";
  const spawns = fakeAgents(t, (args) => {
    assert.ok(!args.some((arg) => arg.includes("private-task-sentinel")));
    assert.ok(args.every((arg) => Buffer.byteLength(arg) < 4096));
    assert.ok(args.at(-1)!.startsWith("@"));
    taskPath = args.at(-1)!.slice(1);
    assert.equal(fs.readFileSync(taskPath, "utf8"), `Task: ${task}`);
    assert.equal(fs.statSync(taskPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(taskPath)).mode & 0o777, 0o700);
  });
  // Also cover a definition with no system prompt.
  fs.writeFileSync(path.join(installed, "agents/plain.md"), "---\nname: plain\ndescription: synthetic\ntools: read\n---\n");
  for (const agent of ["implementer", "plain"]) {
    const result = await workflow.definition.execute("large", { agent, task }, undefined, undefined, fakeContext(cwd));
    assert.equal(result.isError, undefined);
    assert.equal(fs.existsSync(path.dirname(taskPath)), false);
  }
  assert.equal(spawns(), 2);
});
