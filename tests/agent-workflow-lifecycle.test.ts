import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import extension from "../extensions/agent_workflow/index.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function setup(t: TestContext) {
  // Model POSIX groups on every host; no test sends real OS signals.
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "linux" });
  t.after(() => Object.defineProperty(process, "platform", platform));
  const spawnOptions: childProcess.SpawnOptions[] = [];
  const spawnArgs: string[][] = [];
  const tasks: string[] = [];
  const children: Array<EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid: number; groupAlive: boolean; retainGroup: boolean; killed: boolean; signals: string[]; kill: (signal: string) => boolean }> = [];
  t.mock.method(childProcess, "spawn", (_command: string, args: string[], options: childProcess.SpawnOptions) => {
    spawnOptions.push(options);
    spawnArgs.push(args);
    tasks.push(fs.readFileSync(args.at(-1)!.slice(1), "utf8"));
    const child = Object.assign(new EventEmitter(), {
      pid: 10000 + children.length, groupAlive: true, retainGroup: false,
      stdout: new EventEmitter(), stderr: new EventEmitter(), killed: false, signals: [] as string[],
      kill(signal: string) { this.killed = true; this.signals.push(signal); return true; },
    });
    child.prependListener("close", () => { if (!child.retainGroup) child.groupAlive = false; });
    children.push(child);
    return child;
  });
  t.mock.method(process, "kill", (pid: number, signal: Parameters<typeof process.kill>[1] = "SIGTERM") => {
    const child = children.find((item) => item.pid === -pid);
    assert.ok(child, `must signal only an owned group: ${pid}`);
    if (!child.groupAlive) throw Object.assign(new Error("group gone"), { code: "ESRCH" });
    if (signal !== 0) child.signals.push(String(signal));
    if (signal === "SIGKILL") child.groupAlive = false;
    return true;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  type StubResult = { isError?: boolean; content: Array<{ type: string; text?: string }>; details: { results: Array<{ messages: unknown[]; stderr: string; warnings: string[]; stopReason?: string; errorMessage?: string; exitCode: number; agent: string; task: string; usage: { turns: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; contextTokens: number } }> } };
  type StubComponent = { render: (width: number) => string[] };
  type StubTool = {
    execute: (id: string, params: unknown, signal: AbortSignal | undefined, update: ((result: StubResult) => void) | undefined, ctx: unknown) => Promise<StubResult>;
    renderResult: (result: StubResult, options: { expanded: boolean; isPartial: boolean }, theme: unknown) => StubComponent;
  };
  let tool: StubTool;
  extension({ registerTool(definition: StubTool) { tool = definition; } } as unknown as ExtensionAPI);
  const execute = (signal?: AbortSignal, chain = false, task = "{previous}", parallel = false, update?: (result: StubResult) => void) => tool.execute("test", chain
    ? { chain: [{ agent: "implementer", task: "first" }, { agent: "reviewer", task }] }
    : parallel ? { tasks: Array.from({ length: 8 }, (_, i) => ({ agent: "implementer", task: `task-${i}` })) }
    : { agent: "implementer", task: "test" }, signal, update, {
      cwd: process.cwd(), modelRegistry: { getAvailable: () => [{ provider: "openai", id: "gpt-5.4" }] },
    } as never);
  const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const render = (result: StubResult, expanded: boolean) =>
    tool.renderResult(result, { expanded, isPartial: false }, plainTheme).render(200).map((line) => line.trimEnd()).join("\n");
  const executeChain = (chain: Array<{ agent: string; task: string }>, update?: (result: StubResult) => void) => tool.execute("test", { chain }, undefined, update, {
    cwd: process.cwd(), modelRegistry: { getAvailable: () => [{ provider: "openai", id: "gpt-5.4" }] },
  });
  return { children, execute, executeChain, render, tasks, spawnOptions, spawnArgs };
}

test("abort escalates an unclosed child despite killed=true and waits for close", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { children, execute } = setup(t);
  const controller = new AbortController();
  const run = execute(controller.signal);
  const rejected = assert.rejects(run, /aborted/);
  let settled = false;
  void run.then(() => { settled = true; }, () => { settled = true; });
  controller.abort();
  assert.deepEqual(children[0].signals, ["SIGTERM"]);
  t.mock.timers.tick(4999);
  assert.deepEqual(children[0].signals, ["SIGTERM"]);
  t.mock.timers.tick(1);
  assert.deepEqual(children[0].signals, ["SIGTERM", "SIGKILL"]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  children[0].emit("close", null, "SIGKILL");
  await rejected;
});

test("close clears escalation and detaches abort listener", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { children, execute } = setup(t);
  const controller = new AbortController();
  const run = execute(controller.signal);
  children[0].emit("close", 0, null);
  await run;
  controller.abort();
  t.mock.timers.tick(5000);
  assert.deepEqual(children[0].signals, []);

  const second = new AbortController();
  const aborted = assert.rejects(execute(second.signal), /aborted/);
  second.abort();
  children[1].emit("close", null, "SIGTERM");
  await aborted;
  t.mock.timers.tick(5000);
  assert.deepEqual(children[1].signals, ["SIGTERM"]);
});

for (const [code, signal, failed] of [[null, "SIGKILL", true], [0, null, false], [2, null, true], [null, null, true]] as const) {
  test(`child close(${code}, ${signal}) fails closed and controls chain handoff`, async (t) => {
    const { children, execute } = setup(t);
    const run = execute(undefined, true);
    children[0].stdout.emit("data", JSON.stringify({ type: "message_end", message: {
      role: "assistant", content: [{ type: "text", text: "partial output" }], stopReason: "stop",
    } }) + "\n");
    children[0].emit("close", code, signal);
    await Promise.resolve();
    if (!failed) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      children[1].stdout.emit("data", messageLine("final answer"));
      children[1].emit("close", 0, null);
    }
    const result = await run;
    assert.equal(Boolean(result.isError), failed);
    assert.equal(children.length, failed ? 1 : 2);
    if (signal) assert.match(JSON.stringify(result), /SIGKILL/);
  });
}

test("spawn error settles failure and removes abort listener", async (t) => {
  const { children, execute } = setup(t);
  const controller = new AbortController();
  const run = execute(controller.signal);
  Object.assign(children[0], { pid: undefined });
  children[0].emit("error", new Error("spawn unavailable"));
  const result = await run;
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /spawn unavailable/);
  controller.abort();
  assert.deepEqual(children[0].signals, []);
});

test("running child error waits for close before settlement", async (t) => {
  const { children, execute } = setup(t);
  const run = execute();
  let settled = false;
  void run.then(() => { settled = true; });
  children[0].emit("error", new Error("kill unavailable"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  children[0].emit("close", 1, null);
  const result = await run;
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /kill unavailable/);
});

function messageLine(text: string) {
  return Buffer.from(JSON.stringify({ type: "message_end", message: {
    role: "assistant", content: [{ type: "text", text }], stopReason: "stop",
  } }) + "\n");
}

test("UTF-8 protocol survives every byte split and EOF without newline", async (t) => {
  const { children, execute } = setup(t);
  const text = "Grüße aus Köln 🦊";
  const bytes = messageLine(text);
  for (let split = 1; split < bytes.length; split++) {
    const run = execute();
    const child = children.at(-1)!;
    child.stdout.emit("data", bytes.subarray(0, split));
    child.stdout.emit("data", bytes.subarray(split));
    child.emit("close", 0, null);
    const result = await run;
    assert.equal(result.isError, undefined);
    assert.match(JSON.stringify(result.details.results[0].messages), /Grüße aus Köln 🦊/);
  }
  const run = execute();
  children.at(-1)!.stdout.emit("data", bytes.subarray(0, -1));
  children.at(-1)!.emit("close", 0, null);
  assert.match(JSON.stringify(await run), /Grüße aus Köln 🦊/);
});

for (const bytes of [Buffer.from([0xff]), Buffer.from([0xf0, 0x9f])]) {
  test(`invalid or incomplete UTF-8 fails closed: ${bytes.toString("hex")}`, async (t) => {
    const { children, execute } = setup(t);
    const run = execute();
    children[0].stdout.emit("data", bytes);
    children[0].emit("close", 0, null);
    assert.equal((await run).isError, true);
  });
}

for (const [fileNumber, partial] of [[1, false], [1, true], [2, false], [2, true]] as const) {
  test(`agent input file write failure cleans owned directory (file=${fileNumber}, partial=${partial})`, async (t) => {
    const { children, execute } = setup(t);
    const originalWrite = fs.writeFileSync;
    const originalMkdir = fs.mkdtempSync;
    let directory = "";
    let fault = false;
    let writes = 0;
    t.mock.method(fs, "mkdtempSync", (...args: Parameters<typeof fs.mkdtempSync>) => {
      directory = originalMkdir(...args) as string;
      return directory;
    });
    t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
      if (++writes !== fileNumber) return originalWrite(...args);
      fault = true;
      if (partial) originalWrite(args[0], "partial private prompt", args[2]);
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(execute(), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "Unable to create agent input files.");
        assert.ok(error.cause instanceof Error);
        assert.equal((error.cause as Error & { code?: string }).code, "ENOSPC");
        return true;
      });
      assert.equal(fault, true);
      assert.equal(fs.existsSync(directory), false);
      assert.equal(children.length, 0);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("protocol overflow escalates, waits for reaping and cleans prompt", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { children, execute } = setup(t);
  const originalMkdir = fs.mkdtempSync;
  let directory = "";
  t.mock.method(fs, "mkdtempSync", (...args: Parameters<typeof fs.mkdtempSync>) => {
    directory = originalMkdir(...args) as string;
    return directory;
  });
  syncBuiltinESMExports();
  const run = execute();
  let settled = false;
  void run.then(() => { settled = true; });
  children[0].stdout.emit("data", Buffer.alloc(1024 * 1024 + 1, 65));
  assert.deepEqual(children[0].signals, ["SIGTERM"]);
  t.mock.timers.tick(5000);
  assert.deepEqual(children[0].signals, ["SIGTERM", "SIGKILL"]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(fs.existsSync(directory), true);
  children[0].emit("close", 0, null);
  const result = await run;
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /exceeds 1 MiB/);
  assert.equal(fs.existsSync(directory), false);
});

test("stderr tail and message detail retention have separate byte and count budgets", async (t) => {
  const { children, execute } = setup(t);
  const run = execute();
  const child = children[0];
  for (let i = 0; i < 300; i++) {
    child.stderr.emit("data", Buffer.alloc(10000, 65));
    child.stdout.emit("data", JSON.stringify({ type: "message_end", message: { role: "assistant",
      content: [{ type: "text", text: `message-${i}` }], stopReason: "stop",
      usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, totalTokens: 14,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 } } } }) + "\n");
  }
  child.stderr.emit("data", Buffer.from("diagnostic tail"));
  child.emit("close", 0, null);
  const result = (await run).details.results[0];
  assert.equal(result.messages.length, 256);
  assert.deepEqual(result.usage, { turns: 300, input: 600, output: 900, cacheRead: 1200, cacheWrite: 1500, cost: 300, contextTokens: 14 });
  assert.ok(Buffer.byteLength(result.stderr) <= 64 * 1024);
  assert.ok(result.stderr.endsWith("diagnostic tail"));
  assert.equal(result.warnings.length, 2);

  const largeRun = execute();
  for (let i = 0; i < 10; i++) children[1].stdout.emit("data", messageLine(`${i}` + "a".repeat(600000)));
  children[1].emit("close", 0, null);
  const large = (await largeRun).details.results[0];
  assert.ok(Buffer.byteLength(JSON.stringify(large.messages)) <= 4 * 1024 * 1024);
  assert.ok(large.messages.length < 10);
  assert.match(JSON.stringify(large.messages.at(-1)), /9aaa/);
});


test("invalid UTF-8 terminates a running child and waits for close", async (t) => {
  const { children, execute } = setup(t);
  const run = execute();
  let settled = false;
  void run.then(() => { settled = true; });
  children[0].stdout.emit("data", Buffer.from([0xff]));
  assert.deepEqual(children[0].signals, ["SIGTERM"]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  children[0].emit("close", null, "SIGTERM");
  assert.match(JSON.stringify(await run), /invalid UTF-8.*SIGTERM/);
});

test("oversized cumulative Pi agent_end event fails even after complete messages", async (t) => {
  const { children, execute } = setup(t);
  const run = execute();
  const child = children[0];
  child.stdout.emit("data", Buffer.concat([messageLine("completed"), Buffer.from('{"type":"agent_end","messages":[')]));
  child.stdout.emit("data", Buffer.alloc(700000, 65));
  child.stdout.emit("data", Buffer.alloc(400000, 65));
  assert.deepEqual(child.signals, ["SIGTERM"]);
  child.emit("close", 0, null);
  const result = await run;
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /exceeds 1 MiB/);
  assert.match(JSON.stringify(result.details.results[0].messages), /completed/);
});

test("stderr preserves split Unicode, trims leading fragments and bounds malformed bytes", async (t) => {
  const { children, execute } = setup(t);
  const bytes = Buffer.from("Grüße 🦊");
  for (let split = 1; split < bytes.length; split++) {
    const run = execute();
    const child = children.at(-1)!;
    child.stderr.emit("data", bytes.subarray(0, split));
    child.stderr.emit("data", bytes.subarray(split));
    child.emit("close", 0, null);
    assert.equal((await run).details.results[0].stderr, "Grüße 🦊");
  }
  for (const input of [Buffer.from("🦊" + "a".repeat(65535)), Buffer.alloc(65536, 255)]) {
    const run = execute();
    const child = children.at(-1)!;
    child.stderr.emit("data", input);
    child.emit("close", 0, null);
    const result = (await run).details.results[0];
    assert.ok(Buffer.byteLength(result.stderr) <= 65536);
    assert.equal(result.warnings.length, 1);
    if (input[0] === 255) {
      assert.equal(result.stderr, "�".repeat(Math.floor(65536 / 3)));
    } else {
      assert.equal(result.stderr, "a".repeat(65535));
    }
  }
});


test("prompt write and cleanup failures preserve both causes without spawning", async (t) => {
  const { children, execute } = setup(t);
  const originalMkdir = fs.mkdtempSync;
  const originalRemove = fs.rmSync;
  let directory = "";
  const writeError = Object.assign(new Error("disk full"), { code: "ENOSPC" });
  const cleanupError = Object.assign(new Error("permission denied"), { code: "EACCES" });
  t.mock.method(fs, "mkdtempSync", (...args: Parameters<typeof fs.mkdtempSync>) => {
    directory = originalMkdir(...args) as string;
    return directory;
  });
  t.mock.method(fs, "writeFileSync", () => { throw writeError; });
  t.mock.method(fs, "rmSync", () => { throw cleanupError; });
  syncBuiltinESMExports();
  try {
    await assert.rejects(execute(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /or remove their temporary directory/);
      assert.ok(error.cause instanceof AggregateError);
      assert.deepEqual(error.cause.errors, [writeError, cleanupError]);
      return true;
    });
    assert.equal(children.length, 0);
  } finally {
    originalRemove(directory, { recursive: true, force: true });
  }
});

for (const oversized of [false, true]) {
  test(`chain inserts literal previous output with repeated placeholders (oversized=${oversized})`, async (t) => {
    const { children, execute, tasks } = setup(t);
    const literal = "$& $` $' $$ {previous}";
    const previous = literal + (oversized ? "x".repeat(13000) : "");
    const run = execute(undefined, true, "prefix {previous} middle {previous} suffix");
    children[0].stdout.emit("data", JSON.stringify({ type: "message_end", message: {
      role: "assistant", content: [{ type: "text", text: previous }], stopReason: "stop",
    } }) + "\n");
    children[0].emit("close", 0, null);
    await new Promise<void>((resolve) => setImmediate(resolve));
    children[1].stdout.emit("data", messageLine("final answer"));
    children[1].emit("close", 0, null);
    const result = await run;
    assert.equal(Boolean(result.isError), false);
    const notice = `[Previous agent workflow output truncated from ${previous.length} to 6000 characters.]\n\n`;
    const handedOff = oversized ? notice + previous.slice(0, 6000 - notice.length) : previous;
    assert.equal(tasks[1], `Task: prefix ${handedOff} middle ${handedOff} suffix`);
  });
}

test("aborting a chain stops before the next subprocess", async (t) => {
  const { children, execute } = setup(t);
  const controller = new AbortController();
  const rejected = assert.rejects(execute(controller.signal, true), /aborted/);
  controller.abort();
  children[0].emit("close", null, "SIGTERM");
  await rejected;
  assert.equal(children.length, 1);
});

for (const preAborted of [false, true]) {
  test(`parallel cancellation skips queued prompts and returns every result (preAborted=${preAborted})`, async (t) => {
    const { children, execute } = setup(t);
    const mkdir = t.mock.method(fs, "mkdtempSync");
    syncBuiltinESMExports();
    const controller = new AbortController();
    if (preAborted) controller.abort();
    const run = execute(controller.signal, false, "", true);
    // Attach a rejection handler before settling children on the unfixed implementation.
    void run.catch(() => {});
    assert.equal(children.length, preAborted ? 0 : 4);
    if (!preAborted) {
      controller.abort();
      for (const child of children.slice()) child.emit("close", null, "SIGTERM");
    }
    const result = await run;
    assert.equal(children.length, preAborted ? 0 : 4);
    assert.equal(mkdir.mock.callCount(), preAborted ? 0 : 4);
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /Parallel: 0\/8 succeeded/);
    assert.equal(result.details.results.length, 8);
    for (const [i, item] of result.details.results.entries()) {
      assert.equal(item.task, `task-${i}`);
      assert.equal(item.stopReason, "aborted");
      assert.notEqual(item.exitCode, 0);
    }
  });
}

test("pre-aborted single run creates no prompt or child", async (t) => {
  const { children, execute } = setup(t);
  const mkdir = t.mock.method(fs, "mkdtempSync");
  syncBuiltinESMExports();
  const controller = new AbortController();
  controller.abort();
  const run = execute(controller.signal);
  void run.catch(() => {});
  assert.equal(children.length, 0);
  await assert.rejects(run, /aborted/);
  assert.equal(mkdir.mock.callCount(), 0);
});

test("parallel cancellation preserves completed results in order", async (t) => {
  const { children, execute } = setup(t);
  const controller = new AbortController();
  const run = execute(controller.signal, false, "", true);
  children[0].stdout.emit("data", messageLine("completed"));
  children[0].emit("close", 0, null);
  controller.abort();
  for (const child of children.slice(1)) child.emit("close", null, "SIGTERM");
  const result = await run;
  assert.equal(children.length, 4);
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /Parallel: 1\/8 succeeded/);
  assert.match(JSON.stringify(result.content), /Agent workflow was aborted\. Agent subprocess terminated by SIGTERM/);
  assert.equal(result.details.results[0].exitCode, 0);
  assert.deepEqual(result.details.results.slice(1).map((item) => item.stopReason), Array(7).fill("aborted"));
  assert.deepEqual(result.details.results.map((item) => item.task), Array.from({ length: 8 }, (_, i) => `task-${i}`));
});

test("parallel protocol failure in one agent keeps order, per-agent errors and rendered mixed outcome", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { children, execute, render, tasks } = setup(t);
  const run = execute(undefined, false, "", true);
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(children.length, 4);
  // Agent 1 emits a malformed message: it is terminated while the others keep running.
  children[1].stdout.emit("data", Buffer.from(JSON.stringify({ type: "message_end", message: { role: "assistant", content: null } }) + "\n"));
  assert.deepEqual(children[1].signals, ["SIGTERM"]);
  for (const index of [0, 2, 3]) assert.deepEqual(children[index].signals, []);
  // Finish out of order; the failed child is reaped last among the first batch.
  for (const index of [3, 0, 2]) {
    children[index].stdout.emit("data", messageLine(`output-${index}`));
    children[index].emit("close", 0, null);
  }
  children[1].emit("close", null, "SIGTERM");
  await settle();
  assert.equal(children.length, 8);
  for (const index of [7, 5, 4, 6]) {
    children[index].stdout.emit("data", messageLine(`output-${index}`));
    children[index].emit("close", 0, null);
  }
  const result = await run;
  assert.deepEqual(tasks.map((task) => task.replace(/^Task: /, "")), Array.from({ length: 8 }, (_, i) => `task-${i}`));
  assert.deepEqual(result.details.results.map((item) => item.task), Array.from({ length: 8 }, (_, i) => `task-${i}`));
  assert.deepEqual(result.details.results.map((item) => item.exitCode), [0, 1, 0, 0, 0, 0, 0, 0]);
  const failed = result.details.results[1];
  assert.equal(failed.messages.length, 0);
  assert.equal(failed.errorMessage, "Agent protocol contains a malformed message. Agent subprocess terminated by SIGTERM. Output may be incomplete.");
  for (const [i, item] of result.details.results.entries()) {
    if (i !== 1) assert.equal(item.errorMessage, undefined);
  }
  const text = result.content[0].text ?? "";
  assert.match(text, /^Parallel: 7\/8 succeeded/);
  const summaries = text.split("\n\n").slice(1);
  assert.equal(summaries.length, 8);
  assert.equal(summaries[1], `[implementer] failed: ${failed.errorMessage?.slice(0, 100)}...`);
  for (const [i, summary] of summaries.entries()) {
    if (i !== 1) assert.equal(summary, `[implementer] completed: output-${i}`);
  }

  const collapsed = render(result, false);
  assert.match(collapsed, /^◐ parallel 7\/8 tasks/);
  const collapsedIcons = [...collapsed.matchAll(/─── implementer ([✓✗])/g)].map((match) => match[1]);
  assert.deepEqual(collapsedIcons, ["✓", "✗", "✓", "✓", "✓", "✓", "✓", "✓"]);
  const collapsedOutputs = [...collapsed.matchAll(/output-\d|\(no output\)/g)].map((match) => match[0]);
  assert.deepEqual(collapsedOutputs, ["output-0", "(no output)", ...Array.from({ length: 6 }, (_, i) => `output-${i + 2}`)]);

  const expanded = render(result, true);
  assert.match(expanded, /^◐ parallel 7\/8 tasks/);
  const expandedTasks = [...expanded.matchAll(/─── implementer ([✓✗])\nTask: (task-\d)/g)].map((match) => `${match[2]}:${match[1]}`);
  assert.deepEqual(expandedTasks, Array.from({ length: 8 }, (_, i) => `task-${i}:${i === 1 ? "✗" : "✓"}`));
  assert.doesNotMatch(expanded, /output-1\b/);
});

test("pre-aborted chain creates no prompt or child", async (t) => {
  const { children, execute } = setup(t);
  const mkdir = t.mock.method(fs, "mkdtempSync");
  syncBuiltinESMExports();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(execute(controller.signal, true), /aborted/);
  assert.equal(children.length, 0);
  assert.equal(mkdir.mock.callCount(), 0);
});

const validUsage = {
  input: 2, output: 3, cacheRead: 4, cacheWrite: 5, totalTokens: 14,
  cost: { input: 0, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.1 },
};
const invalidMessages: unknown[] = [
  null, {}, { role: "alien", content: [] }, { role: "assistant", content: [], model: {} },
  ...[null, {}, "text", [null], [{ type: "text", text: null }],
    [{ type: "toolCall", id: "id", name: "bash", arguments: null }],
    [{ type: "toolCall", id: "id", name: 1, arguments: {} }],
    [{ type: "thinking", thinking: 1 }], [{ type: "unknown" }],
  ].map((content) => ({ role: "assistant", content })),
  ...[null, [], { ...validUsage, input: "2" }, { ...validUsage, output: -1 },
    { ...validUsage, totalTokens: Number.POSITIVE_INFINITY }, { ...validUsage, cost: null },
    { ...validUsage, cost: { ...validUsage.cost, total: "0.1" } },
  ].map((usage) => ({ role: "assistant", content: [], usage })),
  { role: "assistant", content: [], stopReason: {} },
  { role: "assistant", content: [], errorMessage: {} },
  { role: "user", content: null },
  ...["user", "toolResult"].flatMap((role) => [
    { role, content: [{ type: "thinking", thinking: "reason" }] },
    { role, content: [{ type: "toolCall", id: "id", name: "bash", arguments: {} }] },
  ]),
  { role: "assistant", content: [{ type: "image", data: "AA==", mimeType: "image/png" }] },
  { role: "toolResult", content: [{ type: "image", data: null, mimeType: "image/png" }] },
];
for (const type of ["message_end", "tool_result_end"]) {
  for (const [index, message] of invalidMessages.entries()) {
    test(`malformed ${type} message ${index} fails before retention and waits for close`, async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const { children, execute } = setup(t);
      const run = execute(undefined, true);
      let settled = false;
      void run.then(() => { settled = true; });
      const child = children[0];
      try {
        assert.doesNotThrow(() => child.stdout.emit("data", JSON.stringify({ type, message }) + "\n" + messageLine("ignored").toString()));
        assert.deepEqual(child.signals, ["SIGTERM"]);
        // Later events in the same stream must not be retained after rejection.
        child.stdout.emit("data", messageLine("ignored"));
        t.mock.timers.tick(5000);
        assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(settled, false);
      } finally {
        child.emit("close", 0, null);
      }
      const result = await run;
      assert.equal(result.isError, true);
      assert.deepEqual(result.details.results[0].messages, []);
      assert.equal(result.details.results[0].usage.turns, 0);
      assert.match(JSON.stringify(result.content), /malformed message/);
      assert.equal(children.length, 1);
    });
  }
}

test("valid message variants and unknown events remain supported", async (t) => {
  const { children, execute } = setup(t);
  const messages = [
    { role: "user", content: "task" },
    { role: "user", content: [{ type: "image", data: "AA==", mimeType: "image/png" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "reason" },
      { type: "toolCall", id: "id", name: "bash", arguments: { command: "pwd" } },
      { type: "text", text: "answer" }], usage: validUsage, stopReason: "stop" },
    { role: "toolResult", content: [{ type: "text", text: "done" }], toolCallId: "id", toolName: "bash", isError: false },
  ];
  const run = execute();
  for (const message of messages) {
    const type = message.role === "toolResult" ? "tool_result_end" : "message_end";
    children[0].stdout.emit("data", JSON.stringify({ type, message }) + "\n");
  }
  children[0].stdout.emit("data", '{"type":"future_event","message":null}\n');
  children[0].emit("close", 0, null);
  const result = await run;
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.details.results[0].messages, messages);
  assert.deepEqual(result.details.results[0].usage, { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: 0.1, contextTokens: 14, turns: 1 });
});

for (const oversized of [false, true]) {
  test(`all final text blocks reach output and capped chain handoff (oversized=${oversized})`, async (t) => {
    const { children, execute, tasks } = setup(t);
    const text = "first\nsecond" + (oversized ? "x".repeat(13000) : "");
    const content = [{ type: "text", text: "first" }, { type: "thinking", thinking: "hidden" },
      { type: "toolCall", id: "id", name: "read", arguments: {} },
      { type: "text", text: text.slice(6) }];
    const run = execute(undefined, true);
    children[0].stdout.emit("data", messageLine("older answer"));
    children[0].stdout.emit("data", JSON.stringify({ type: "message_end", message: { role: "assistant", content, stopReason: "stop" } }) + "\n");
    children[0].emit("close", 0, null);
    await new Promise<void>((resolve) => setImmediate(resolve));
    children[1].stdout.emit("data", JSON.stringify({ type: "message_end", message: { role: "assistant", content, stopReason: "stop" } }) + "\n");
    children[1].emit("close", 0, null);
    const result = await run;
    assert.deepEqual(result.content, [{ type: "text", text: "Warnings:\n- Requested model anthropic/claude-opus-4-6 is unavailable; falling back to openai/gpt-5.4.\n\n" + text }]);
    const notice = `[Previous agent workflow output truncated from ${text.length} to 12000 characters.]\n\n`;
    const capped = oversized ? notice + text.slice(0, 12000 - notice.length) : text;
    assert.equal(tasks[1], `Task: ${capped}`);
  });
}

for (const type of ["message_end", "tool_result_end"]) {
  test(`malformed ${type} at EOF fails without retaining output`, async (t) => {
    const { children, execute } = setup(t);
    const run = execute();
    children[0].stdout.emit("data", JSON.stringify({ type, message: { role: "assistant", content: null } }));
    children[0].emit("close", 0, null);
    const result = await run;
    assert.equal(result.isError, true);
    assert.deepEqual(result.details.results[0].messages, []);
    assert.match(JSON.stringify(result.content), /malformed message/);
    // EOF arrives on close, so there is no running child left to terminate.
    assert.deepEqual(children[0].signals, []);
  });
}

for (const terminal of ["empty", "tools", "length", "toolUse", "missing", "blank", "later-incomplete", "thinking", "stop"]) {
  test(`terminal completion required before chain handoff: ${terminal}`, async (t) => {
    const { children, execute, render } = setup(t);
    const run = execute(undefined, true);
    if (terminal === "later-incomplete" || terminal === "thinking") children[0].stdout.emit("data", messageLine("earlier answer"));
    if (terminal === "tools") {
      children[0].stdout.emit("data", JSON.stringify({ type: "tool_result_end", message: { role: "toolResult", content: [{ type: "text", text: "tool output" }] } }) + "\n");
    } else if (terminal !== "empty") {
      children[0].stdout.emit("data", JSON.stringify({ type: "message_end", message: {
        role: "assistant", content: terminal === "thinking" ? [{ type: "thinking", thinking: "still reasoning" }] : [{ type: "text", text: terminal === "blank" ? "  " : "answer" }],
        stopReason: terminal === "missing" || terminal === "later-incomplete" ? undefined : terminal === "blank" || terminal === "thinking" ? "stop" : terminal,
      } }) + "\n");
    }
    children[0].emit("close", 0, null);
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (children[1]) {
      children[1].stdout.emit("data", messageLine("final answer"));
      children[1].emit("close", 0, null);
    }
    const result = await run;
    assert.equal(Boolean(result.isError), terminal !== "stop");
    assert.equal(children.length, terminal === "stop" ? 2 : 1);
    if (terminal !== "stop") assert.match(result.content[0].text!, /completed assistant answer.*retry/i);
    if (terminal === "thinking") {
      for (const expanded of [false, true]) assert.match(render(result, expanded), /earlier answer/);
    }
  });
}

for (const closeBeforeEscalation of [false, true]) {
  test(`abort owns descendant group even after parent exit (close=${closeBeforeEscalation})`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { children, execute, spawnOptions } = setup(t);
    const controller = new AbortController();
    const run = execute(controller.signal);
    const rejected = assert.rejects(run, /aborted/);
    let settled = false;
    void run.catch(() => { settled = true; });
    const unrelated = execute();
    assert.equal(spawnOptions[0].detached, true);
    children[0].retainGroup = true; // A grandchild outlives the direct child.
    controller.abort();
    children[0].emit("exit", null, "SIGTERM");
    if (closeBeforeEscalation) children[0].emit("close", null, "SIGTERM");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    assert.deepEqual(children[0].signals, ["SIGTERM"]);
    t.mock.timers.tick(5000);
    assert.deepEqual(children[0].signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(children[0].groupAlive, false);
    assert.deepEqual(children[1].signals, []);
    if (!closeBeforeEscalation) children[0].emit("close", null, "SIGTERM");
    await rejected;
    children[1].stdout.emit("data", messageLine("unrelated answer"));
    children[1].emit("close", 0, null);
    assert.equal((await unrelated).isError, undefined);
  });
}

test("unsupported process-group platform fails before prompt creation", async (t) => {
  const { children, execute } = setup(t);
  Object.defineProperty(process, "platform", { value: "win32" });
  const mkdir = t.mock.method(fs, "mkdtempSync");
  syncBuiltinESMExports();
  const result = await execute();
  assert.equal(result.isError, true);
  assert.match(result.content[0].text!, /POSIX process groups/);
  assert.equal(children.length, 0);
  assert.equal(mkdir.mock.callCount(), 0);
});

for (const operation of ["mkdir", "write"]) {
  test(`parallel ${operation} preparation failure waits for siblings and preserves queued tasks`, async (t) => {
    const { children, execute, tasks } = setup(t);
    let calls = 0;
    let injected = false;
    const method = operation === "mkdir" ? "mkdtempSync" : "writeFileSync";
    const original = fs[method] as (...args: unknown[]) => unknown;
    t.mock.method(fs, method, (...args: unknown[]) => {
      if (++calls === (operation === "write" ? 3 : 2)) {
        injected = true;
        throw new Error("synthetic private setup details");
      }
      return original(...args);
    });
    syncBuiltinESMExports();
    const run = execute(undefined, false, "", true);
    let settled = false;
    void run.then(() => { settled = true; }, () => { settled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(injected, true);
    assert.equal(settled, false);
    // Each completion may start another queued task; finish all successful children.
    for (let index = 0; index < 7; index++) {
      const child = children[index];
      assert.ok(child);
      child.stdout.emit("data", messageLine(`answer-${tasks[index]}`));
      child.emit("close", 0, null);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const result = await run;
    assert.equal(children.length, 7);
    assert.deepEqual(result.details.results.map((item) => item.task), Array.from({ length: 8 }, (_, i) => `task-${i}`));
    const failed = result.details.results[1];
    assert.equal(failed.exitCode, 1);
    assert.match(failed.errorMessage!, /Unable to prepare or start agent task/);
    assert.doesNotMatch(JSON.stringify(result), /synthetic private/);
    for (const [index, item] of result.details.results.entries()) {
      if (index !== 1) assert.equal(item.exitCode, 0);
    }
  });
}

for (const batch of ["all-failed", "mixed", "provider-error", "aborted", "success"]) {
  test(`parallel verdict, summary and render agree: ${batch}`, async (t) => {
    const { children, execute, render } = setup(t);
    const run = execute(undefined, false, "", true);
    const failed = (index: number) => batch === "all-failed" || batch === "provider-error" || batch === "aborted" || (batch === "mixed" && index % 2 === 1);
    for (let index = 0; index < 8; index++) {
      const child = children[index];
      const stopReason = failed(index) && batch === "provider-error" ? "error" : failed(index) && batch === "aborted" ? "aborted" : "stop";
      child.stdout.emit("data", JSON.stringify({ type: "message_end", message: {
        role: "assistant", content: [{ type: "text", text: `answer-${index}` }], stopReason,
        ...(stopReason === "error" ? { errorMessage: "provider failed" } : {}),
      } }) + "\n");
      child.emit("close", failed(index) && (batch === "all-failed" || batch === "mixed") ? 2 : 0, null);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const result = await run;
    const successes = Array.from({ length: 8 }, (_, i) => !failed(i)).filter(Boolean).length;
    assert.equal(Boolean(result.isError), successes !== 8);
    assert.match(result.content[0].text!, new RegExp(`^Parallel: ${successes}/8 succeeded`));
    assert.equal((result.content[0].text!.match(/\] completed:/g) ?? []).length, successes);
    assert.equal((result.content[0].text!.match(/\] failed:/g) ?? []).length, 8 - successes);
    assert.deepEqual(result.details.results.map((item) => item.task), Array.from({ length: 8 }, (_, i) => `task-${i}`));
    for (const expanded of [false, true]) {
      const output = render(result, expanded);
      assert.match(output, new RegExp(`parallel ${successes}/8 tasks`));
      assert.deepEqual([...output.matchAll(/─── implementer ([✓✗])/g)].map((match) => match[1]), Array.from({ length: 8 }, (_, i) => failed(i) ? "✗" : "✓"));
    }
  });
}

for (const mode of ["single", "chain", "parallel"]) {
  test(`live ${mode} updates remain running until close`, async (t) => {
    const { children, execute, render } = setup(t);
    const outputs: string[] = [];
    const run = execute(undefined, mode === "chain", "{previous}", mode === "parallel", (partial) => {
      for (const expanded of [false, true]) outputs.push(render(partial, expanded));
    });
    children[0].stdout.emit("data", JSON.stringify({ type: "message_end", message: {
      role: "assistant", content: [{ type: "text", text: "working" }], stopReason: "toolUse",
    } }) + "\n");
    assert.equal(outputs.length, 2);
    for (const output of outputs) {
      assert.match(output, /^⏳/);
      assert.doesNotMatch(output, /✗|\[toolUse\]/);
      if (mode === "parallel") assert.match(output, /0\/8 done, 8 running/);
    }
    for (let index = 0; index < (mode === "parallel" ? 8 : mode === "chain" ? 2 : 1); index++) {
      children[index].stdout.emit("data", messageLine("completed"));
      children[index].emit("close", 0, null);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const result = await run;
    assert.equal(result.isError, undefined);
    assert.match(render(result, true), /^✓/);
  });
}

test("parallel unsupported-platform failures retain an actionable diagnostic", async (t) => {
  const { children, execute } = setup(t);
  Object.defineProperty(process, "platform", { value: "win32" });
  const mkdir = t.mock.method(fs, "mkdtempSync");
  syncBuiltinESMExports();
  const result = await execute(undefined, false, "", true);
  assert.equal(result.isError, true);
  assert.equal(result.details.results.length, 8);
  for (const item of result.details.results) assert.match(item.errorMessage!, /POSIX process groups/);
  assert.equal(children.length, 0);
  assert.equal(mkdir.mock.callCount(), 0);
});

test("group signal errors retain the protocol diagnostic", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { children, execute } = setup(t);
  t.mock.method(process, "kill", () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
  const run = execute();
  children[0].stdout.emit("data", Buffer.from([0xff]));
  children[0].emit("close", 1, null);
  t.mock.timers.tick(5000);
  // Model the bounded escalation without relying on platform signal delivery.
  // The final warning must supplement, rather than replace, the root cause.
  const result = await run;
  assert.match(result.details.results[0].errorMessage!, /invalid UTF-8/);
  assert.ok(result.details.results[0].warnings.includes("Unable to signal the owned agent process group."));
});

for (const mode of ["single", "chain", "parallel"] as const) {
  for (const eof of [false, true]) {
    test(`throwing progress observer cleans ${mode} groups and prompts (EOF=${eof})`, async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const { children, execute } = setup(t);
      const directories: string[] = [];
      const mkdir = fs.mkdtempSync;
      t.mock.method(fs, "mkdtempSync", (...args: Parameters<typeof fs.mkdtempSync>) => {
        const directory = mkdir(...args) as string;
        directories.push(directory);
        return directory;
      });
      syncBuiltinESMExports();
      t.after(() => directories.forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })));
      let updates = 0;
      const run = execute(undefined, mode === "chain", "test", mode === "parallel", () => {
        updates++;
        throw new Error("private observer detail ".repeat(10000));
      });
      const child = children[0];
      // A descendant remains in the group even after direct-child close.
      child.retainGroup = true;
      const bytes = messageLine("completed answer");
      assert.doesNotThrow(() => child.stdout.emit("data", eof ? bytes.subarray(0, -1) : bytes));
      if (eof) assert.doesNotThrow(() => child.emit("close", 0, null));
      assert.deepEqual(child.signals, ["SIGTERM"]);
      assert.ok(children.every((entry) => entry.signals.includes("SIGTERM")));
      assert.doesNotThrow(() => child.stdout.emit("data", messageLine("later update")));
      let settled = false;
      void run.then(() => { settled = true; });
      for (const entry of children) if (entry !== child || !eof) entry.emit("close", 0, null);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(settled, false);
      assert.equal(fs.existsSync(directories[0]), true);
      t.mock.timers.tick(5000);
      const result = await run;
      assert.equal(result.isError, true);
      assert.equal(updates, 1);
      assert.match(JSON.stringify(result), /progress delivery failed/);
      assert.doesNotMatch(JSON.stringify(result), /private observer detail/);
      assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
      assert.equal(child.groupAlive, false);
      assert.ok(directories.every((directory) => !fs.existsSync(directory)));
      assert.equal(children.length, mode === "parallel" ? 4 : 1);
    });
  }
}

test("parallel completion progress failure is a failed result after reaping siblings", async (t) => {
  const { children, execute } = setup(t);
  let updates = 0;
  const run = execute(undefined, false, "test", true, (partial) => {
    if (partial.details.results.some((result) => result.exitCode !== -1)) {
      updates++;
      throw new Error("observer failed");
    }
  });
  children[0].stdout.emit("data", messageLine("answer"));
  // Fail the completion update, after child zero has closed.
  for (const child of children) child.emit("close", 0, null);
  const result = await run;
  assert.equal(result.isError, true);
  assert.equal(updates, 1);
  assert.match(result.details.results[0].errorMessage!, /progress delivery failed/);
});

for (const field of ["input", "output", "cacheRead", "cacheWrite", "cost"] as const) {
  test(`aggregate usage ${field} overflow fails and stops chain handoff`, async (t) => {
    const { children, execute } = setup(t);
    const run = execute(undefined, true);
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    if (field === "cost") usage.cost.total = Number.MAX_VALUE;
    else usage[field] = Number.MAX_VALUE;
    const line = JSON.stringify({ type: "message_end", message: { role: "assistant",
      content: [{ type: "text", text: "answer" }], stopReason: "stop", usage } }) + "\n";
    children[0].stdout.emit("data", line + line);
    const signals = [...children[0].signals];
    children[0].emit("close", 0, null);
    // Finish an unexpected handoff too, so a regression cannot hang the suite.
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (children[1]) { children[1].stdout.emit("data", messageLine("unexpected")); children[1].emit("close", 0, null); }
    const result = await run;
    assert.equal(result.isError, true);
    assert.deepEqual(signals, ["SIGTERM"]);
    assert.equal(children.length, 1);
    assert.match(JSON.stringify(result), /usage.*overflow/i);
    assert.ok(Object.values(result.details.results[0].usage).every(Number.isFinite));
    assert.equal(JSON.stringify(result.details.results[0].usage).includes("null"), false);
  });
}

for (const parallel of [false, true]) {
  test(`cross-agent usage overflow renders a controlled diagnostic (parallel=${parallel})`, async (t) => {
    const { children, execute, render } = setup(t);
    const run = execute(undefined, !parallel, "test", parallel);
    for (let index = 0; index < (parallel ? 8 : 2); index++) {
      const usage = { input: Number.MAX_VALUE, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: Number.MAX_VALUE } };
      children[index].stdout.emit("data", JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "answer" }], stopReason: "stop", usage } }) + "\n");
      children[index].emit("close", 0, null);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const result = await run;
    for (const expanded of [false, true]) {
      const text = render(result, expanded);
      assert.doesNotMatch(text, /Infinity|NaN/);
      assert.match(text, /Usage total exceeds numeric range/);
    }
  });
}

for (const mode of ["single", "chain", "parallel"] as const) {
  test(`progress snapshots are detached and may be frozen (${mode})`, async (t) => {
    const { children, execute } = setup(t);
    const snapshots: unknown[] = [];
    const originals: string[] = [];
    const run = execute(undefined, mode === "chain", "test", mode === "parallel", (partial) => {
      snapshots.push(partial);
      originals.push(JSON.stringify(partial));
      const pending: unknown[] = [partial];
      while (pending.length) {
        const value = pending.pop();
        if (value && typeof value === "object") { pending.push(...Object.values(value)); Object.freeze(value); }
      }
    });
    try {
      for (let index = 0; index < (mode === "parallel" ? 8 : mode === "chain" ? 2 : 1); index++) {
        for (let turn = 0; turn < (index === 0 ? 270 : 1); turn++) {
          children[index].stdout.emit("data", messageLine(`answer-${turn}`));
        }
        children[index].emit("close", 0, null);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } catch (error) {
      for (const child of children) child.emit("close", 1, null);
      await run.catch(() => {});
      throw error;
    }
    const result = await run;
    assert.equal(result.isError, undefined);
    assert.equal(result.details.results[0].usage.turns, 270);
    assert.equal(result.details.results[0].messages.length, mode === "chain" ? 255 : 256);
    assert.deepEqual(snapshots.map(snapshot => JSON.stringify(snapshot)), originals);
    assert.ok(result.details.results.every(item => item.exitCode === 0));
  });
}

test("model provenance distinguishes requested, selected and observed across turns", async (t) => {
  const { children, execute } = setup(t);
  for (const models of [["gpt-5.4"], ["openai/gpt-5.4"], ["other-model", undefined], [undefined], ["other-model", "gpt-5.4"]]) {
    const run = execute();
    const child = children.at(-1)!;
    for (const model of models) child.stdout.emit("data", JSON.stringify({ type: "message_end", message: {
      role: "assistant", model, content: [{ type: "text", text: "answer" }], stopReason: "stop",
    } }) + "\n");
    child.emit("close", 0, null);
    const result = await run;
    assert.equal(result.isError, undefined);
    const provenance = result.details.results[0] as typeof result.details.results[0] & {
      model: string; requestedModel: string; selectedModel: string; observedModel?: string;
    };
    assert.equal(provenance.requestedModel, "openai/gpt-5.4");
    assert.equal(provenance.selectedModel, "openai/gpt-5.4");
    const observed = models.filter(model => model !== undefined).at(-1);
    assert.equal(provenance.observedModel, observed);
    assert.equal(provenance.model, observed ?? "openai/gpt-5.4");
    assert.equal(provenance.warnings.some(warning => /different from the selected model/.test(warning)), models.includes("other-model"));
  }
});

for (const eof of [false, true]) {
  test(`deep consumed tool arguments fail with cleanup (EOF=${eof})`, async (t) => {
    const { children, execute, render } = setup(t);
    const originalRemove = fs.rmSync;
    let removed = false;
    t.mock.method(fs, "rmSync", (...args: Parameters<typeof fs.rmSync>) => { removed = true; return originalRemove(...args); });
    syncBuiltinESMExports();
    const run = execute();
    const child = children[0];
    const line = '{"type":"message_end","message":{"role":"assistant","content":[{"type":"toolCall","id":"id","name":"test","arguments":' + '{"x":'.repeat(10000) + '0' + '}'.repeat(10000) + '}]}}';
    assert.ok(Buffer.byteLength(line) < 1024 * 1024);
    try {
      assert.doesNotThrow(() => child.stdout.emit("data", line + (eof ? "" : "\n")));
    } finally { child.emit("close", 0, null); }
    const result = await run;
    assert.equal(result.isError, true);
    assert.deepEqual(result.details.results[0].messages, []);
    assert.match(JSON.stringify(result), /malformed message/);
    assert.equal(removed, true);
    assert.deepEqual(child.signals, eof ? [] : ["SIGTERM"]);
    assert.doesNotThrow(() => { render(result, true); });
  });
}

test("ordinary nested tool arguments remain renderable", async (t) => {
  const { children, execute, render } = setup(t);
  const run = execute();
  const argumentsValue = { items: [{ filters: { nested: [1, { enabled: true }] } }] };
  children[0].stdout.emit("data", JSON.stringify({ type: "message_end", message: { role: "assistant", content: [
    { type: "toolCall", id: "id", name: "invented", arguments: argumentsValue },
    { type: "text", text: "answer" },
  ], stopReason: "stop" } }) + "\n");
  children[0].emit("close", 0, null);
  const result = await run;
  assert.equal(result.isError, undefined);
  assert.match(render(result, true), /invented/);
});

test("chain budgets span steps and repeated previous placeholders", async (t) => {
  const { children, executeChain, tasks } = setup(t);
  const steps = 10;
  type BulkResult = { messages: unknown[]; task: string; stderr: string };
  const measure = (results: BulkResult[]) => ({
    messages: results.reduce((sum, result) => sum + result.messages.length, 0),
    bytes: results.reduce((sum, result) => sum + Buffer.byteLength(JSON.stringify(result.messages)), 0),
    taskChars: results.reduce((sum, result) => sum + result.task.length, 0),
    stderrBytes: results.reduce((sum, result) => sum + Buffer.byteLength(result.stderr), 0),
  });
  const updates: ReturnType<typeof measure>[] = [];
  const run = executeChain(Array.from({ length: steps }, () => ({ agent: "implementer", task: "prefix {previous} middle {previous} suffix" })), partial => {
    updates.push(measure(partial.details.results));
  });
  for (let index = 0; index < steps; index++) {
    for (let turn = 0; turn < 6; turn++) children[index].stdout.emit("data", messageLine(`${index}-${turn}:` + "x".repeat(700000)));
    children[index].stderr.emit("data", Buffer.from("é".repeat(50000)));
    children[index].emit("close", 0, null);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const result = await run;
  assert.equal(result.isError, undefined);
  assert.equal(result.details.results.length, steps);
  for (const measurement of [...updates, measure(result.details.results)]) {
    assert.ok(measurement.messages <= 256);
    assert.ok(measurement.bytes <= 4 * 1024 * 1024);
    assert.ok(measurement.taskChars <= 12000);
    assert.ok(measurement.stderrBytes <= 64 * 1024);
  }
  assert.ok(updates.length > steps);
  assert.ok(result.details.results.every(item => item.exitCode === 0 && item.usage.turns === 6));
  assert.match(result.content[0].text!, /9-5:/);
  for (const task of tasks.slice(1)) assert.ok(task.length <= 12000 + "Task: prefix  middle  suffix".length);
  const first = result.details.results[0] as typeof result.details.results[0] & { omitted: { messages: number; taskChars: number; stderrBytes: number } };
  assert.ok(first.omitted.messages > 0);
  assert.ok(first.omitted.taskChars > 0);
  assert.ok(first.omitted.stderrBytes > 0);
  assert.match(first.warnings.join(" "), /Chain result details truncated/);
});

test("handoff budget survives more placeholders than available characters", async (t) => {
  const { children, executeChain, tasks } = setup(t);
  const run = executeChain([{ agent: "implementer", task: "first" },
    { agent: "implementer", task: "Do this: " + "{previous}".repeat(12001) }]);
  children[0].stdout.emit("data", messageLine("hello"));
  children[0].emit("close", 0, null);
  await new Promise<void>((resolve) => setImmediate(resolve));
  children[1].stdout.emit("data", messageLine("final answer"));
  children[1].emit("close", 0, null);
  const result = await run;
  assert.equal(result.isError, undefined);
  assert.equal(tasks[1], "Task: Do this: ");
  const last = result.details.results[1] as typeof result.details.results[1] & { handoff: unknown };
  assert.deepEqual(last.handoff, { sourceChars: 5, insertedChars: 0, truncated: true });
});

for (const singleStep of [false, true]) {
  test(`current chain task-detail truncation is reported accurately (singleStep=${singleStep})`, async (t) => {
    const { children, executeChain, tasks } = setup(t);
    const task = singleStep ? "long caller task ".repeat(1000) : "Summarize: {previous}";
    const run = executeChain(singleStep ? [{ agent: "implementer", task }] : [
      { agent: "implementer", task: "first" }, { agent: "implementer", task },
    ]);
    if (!singleStep) {
      children[0].stdout.emit("data", messageLine("x".repeat(13000)));
      children[0].emit("close", 0, null);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const child = children.at(-1)!;
    child.stdout.emit("data", messageLine("preserved final answer"));
    child.emit("close", 0, null);
    const result = await run;
    assert.equal(result.isError, undefined);
    const text = result.content[0].text!;
    assert.match(text, /Chain result details truncated/);
    assert.doesNotMatch(text, /Earlier chain details omitted/);
    assert.match(text, /preserved final answer/);
    assert.equal(tasks.at(-1)!.length, "Task: ".length + (singleStep ? task.length : "Summarize: ".length + 12000));
  });
}

test("small per-placeholder allowances retain source prefixes without fragmented notices", async (t) => {
  const { children, executeChain, tasks } = setup(t);
  const previous = "source-content-".repeat(100);
  const run = executeChain([{ agent: "implementer", task: "first" },
    { agent: "implementer", task: Array(200).fill("{previous}").join("|") }]);
  children[0].stdout.emit("data", messageLine(previous));
  children[0].emit("close", 0, null);
  await new Promise<void>((resolve) => setImmediate(resolve));
  children[1].stdout.emit("data", messageLine("final answer"));
  children[1].emit("close", 0, null);
  const result = await run;
  assert.equal(result.isError, undefined);
  assert.equal(tasks[1], "Task: " + Array(200).fill(previous.slice(0, 60)).join("|"));
});


for (const failure of ["cancel", "spawn"]) {
  test(`task file is retained until child cleanup and removed after ${failure}`, async (t) => {
    const { children, execute, spawnArgs } = setup(t);
    const controller = new AbortController();
    const run = execute(controller.signal);
    const taskPath = spawnArgs[0].at(-1)!.slice(1);
    assert.equal(fs.readFileSync(taskPath, "utf8"), "Task: test");
    if (failure === "cancel") {
      const rejected = assert.rejects(run, /aborted/);
      controller.abort();
      assert.ok(fs.existsSync(taskPath), "keep task input until the child is reaped");
      children[0].emit("close", null, "SIGTERM");
      await rejected;
    } else {
      Object.assign(children[0], { pid: undefined });
      children[0].emit("error", new Error("synthetic spawn failure"));
      assert.equal((await run).isError, true);
    }
    assert.equal(fs.existsSync(taskPath), false);
    assert.equal(fs.existsSync(path.dirname(taskPath)), false);
  });
}
