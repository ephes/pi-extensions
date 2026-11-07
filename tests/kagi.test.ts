import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { formatPublishedDate, normalizeKagiLimit, searchKagi, KAGI_RESPONSE_MAX_BYTES, KAGI_SEARCH_TIMEOUT_MS } from "../shared/kagi.js";
import { USER_AGENT } from "../shared/http.js";
import kagiSearchExtension from "../extensions/kagi_search.js";

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

test("normalizeKagiLimit rounds, then clamps to 1-20, defaulting non-finite values", () => {
  const cases: Array<[number | undefined, number]> = [
    [undefined, 10], [Number.NaN, 10], [Number.POSITIVE_INFINITY, 10], [Number.NEGATIVE_INFINITY, 10],
    [-5, 1], [0, 1], [0.4, 1], [1, 1], [1.4, 1], [1.5, 2], [19.5, 20], [20, 20], [20.5, 20], [21, 20], [100, 20], [101, 20],
  ];
  for (const [input, expected] of cases) assert.equal(normalizeKagiLimit(input), expected, `limit ${input}`);
});

test("searchKagi and the kagi_search tool send the normalized limit and the shared user agent", async (t) => {
  const requests: Array<{ limit: string | null; userAgent: string | undefined }> = [];
  t.mock.method(globalThis, "fetch", async (url: URL, options: { headers: Record<string, string> }) => {
    requests.push({ limit: url.searchParams.get("limit"), userAgent: options.headers["User-Agent"] });
    return Response.json(valid);
  });
  const inputs = [undefined, 0, 1.5, 21, 101];
  for (const limit of inputs) await searchKagi("query", limit);

  type ToolStub = { execute: (id: string, params: unknown, signal: undefined, update: undefined) => Promise<{ details: { limit?: number } }> };
  let tool: ToolStub | undefined;
  kagiSearchExtension({ registerTool(definition: ToolStub) { tool = definition; } } as never);
  for (const limit of inputs) await tool!.execute("test", { query: "query", limit }, undefined, undefined);

  const expected = ["10", "1", "2", "20", "20"];
  assert.deepEqual(requests.map((request) => request.limit), [...expected, ...expected]);
  assert.ok(requests.every((request) => request.userAgent === USER_AGENT));
});

type SearchTool = { execute(id: string, params: unknown, signal: undefined, update: undefined): Promise<{
  content: Array<{ type: "text"; text: string }>;
  details: { resultCount: number; relatedCount: number; originalResultCount: number; originalRelatedCount: number; truncated: boolean; urls: string[]; meta?: Record<string, unknown> };
}> };
function registeredSearch() {
  let tool!: SearchTool;
  kagiSearchExtension({ registerTool(definition: SearchTool) { tool = definition; } } as never);
  return tool;
}

test("registered search enforces normalized result counts locally", async (t) => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ t: 0, url: `https://example.com/${i}`, title: `Result ${i}` }));
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: rows }));
  for (const [limit, expected] of [[1.5, 2], [0, 1], [NaN, 10], [undefined, 10], [21, 20]] as const) {
    const result = await registeredSearch().execute("test", { query: "query", limit }, undefined, undefined);
    assert.equal(result.details.resultCount, expected);
    assert.deepEqual(result.details.urls, rows.slice(0, expected).map(row => row.url));
    assert.equal(result.details.originalResultCount, 30);
    assert.equal(result.details.truncated, true);
    assert.doesNotMatch(result.content[0].text, new RegExp(`Result ${expected}\\b`));
  }
});

test("registered search bounds retained text, related terms and metadata below the transport cap", async (t) => {
  const payload = {
    data: [
      ...Array.from({ length: 30 }, (_, i) => ({ t: 0, url: `https://example.com/${i}`, title: "T".repeat(2048), snippet: "S".repeat(8192), published: "P".repeat(2048) })),
      { t: 1, list: Array.from({ length: 40 }, () => "R".repeat(4096)) },
    ],
    meta: { id: "I".repeat(120000), node: "N".repeat(120000), ms: 1, api_balance: 2, extra: "DROP-ME".repeat(10000) },
  };
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) < KAGI_RESPONSE_MAX_BYTES);
  t.mock.method(globalThis, "fetch", async () => Response.json(payload));
  const result = await registeredSearch().execute("test", { query: "query", limit: 20 }, undefined, undefined);
  assert.ok(result.content[0].text.length <= 32768);
  assert.ok(JSON.stringify(result.details).length <= 32768);
  assert.equal(result.details.truncated, true);
  assert.equal(result.details.originalResultCount, 30);
  assert.equal(result.details.originalRelatedCount, 40);
  assert.equal(result.details.resultCount, result.details.urls.length);
  assert.ok(result.details.resultCount > 0 && result.details.resultCount < 20);
  assert.equal(result.details.relatedCount, 10);
  assert.equal((result.content[0].text.match(/^- /gm) ?? []).length, 10);
  assert.match(result.content[0].text, /truncated/i);
  assert.doesNotMatch(JSON.stringify(result), /T{513}|S{2049}|P{65}|R{129}|I{257}|N{257}|DROP-ME/);
  assert.deepEqual(Object.keys(result.details.meta!).sort(), ["api_balance", "id", "ms", "node"]);
});

test("registered search preserves complete useful URLs and omits oversized URLs", async (t) => {
  const useful = `https://example.com/${"u".repeat(1800)}`;
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [
    { t: 0, url: `https://example.com/${"x".repeat(3000)}`, title: "Oversized URL" },
    { t: 0, url: useful, title: "Useful", snippet: "Snippet", published: 1735689600 },
  ] }));
  const result = await registeredSearch().execute("test", { query: "query", limit: 2 }, undefined, undefined);
  assert.deepEqual(result.details.urls, [useful]);
  assert.equal(result.details.resultCount, 1);
  assert.equal(result.details.truncated, true);
  assert.ok(result.content[0].text.includes(useful));
  assert.match(result.content[0].text, /Useful\n.*URL:.*\n.*Snippet: Snippet\n.*Published: 2025-01-01/);
  assert.doesNotMatch(result.content[0].text, /Oversized URL/);
});

test("registered search keeps ordinary and empty search output with truthful retained counts", async (t) => {
  let payload: unknown = valid;
  t.mock.method(globalThis, "fetch", async () => Response.json(payload));
  const tool = registeredSearch();
  const ordinary = await tool.execute("test", { query: "query" }, undefined, undefined);
  assert.equal(ordinary.details.resultCount, 1);
  assert.equal(ordinary.details.relatedCount, 1);
  assert.equal(ordinary.details.truncated, true); // Unknown metadata is omitted.
  assert.match(ordinary.content[0].text, /Café\n.*https:\/\/example.com\n.*text\n.*2025-01-01/);
  payload = { data: [], meta: { id: "id" } };
  const empty = await tool.execute("test", { query: "query" }, undefined, undefined);
  assert.equal(empty.content[0].text, 'No results found for "query".');
  assert.equal(empty.details.resultCount, 0);
  assert.equal(empty.details.relatedCount, 0);
  assert.equal(empty.details.truncated, false);
  payload = { data: [{ t: 1, list: ["related only"] }] };
  const relatedOnly = await tool.execute("test", { query: "query" }, undefined, undefined);
  assert.equal(relatedOnly.details.resultCount, 0);
  assert.equal(relatedOnly.details.relatedCount, 0);
  assert.equal(relatedOnly.details.originalRelatedCount, 1);
  assert.equal(relatedOnly.details.truncated, true);
});


test("registered search bounds aggregate URL retention and query labels", async (t) => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ t: 0, url: `https://example.com/${i}/${"u".repeat(2000)}`, title: "Title" }));
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: rows }));
  const result = await registeredSearch().execute("test", { query: "Q".repeat(40000), limit: 20 }, undefined, undefined);
  assert.ok(result.content[0].text.length < 32768);
  assert.ok(JSON.stringify(result.details).length < 32768);
  assert.ok(result.details.resultCount > 0 && result.details.resultCount < 20);
  assert.deepEqual(result.details.urls, rows.slice(0, result.details.resultCount).map(row => row.url));
  assert.equal(result.details.truncated, true);
  assert.doesNotMatch(JSON.stringify(result), /Q{513}/);
});

test("registered search reports when every result URL is too large", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [{ t: 0, url: "u".repeat(2049), title: "Title" }] }));
  const result = await registeredSearch().execute("test", { query: "query" }, undefined, undefined);
  assert.equal(result.details.resultCount, 0);
  assert.deepEqual(result.details.urls, []);
  assert.equal(result.details.originalResultCount, 1);
  assert.equal(result.details.truncated, true);
  assert.match(result.content[0].text, /No results retained.*output limits/);
  assert.doesNotMatch(result.content[0].text, /No results found/);
});
