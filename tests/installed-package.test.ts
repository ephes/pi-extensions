import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";
import { DefaultResourceLoader, SettingsManager, type ExtensionContext } from "@mariozechner/pi-coding-agent";

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
  } as unknown as ExtensionContext);
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
