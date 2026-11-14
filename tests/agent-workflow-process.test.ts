import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import extension from "../extensions/agent_workflow/index.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

test("registered tool retires a real redirected descendant after a successful answer", { skip: process.platform === "win32" }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-process-"));
  const sentinel = path.join(dir, "late-write");
  const pidFile = path.join(dir, "pid");
  const kill = process.kill.bind(process);
  const denials: string[] = [];
  t.mock.method(process, "kill", (...args: Parameters<typeof process.kill>) => {
    try { return kill(...args); }
    catch (error) {
      if ((error as { code?: string }).code === "EPERM") denials.push(String(args[1]));
      throw error;
    }
  });
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${oldPath}`;
  t.after(() => {
    process.env.PATH = oldPath;
    if (fs.existsSync(pidFile)) {
      try { process.kill(-Number(fs.readFileSync(pidFile, "utf8")), "SIGKILL"); } catch { /* Already retired. */ }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const descendant = `require('node:fs').writeFileSync(${JSON.stringify(path.join(dir, "ready"))}, 'ready'); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'late'), 1500); setInterval(() => {}, 1000);`;
  fs.writeFileSync(path.join(dir, "pi"), `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' }).unref();
const timer = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(path.join(dir, "ready"))})) return;
  clearInterval(timer);
  console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'complete' }], stopReason: 'stop' } }));
}, 10);
`, { mode: 0o700 });
  let tool: { execute: (...args: unknown[]) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> };
  extension({ registerTool(value: typeof tool) { tool = value; } } as unknown as ExtensionAPI);
  const result = await tool!.execute("real", { agent: "implementer", task: "synthetic" }, undefined, undefined, {
    cwd: dir, modelRegistry: { getAvailable: () => [{ provider: "openai", id: "gpt-5.4" }] },
  });
  await new Promise(resolve => setTimeout(resolve, 1700));
  assert.equal(fs.existsSync(sentinel), false, "descendant must not write after tool settlement");
  if (denials.length) {
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /cleanup could not be confirmed/);
    t.skip(`Sandbox denies owned process-group signals/probes: ${denials.join(", ")}`);
    return;
  }
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.match(result.content[0].text, /complete/);
});
