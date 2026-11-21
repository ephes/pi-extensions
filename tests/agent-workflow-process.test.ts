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
    cwd: dir, modelRegistry: { getAvailable: () => [{ provider: "openai", id: "gpt-5.4" }, { provider: "openai-codex", id: "gpt-6.2-sol" }] },
  });
  await new Promise(resolve => setTimeout(resolve, 1700));
  assert.equal(fs.existsSync(sentinel), false, "descendant must not write after tool settlement");
  // macOS may answer EPERM transiently while only zombies of the group remain;
  // that must not fail a successful run.
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.match(result.content[0].text, /complete/);
});

async function waitForFile(file: string): Promise<void> {
  const deadline = performance.now() + 10000;
  while (!fs.existsSync(file)) {
    assert.ok(performance.now() < deadline, `timed out waiting for ${path.basename(file)}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

for (const abort of [false, true]) {
  test(`real chain retires each group before literal bounded handoff and cleans prompts on ${abort ? "abort" : "success"}`,
    { skip: process.platform === "win32", timeout: 20000 }, async (t) => {
    if (await ownedGroupSignalsDenied()) {
      t.skip("Sandbox denies signals to a live owned process group");
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-chain-process-"));
    const file = (name: string) => path.join(dir, name);
    const answer = "{$&, $`, $', {previous}}" + "x".repeat(20000);
    const controller = new AbortController();
    const oldPath = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${oldPath}`;
    type Record = { pid: number; taskPath: string; systemPath: string; task: string; previousRetired: boolean; previousPromptRemoved: boolean; args: string[] };
    const record = (step: number): Record => JSON.parse(fs.readFileSync(file(`step-${step}.json`), "utf8"));
    let run: Promise<unknown> | undefined;
    t.after(async () => {
      controller.abort();
      await run?.catch(() => {});
      process.env.PATH = oldPath;
      for (const step of [1, 2]) {
        if (!fs.existsSync(file(`step-${step}.json`))) continue;
        const entry = record(step);
        try { process.kill(-entry.pid, "SIGKILL"); } catch { /* Already retired. */ }
        if (fs.existsSync(file(`ready-${step}`))) {
          try { process.kill(Number(fs.readFileSync(file(`ready-${step}`), "utf8")), "SIGKILL"); } catch { /* Already retired. */ }
        }
        fs.rmSync(path.dirname(entry.taskPath), { recursive: true, force: true });
      }
      fs.rmSync(dir, { recursive: true, force: true });
    });
    // The descendant remains in the inherited group, redirects its pipes, and
    // acknowledges SIGTERM. A post-settlement IPC probe would cause a late write
    // if the group survived. Watchdogs also bound a failing test's processes.
    const descendant = `
const fs = require('node:fs'), path = require('node:path');
const dir = process.argv[1], step = process.argv[2];
const file = name => path.join(dir, name + '-' + step);
process.on('SIGTERM', () => { fs.writeFileSync(file('retired'), 'retired'); process.exit(0); });
fs.writeFileSync(file('ready'), String(process.pid));
const poll = setInterval(() => {
  if (!fs.existsSync(path.join(dir, 'late-probe'))) return;
  clearInterval(poll);
  setTimeout(() => fs.writeFileSync(file('late-write'), 'late'), 25);
}, 10);
setTimeout(() => process.exit(0), 15000);
`;
    fs.writeFileSync(file("pi"), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const dir = ${JSON.stringify(dir)};
const file = name => path.join(dir, name);
const step = fs.existsSync(file('step-1.json')) ? 2 : 1;
const args = process.argv.slice(2);
const taskPath = args.at(-1).slice(1), systemPath = args[args.indexOf('--append-system-prompt') + 1];
const previous = step === 2 ? JSON.parse(fs.readFileSync(file('step-1.json'), 'utf8')) : undefined;
fs.writeFileSync(file('step-' + step + '.json'), JSON.stringify({
  pid: process.pid, taskPath, systemPath, task: fs.readFileSync(taskPath, 'utf8'), args,
  previousRetired: step === 1 || fs.existsSync(file('retired-1')),
  previousPromptRemoved: step === 1 || !fs.existsSync(path.dirname(previous.taskPath)),
}));
require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}, dir, String(step)], { stdio: 'ignore' }).unref();
const timer = setInterval(() => {
  if (!fs.existsSync(file('ready-' + step)) || !fs.existsSync(file('release-' + step))) return;
  clearInterval(timer);
  const text = step === 1 ? ${JSON.stringify(answer)} : 'chain complete';
  process.stdout.write(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' } }) + '\\n', () => process.exit(0));
}, 10);
setTimeout(() => process.exit(2), 15000);
`, { mode: 0o700 });
    let tool!: { execute: (...args: unknown[]) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> };
    extension({ registerTool(value: typeof tool) { tool = value; } } as unknown as ExtensionAPI);
    const pending = tool.execute("chain-process", { chain: [
      { agent: "implementer", task: "synthetic first" },
      { agent: "reviewer", task: "before\n{previous}\nbetween\n{previous}\nafter" },
    ] }, controller.signal, undefined, {
      cwd: dir, modelRegistry: { getAvailable: () => [{ provider: "openai", id: "gpt-5.4" }, { provider: "openai-codex", id: "gpt-6.2-sol" }] },
    });
    run = pending;
    // Observe failures immediately even while waiting on the IPC barrier.
    void pending.catch(() => {});
    await waitForFile(file("ready-1"));
    assert.equal(fs.existsSync(file("step-2.json")), false);
    assert.ok(fs.existsSync(record(1).taskPath));
    fs.writeFileSync(file("release-1"), "go");
    await waitForFile(file("ready-2"));
    const second = record(2);
    assert.equal(second.args[second.args.indexOf("--model") + 1], "openai-codex/gpt-6.2-sol");
    assert.equal(second.previousRetired, true, "next process must observe retirement of the previous descendant");
    assert.equal(second.previousPromptRemoved, true, "next process starts after previous prompt cleanup");
    const notice = `[Previous agent workflow output truncated from ${answer.length} to 6000 characters.]\n\n`;
    const handoff = notice + answer.slice(0, 6000 - notice.length);
    assert.equal(second.task, `Task: before\n${handoff}\nbetween\n${handoff}\nafter`);
    assert.equal(handoff.length * 2, 12000);
    for (const step of [1, 2]) {
      const entry = record(step);
      assert.ok(entry.args.includes("--no-extensions"));
      assert.ok(entry.args.includes("--no-prompt-templates"));
      assert.ok(entry.args.includes("--no-skills"));
      assert.ok(!entry.args.some(arg => arg.includes("synthetic first") || arg.includes("before\n")));
    }
    if (abort) {
      controller.abort();
      await assert.rejects(pending, /aborted/);
    } else {
      fs.writeFileSync(file("release-2"), "go");
      const result = await pending;
      assert.equal(result.isError, undefined, JSON.stringify(result));
      assert.match(result.content[0].text, /chain complete$/);
    }
    fs.writeFileSync(file("late-probe"), "go");
    await new Promise(resolve => setTimeout(resolve, 100));
    for (const step of [1, 2]) {
      assert.equal(fs.existsSync(file(`retired-${step}`)), true);
      assert.equal(fs.existsSync(file(`late-write-${step}`)), false);
      const entry = record(step);
      assert.equal(fs.existsSync(entry.taskPath), false);
      assert.equal(fs.existsSync(entry.systemPath), false);
      assert.equal(fs.existsSync(path.dirname(entry.taskPath)), false);
      for (const pid of [entry.pid, Number(fs.readFileSync(file(`ready-${step}`), "utf8"))]) {
        assert.throws(() => process.kill(pid, 0), "both direct children and descendants must be gone");
      }
    }
  });
}

test("real synthetic pi protocol flood is refused and its prompt is removed after retirement", { skip: process.platform === "win32", timeout: 20000 }, async (t) => {
  if (await ownedGroupSignalsDenied()) {
    t.skip("Sandbox denies signals to a live owned process group");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-flood-process-"));
  const recordPath = path.join(dir, "record.json");
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${oldPath}`;
  const controller = new AbortController();
  let run: Promise<unknown> | undefined;
  t.after(async () => {
    controller.abort();
    await run?.catch(() => {});
    process.env.PATH = oldPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(dir, "pi"), `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ pid: process.pid, task: process.argv.at(-1).slice(1) }));
setTimeout(() => process.exit(2), 12000);
console.log(JSON.stringify({type:'message_end', message:{role:'assistant',content:[{type:'text',text:'synthetic answer'}],stopReason:'stop'}}));
let count = 0;
function pump() {
  while (count++ < 65536) if (!process.stdout.write('{"type":"ignored"}\\n')) { process.stdout.once('drain', pump); return; }
}
pump();
`, { mode: 0o700 });
  let tool!: { execute: (...args: unknown[]) => Promise<{ isError?: boolean; details: { results: Array<{ errorMessage?: string }> } }> };
  extension({ registerTool(value: typeof tool) { tool = value; } } as unknown as ExtensionAPI);
  const pending = tool.execute("flood", { agent: "implementer", task: "synthetic" }, controller.signal, undefined, {
    cwd: dir, modelRegistry: { getAvailable: () => [{ provider: "openai", id: "gpt-5.4" }, { provider: "openai-codex", id: "gpt-6.2-sol" }] },
  });
  run = pending;
  const result = await pending;
  assert.equal(result.isError, true);
  assert.match(result.details.results[0].errorMessage!, /total protocol event limit/);
  const record: { pid: number; task: string } = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  assert.equal(fs.existsSync(path.dirname(record.task)), false);
  assert.throws(() => process.kill(record.pid, 0), { code: "ESRCH" });
});
