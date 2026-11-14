import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import extension from "../extensions/agent_workflow/index.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Whether this environment refuses signals to a live, owned process group (a sandbox). */
async function ownedGroupSignalsDenied(): Promise<boolean> {
  const probe = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { detached: true, stdio: "ignore" });
  probe.unref(); // Exits on its own after five seconds even if a sandbox denies the kill.
  await new Promise(resolve => setTimeout(resolve, 200));
  try {
    process.kill(-probe.pid!, 0);
    return false;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  } finally {
    try { process.kill(probe.pid!, "SIGKILL"); } catch { /* Already gone. */ }
  }
}

test("registered tool retires a real redirected descendant after a successful answer", { skip: process.platform === "win32" }, async (t) => {
  if (await ownedGroupSignalsDenied()) {
    // The tool cannot retire the descendant here; nothing below is meaningful.
    t.skip("Sandbox denies signals to a live owned process group");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-process-"));
  const sentinel = path.join(dir, "late-write");
  const pidFile = path.join(dir, "pid");
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
  // macOS may answer EPERM transiently while only zombies of the group remain;
  // that must not fail a successful run.
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.match(result.content[0].text, /complete/);
});
