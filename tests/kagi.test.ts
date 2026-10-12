import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { formatPublishedDate, searchKagi, KAGI_RESPONSE_MAX_BYTES, KAGI_SEARCH_TIMEOUT_MS } from "../shared/kagi.js";

test("formatPublishedDate normalizes unix timestamps", () => {
  assert.equal(formatPublishedDate(1735689600), "2025-01-01");
});

test("formatPublishedDate preserves unparseable strings", () => {
  assert.equal(formatPublishedDate("not-a-date"), "not-a-date");
});

test("formatPublishedDate returns undefined for empty values", () => {
  assert.equal(formatPublishedDate(undefined), undefined);
  assert.equal(formatPublishedDate(""), undefined);
});

let savedKey: string | undefined;
beforeEach(() => { savedKey = process.env.KAGI_API_KEY; process.env.KAGI_API_KEY = "test-key"; });
afterEach(() => {
  if (savedKey === undefined) delete process.env.KAGI_API_KEY;
  else process.env.KAGI_API_KEY = savedKey;
});

const valid = { data: [{ t: 0, url: "https://example.com", title: "Café", snippet: "text", published: 1735689600 }, { t: 1, list: ["related"] }], meta: { id: "id", extra: true }, extra: true };

test("searchKagi validates envelopes, items and optional fields", async (t) => {
  let payload: unknown;
  t.mock.method(globalThis, "fetch", async () => Response.json(payload));
  for (payload of [null, 1, "text", [], {}, { data: [null] }, { data: [{ t: 0, url: 1, title: "a" }] },
    { data: [{ t: 0, url: "u", title: null }] }, { data: [{ t: 1, list: [1] }] },
    { data: [{ t: 2 }] }, { data: [{ t: 0, url: "u", title: "a", snippet: [] }] },
    { data: [{ t: 0, url: "u", title: "a", published: {} }] }, { data: [], meta: [] }, { data: [{ t: 1, list: "bad" }] },
    ...["id", "node", "ms", "api_balance"].map(key => ({ data: [], meta: { [key]: [] } }))]) {
    await assert.rejects(searchKagi("query"), /invalid search data/);
  }
  payload = { data: [{ t: 0, url: "u", title: "t", snippet: null, published: null }],
    meta: { id: null, node: null, ms: null, api_balance: null } };
  assert.deepEqual(await searchKagi("query"), payload);
  payload = valid;
  assert.deepEqual(await searchKagi("query"), valid);
});

test("searchKagi bounds chunked success and error bodies and cancels streams", async (t) => {
  let cancelled = 0;
  let pulls = 0;
  let status = 200;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(KAGI_RESPONSE_MAX_BYTES / 2)); },
    cancel() { cancelled++; },
  }), { status }));
  for (status of [200, 500]) {
    await assert.rejects(searchKagi("query"), /byte limit/);
  }
  assert.equal(cancelled, 2);
  assert.ok(pulls <= 8);
});

test("searchKagi decodes exact-limit multibyte JSON across chunks", async (t) => {
  const bytes = new TextEncoder().encode(JSON.stringify(valid));
  const padded = new Uint8Array(KAGI_RESPONSE_MAX_BYTES).fill(32);
  padded.set(bytes);
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    start(controller) {
      const split = bytes.indexOf(0xc3) + 1;
      controller.enqueue(padded.slice(0, split));
      controller.enqueue(padded.slice(split));
      controller.close();
    },
  })));
  assert.deepEqual(await searchKagi("query"), valid);
});

test("searchKagi total deadline covers stalled headers and body", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let body = false;
  let cancelled = false;
  let fetchSignal: AbortSignal | undefined;
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: { signal?: AbortSignal }) => {
    fetchSignal = options.signal as AbortSignal;
    if (!body) return new Promise<Response>(() => {});
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  });
  for (body of [false, true]) {
    const pending = searchKagi("query");
    const rejection = assert.rejects(pending, /timed out/);
    await Promise.resolve();
    await Promise.resolve();
    t.mock.timers.tick(KAGI_SEARCH_TIMEOUT_MS);
    await rejection;
    assert.equal(fetchSignal?.aborted, true);
  }
  assert.equal(cancelled, true);
});

test("searchKagi caller cancellation is immediate and success clears deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let fetchSignal: AbortSignal | undefined;
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: { signal?: AbortSignal }) => {
    fetchSignal = options.signal as AbortSignal;
    return Response.json(valid);
  });
  await searchKagi("query");
  t.mock.timers.tick(KAGI_SEARCH_TIMEOUT_MS);
  assert.equal(fetchSignal?.aborted, false);
  const controller = new AbortController();
  controller.abort(new Error("test-key"));
  await assert.rejects(searchKagi("query", 10, controller.signal), { name: "AbortError", message: "Kagi search cancelled." });
  t.mock.method(globalThis, "fetch", async () => new Promise<Response>(() => {}));
  const active = new AbortController();
  const pending = searchKagi("query", 10, active.signal);
  active.abort();
  await assert.rejects(pending, /cancelled/);
});


test("searchKagi controls invalid JSON and redacts key from HTTP diagnostics", async (t) => {
  let body = "not JSON";
  let status = 200;
  t.mock.method(globalThis, "fetch", async () => new Response(body, { status }));
  await assert.rejects(searchKagi("query"), /not valid JSON/);
  status = 401;
  body = "upstream echoed test-key";
  await assert.rejects(searchKagi("query"), { message: "Kagi API request failed with HTTP 401: upstream echoed [redacted]" });
});
