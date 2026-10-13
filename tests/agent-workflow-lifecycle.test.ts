import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import extension from "../extensions/agent_workflow/index.js";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function setup(t: TestContext) {
  const tasks: string[] = [];
  const children: Array<EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; killed: boolean; signals: string[]; kill: (signal: string) => boolean }> = [];
  t.mock.method(childProcess, "spawn", (_command: string, args: string[]) => {
    tasks.push(args.at(-1)!);
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(), killed: false, signals: [] as string[],
      kill(signal: string) { this.killed = true; this.signals.push(signal); return true; },
    });
    children.push(child);
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  type StubTool = { execute: (id: string, params: unknown, signal: AbortSignal | undefined, update: undefined, ctx: unknown) => Promise<{ isError?: boolean; content: unknown; details: { results: Array<{ messages: unknown[]; stderr: string; warnings: string[]; stopReason?: string; exitCode: number; task: string; usage: { turns: number } }> } }> };
  let tool: StubTool;
  extension({ registerTool(definition: StubTool) { tool = definition; } } as unknown as ExtensionAPI);
  const execute = (signal?: AbortSignal, chain = false, task = "{previous}", parallel = false) => tool.execute("test", chain
    ? { chain: [{ agent: "implementer", task: "first" }, { agent: "reviewer", task }] }
    : parallel ? { tasks: Array.from({ length: 8 }, (_, i) => ({ agent: "implementer", task: `task-${i}` })) }
    : { agent: "implementer", task: "test" }, signal, undefined, {
      cwd: process.cwd(), modelRegistry: { getAvailable: () => [{ provider: "openai", id: "gpt-5.4" }] },
    } as never);
  return { children, execute, tasks };
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
  Object.assign(children[0], { pid: 123 });
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

for (const partial of [false, true]) {
  test(`prompt write failure cleans owned directory (partial=${partial})`, async (t) => {
    const { children, execute } = setup(t);
    const originalWrite = fs.writeFileSync;
    const originalMkdir = fs.mkdtempSync;
    let directory = "";
    let fault = false;
    t.mock.method(fs, "mkdtempSync", (...args: Parameters<typeof fs.mkdtempSync>) => {
      directory = originalMkdir(...args) as string;
      return directory;
    });
    t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
      fault = true;
      if (partial) originalWrite(args[0], "partial private prompt", args[2]);
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(execute(), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "Unable to create agent prompt file.");
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
    child.stdout.emit("data", messageLine(`message-${i}`));
  }
  child.stderr.emit("data", Buffer.from("diagnostic tail"));
  child.emit("close", 0, null);
  const result = (await run).details.results[0];
  assert.equal(result.messages.length, 256);
  assert.equal(result.usage.turns, 300);
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
      assert.match(error.message, /or remove its temporary directory/);
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
    children[1].emit("close", 0, null);
    const result = await run;
    assert.equal(Boolean(result.isError), false);
    const handedOff = oversized
      ? "[Previous agent workflow output truncated from " + previous.length + " to 12000 characters.]\n\n" + previous.slice(0, 12000)
      : previous;
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
    children[0].stdout.emit("data", JSON.stringify({ type: "message_end", message: { role: "assistant", content } }) + "\n");
    // Preserve the latest assistant with text selection when a later message has no text.
    children[0].stdout.emit("data", JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }] } }) + "\n");
    children[0].emit("close", 0, null);
    await new Promise<void>((resolve) => setImmediate(resolve));
    children[1].stdout.emit("data", JSON.stringify({ type: "message_end", message: { role: "assistant", content } }) + "\n");
    children[1].emit("close", 0, null);
    const result = await run;
    assert.deepEqual(result.content, [{ type: "text", text: "Warnings:\n- Requested model anthropic/claude-opus-4-6 is unavailable; falling back to openai/gpt-5.4.\n\n" + text }]);
    const capped = oversized ? `[Previous agent workflow output truncated from ${text.length} to 12000 characters.]\n\n${text.slice(0, 12000)}` : text;
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
