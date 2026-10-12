import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import extension from "../extensions/agent_workflow/index.js";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function setup(t: TestContext) {
  const children: Array<EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; killed: boolean; signals: string[]; kill: (signal: string) => boolean }> = [];
  t.mock.method(childProcess, "spawn", () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(), killed: false, signals: [] as string[],
      kill(signal: string) { this.killed = true; this.signals.push(signal); return true; },
    });
    children.push(child);
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  type StubTool = { execute: (id: string, params: unknown, signal: AbortSignal | undefined, update: undefined, ctx: unknown) => Promise<{ isError?: boolean }> };
  let tool: StubTool;
  extension({ registerTool(definition: StubTool) { tool = definition; } } as unknown as ExtensionAPI);
  const execute = (signal?: AbortSignal, chain = false) => tool.execute("test", chain
    ? { chain: [{ agent: "implementer", task: "first" }, { agent: "reviewer", task: "{previous}" }] }
    : { agent: "implementer", task: "test" }, signal, undefined, {
      cwd: process.cwd(), modelRegistry: { getAvailable: () => [{ provider: "openai", id: "gpt-5.4" }] },
    } as never);
  return { children, execute };
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
  await Promise.resolve();
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
