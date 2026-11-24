import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { ReadableStreamReadResult } from "node:stream/web";
import { setImmediate } from "node:timers/promises";
import { formatPublishedDate, normalizeKagiLimit, searchKagi, KAGI_RESPONSE_MAX_BYTES, KAGI_SEARCH_TIMEOUT_MS } from "../shared/kagi.js";
import { USER_AGENT } from "../shared/http.js";
import kagiSearchExtension from "../extensions/kagi_search.js";

test("formatPublishedDate normalizes unix timestamps", () => {
  assert.equal(formatPublishedDate(1735689600), "2025-01-01");
});

const invalidPublishedDates = [
  "not-a-date", "2025-02-29", "2024-02-30", "2025-04-31", "2025-00-01", "2025-13-01", "2025-01-00",
  "2025-01-01T24:00:00Z", "2025-01-01T00:60:00Z", "2025-01-01T00:00:60Z",
  "2025-01-01T00:00:00+24:00", "2025-01-01T00:00:00+00:60", "2025-02-29T12:00:00Z",
  "2025-01-01T12:00:00", "January 1, 2025", "1", " 2025-01-01 ", "2025-01-01\n", "2025-01-01\r\n",
  "+010000-01-01T00:00:00Z", "-000001-01-01T00:00:00Z", "+002025-01-01T00:00:00Z",
  "9999-12-31T23:30:00-01:00", "0000-01-01T00:30:00+01:00",
  "2025-01-01" + " ".repeat(54) + "untrusted suffix",
  253402300800, -62167219201, 8640000000000, -8640000000000,
];

for (const value of invalidPublishedDates) {
  test(`formatPublishedDate omits unsupported or invalid evidence ${JSON.stringify(value)}`, () => {
    assert.equal(formatPublishedDate(value), undefined);
  });
}

test("formatPublishedDate validates calendar dates and converts supported timestamps to UTC dates", () => {
  const cases: Array<[string | number, string]> = [
    [0, "1970-01-01"], [1735689600.5, "2025-01-01"], [-1, "1969-12-31"],
    ["2024-02-29", "2024-02-29"], ["2000-02-29", "2000-02-29"],
    ["2025-01-01T00:00:00Z", "2025-01-01"], ["2025-01-01T00:00:00.123Z", "2025-01-01"],
    ["2025-01-01T00:30:00.1+01:00", "2024-12-31"], ["2024-12-31T23:30:00-01:00", "2025-01-01"],
    ["0000-01-01", "0000-01-01"], ["0099-12-31", "0099-12-31"], ["9999-12-31", "9999-12-31"],
    [-62167219200, "0000-01-01"], [253402300799, "9999-12-31"],
  ];
  for (const [value, expected] of cases) assert.equal(formatPublishedDate(value), expected, String(value));
  for (const value of [NaN, Infinity, -Infinity, Number.MAX_VALUE, "1900-02-29"]) {
    assert.equal(formatPublishedDate(value), undefined);
  }
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

test("searchKagi honors pre-aborted calls before credential lookup", async (t) => {
  delete process.env.KAGI_API_KEY;
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json(valid));
  const signal = AbortSignal.abort(new Error("synthetic reason"));

  await assert.rejects(searchKagi("query", undefined, signal),
    { name: "AbortError", message: "Kagi search cancelled." });
  await assert.rejects(searchKagi("query"), /KAGI_API_KEY is not set/);
  assert.equal(fetch.mock.callCount(), 0);
});

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
  payload = { data: [{ t: 0, url: "https://example.com/", title: "t", snippet: null, published: null }],
    meta: { id: null, node: null, ms: null, api_balance: null } };
  assert.deepEqual(await searchKagi("query"), payload);
  payload = valid;
  assert.deepEqual(await searchKagi("query"), valid);
});

test("searchKagi bounds chunked success bodies, cancels unread error bodies and streams", async (t) => {
  let cancelled = 0;
  let pulls = 0;
  let status = 200;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(KAGI_RESPONSE_MAX_BYTES / 2)); },
    cancel() { cancelled++; },
  }), { status }));
  for (status of [200, 500]) {
    await assert.rejects(searchKagi("query"), status === 200 ? /byte limit/ : /HTTP 500; check Kagi service status/);
  }
  assert.equal(cancelled, 2);
  assert.ok(pulls <= 8);
});

for (const overLimit of [false, true]) {
  test(`Kagi body bounds consecutive empty reads (over limit=${overLimit})`, async (t) => {
    const empty = new Uint8Array();
    const bytes = new TextEncoder().encode(JSON.stringify(valid));
    const split = bytes.indexOf(0xc3) + 1; // Split the UTF-8 sequence in "Café".
    const chunks = [bytes.subarray(0, split), ...Array<Uint8Array>(256).fill(empty), bytes.subarray(split),
      ...Array<Uint8Array>(overLimit ? 300 : 256).fill(empty)];
    let reads = 0;
    const reader = {
      async read() {
        const value = chunks[reads++];
        return { done: value === undefined, value };
      },
      async cancel() {},
      releaseLock() {},
    };
    const cancel = t.mock.method(reader, "cancel");
    const release = t.mock.method(reader, "releaseLock");
    t.mock.method(globalThis, "fetch", async () => ({
      ok: true, status: 200, headers: new Headers(), body: { getReader: () => reader },
    }));

    const pending = searchKagi("query");
    if (overLimit) {
      await assert.rejects(pending, { message: "Response body exceeded the consecutive empty-read limit; retry the request." });
      assert.equal(reads, 2 + 256 + 257);
    } else {
      assert.deepEqual(await pending, valid);
      assert.equal(reads, chunks.length + 1);
    }
    assert.equal(cancel.mock.callCount(), 1);
    assert.equal(release.mock.callCount(), 1);
  });
}

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

test("searchKagi decodes one-byte fragments incrementally and rejects an incomplete UTF-8 tail", async (t) => {
  const payload = { ...valid, extra: "a".repeat(5000) + "Grüße 🦊" + "b".repeat(5000) };
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const decode = TextDecoder.prototype.decode;
  let streamedBytes = 0;
  t.mock.method(TextDecoder.prototype, "decode", function(this: TextDecoder, ...args: Parameters<typeof decode>) {
    if (this.fatal && args[1]?.stream) streamedBytes += args[0]?.byteLength ?? 0;
    return decode.apply(this, args);
  });
  let incompleteTail = false;
  t.mock.method(globalThis, "fetch", async () => {
    let offset = 0;
    return new Response(new ReadableStream({
      pull(controller) {
        if (offset < bytes.length) controller.enqueue(Uint8Array.of(bytes[offset++]));
        else {
          if (incompleteTail) controller.enqueue(Uint8Array.of(0xe2, 0x82));
          controller.close();
        }
      },
    }));
  });
  assert.deepEqual(await searchKagi("query"), payload);
  incompleteTail = true;
  await assert.rejects(searchKagi("query"), { message: "Kagi API response contains invalid UTF-8." });
  assert.equal(streamedBytes, 2 * bytes.length + 2);
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

for (const stop of ["caller cancellation", "deadline", "reader release"] as const) {
  test(`searchKagi skips JSON validation on ${stop}`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const caller = new AbortController();
    const body = '{"data":[],"extra":"cancelled body"}';
    const bytes = new TextEncoder().encode(body);
    let markReading!: () => void;
    const reading = new Promise<void>((resolve) => { markReading = resolve; });
    let finishRead!: (result: ReadableStreamReadResult<Uint8Array>) => void;
    const lateRead = new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => { finishRead = resolve; });
    const eof = { done: true, value: undefined } as const;
    let reads = 0;
    let released = false;
    const reader = {
      async read() {
        ++reads;
        if (reads === 1) {
          return { done: false, value: stop === "deadline" ? bytes.subarray(0, 1) : bytes };
        }
        if (reads !== 2 || stop === "reader release") return eof;
        markReading();
        return lateRead;
      },
      cancel() {
        finishRead(stop === "deadline" ? { done: false, value: bytes.subarray(1) } : eof);
        if (stop === "caller cancellation") throw new Error("private cancellation failure");
        return Promise.resolve();
      },
      releaseLock() {
        released = true;
        if (stop === "reader release") caller.abort();
      },
    };
    t.mock.method(globalThis, "fetch", async () => ({ ok: true, status: 200, headers: new Headers(), body: { getReader: () => reader } }));
    const parse = JSON.parse;
    let parses = 0;
    t.mock.method(JSON, "parse", (...args: Parameters<typeof parse>) => {
      if (args[0] === body) ++parses;
      return parse(...args);
    });

    const rejection = assert.rejects(searchKagi("query", undefined, caller.signal), stop === "deadline"
      ? { name: "TimeoutError", message: "Kagi search timed out after 30 seconds. Please retry." }
      : { name: "AbortError", message: "Kagi search cancelled." });
    if (stop !== "reader release") {
      await reading;
      if (stop === "deadline") t.mock.timers.tick(KAGI_SEARCH_TIMEOUT_MS);
      else caller.abort();
    }
    await rejection;
    // Let the abandoned request run any continuations after the public race settles.
    await setImmediate();
    assert.equal(parses, 0);
    assert.equal(reads, 2);
    assert.equal(released, true);
  });
}

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


test("searchKagi controls invalid JSON and excludes HTTP response bodies", async (t) => {
  let body = "not JSON";
  let status = 200;
  t.mock.method(globalThis, "fetch", async () => new Response(body, { status }));
  await assert.rejects(searchKagi("query"), /not valid JSON/);
  status = 401;
  body = "upstream echoed test-key";
  await assert.rejects(searchKagi("query"), { message: "Kagi API request failed with HTTP 401; check Kagi service status or API access and retry." });
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

type SearchProgress = { content: Array<{ type: "text"; text: string }>; details: { query: string; limit: number } };
type SearchTool = { execute(id: string, params: unknown, signal: undefined, update: ((progress: SearchProgress) => void) | undefined): Promise<{
  content: Array<{ type: "text"; text: string }>;
  details: { query: string; resultCount: number; relatedCount: number; originalResultCount: number; originalRelatedCount: number; truncated: boolean; urls: string[]; meta?: Record<string, unknown> };
}> };
function registeredSearch() {
  let tool!: SearchTool;
  kagiSearchExtension({ registerTool(definition: SearchTool) { tool = definition; } } as never);
  return tool;
}

for (const [status, headers] of [
  [206, {}],
  [203, {}],
  [200, { "Content-Range": "bytes 0-99/200" }],
] as const) {
  test(`registered search requires a complete Kagi response (HTTP ${status})`, async (t) => {
    const bytes = new TextEncoder().encode(JSON.stringify(valid));
    let pulls = 0;
    let cancellations = 0;
    const refused = new Response(new ReadableStream({
      pull(controller) {
        ++pulls;
        controller.enqueue(bytes);
        controller.close();
      },
      cancel() { ++cancellations; },
    }, { highWaterMark: 0 }), { status, headers: new Headers(headers) });
    const fetch = t.mock.method(globalThis, "fetch", async () => refused);
    const tool = registeredSearch();

    await assert.rejects(tool.execute("test", { query: "query" }, undefined, undefined), {
      message: "Kagi API expected a complete HTTP 200 response without Content-Range.",
    });
    assert.equal(pulls, 0);
    assert.equal(cancellations, 1);

    fetch.mock.mockImplementation(async () => Response.json(valid));
    const result = await tool.execute("test", { query: "query" }, undefined, undefined);
    assert.equal(result.details.resultCount, 1);
    assert.deepEqual(result.details.urls, ["https://example.com"]);
  });
}

test("registered search omits untrustworthy Published metadata without losing useful results", async (t) => {
  const rows = invalidPublishedDates.map((published, index) => ({ t: 0, url: `https://example.com/${index}`, title: `Result ${index}`, published }));
  let row = rows[0];
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [row] }));
  for (row of rows) {
    const result = await registeredSearch().execute("test", { query: "query" }, undefined, undefined);
    assert.equal(result.details.resultCount, 1);
    assert.deepEqual(result.details.urls, [row.url]);
    assert.doesNotMatch(result.content[0].text, /Published:/);
  }
});

test("Kagi direct search rejects blank queries before network setup", async (t) => {
  const queries: string[][] = [];
  const fetch = t.mock.method(globalThis, "fetch", async (url: URL) => {
    queries.push(url.searchParams.getAll("q"));
    return Response.json(valid);
  });
  const timer = t.mock.method(globalThis, "setTimeout");

  for (const key of ["test-key", undefined]) {
    if (key === undefined) delete process.env.KAGI_API_KEY;
    else process.env.KAGI_API_KEY = key;
    for (const query of [" \t\n\u00a0 ", ""]) {
      await assert.rejects(searchKagi(query), { message: "Query cannot be empty." });
    }
  }
  assert.equal(timer.mock.callCount(), 0);
  assert.equal(fetch.mock.callCount(), 0);

  process.env.KAGI_API_KEY = "test-key";
  const query = "Café 東京 &q=other+#";
  assert.deepEqual(await searchKagi(`  ${query}  `), valid);
  assert.deepEqual(queries, [[query]]);
});

test("Kagi refuses over-limit UTF-8 queries before progress or transport, including before trimming", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({ data: [] }));
  const progress: SearchProgress[] = [];
  for (const query of ["x".repeat(8193), "é".repeat(4097), "😀".repeat(2048) + "x", " ".repeat(8192) + "q"]) {
    await assert.rejects(registeredSearch().execute("test", { query }, undefined, update => progress.push(update)),
      { message: "Kagi query exceeds the 8192-byte UTF-8 limit." });
    await assert.rejects(searchKagi(query), { message: "Kagi query exceeds the 8192-byte UTF-8 limit." });
  }
  assert.equal(progress.length, 0);
  assert.equal(fetch.mock.callCount(), 0);
});

for (const entry of ["direct search", "registered tool"]) {
  test(`Kagi ${entry} rejects unpaired surrogates and preserves supplementary Unicode`, async (t) => {
    const queries: string[][] = [];
    t.mock.method(globalThis, "fetch", async (url: URL) => {
      queries.push(url.searchParams.getAll("q"));
      return Response.json({ data: [] });
    });
    const progress: SearchProgress[] = [];
    const tool = registeredSearch();
    const run = (query: string) => entry === "direct search"
      ? searchKagi(query)
      : tool.execute("test", { query }, undefined, update => progress.push(update));

    for (const query of [" \uD800query ", "query\uDFFF"]) {
      await assert.rejects(run(query), { message: "Kagi query must be valid Unicode text." });
    }
    assert.deepEqual(queries, []);
    assert.equal(progress.length, 0);

    const query = "𠮷 😀 &q=other+#";
    await run(query);
    assert.deepEqual(queries, [[query]]);
  });
}

test("Kagi admits exact-byte boundaries and preserves full query text with bounded progress", async (t) => {
  const queries: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    queries.push(url.searchParams.get("q")!);
    return Response.json({ data: [] });
  });
  for (const query of ["x".repeat(8192), "é".repeat(4096), "😀".repeat(2048)]) {
    assert.equal(Buffer.byteLength(query), 8192);
    const progress: SearchProgress[] = [];
    const result = await registeredSearch().execute("test", { query }, undefined, update => progress.push(update));
    await searchKagi(query);
    assert.deepEqual(queries.splice(0), [query, query]);
    assert.equal(progress.length, 1);
    assert.ok(progress[0].details.query.length <= 512);
    assert.ok(progress[0].content[0].text.length <= 550);
    assert.ok(progress[0].details.query.endsWith("…"));
    assert.ok(query.startsWith(progress[0].details.query.slice(0, -1)));
    assert.doesNotMatch(progress[0].details.query, /[\uD800-\uDBFF]…$/);
    assert.equal(progress[0].content[0].text, `Searching Kagi for "${progress[0].details.query}"...`);
    assert.equal(result.details.query, progress[0].details.query);
    assert.doesNotMatch(result.content[0].text, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    assert.ok(result.content[0].text.includes(`"${progress[0].details.query}"`));
  }
  const progress: SearchProgress[] = [];
  await registeredSearch().execute("test", { query: "  Café 東京  " }, undefined, update => progress.push(update));
  assert.deepEqual(queries, ["Café 東京"]);
  assert.equal(progress[0].details.query, "Café 東京");
  await assert.rejects(registeredSearch().execute("test", { query: "  " }, undefined, undefined), /Query cannot be empty/);
});

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

test("registered search counts all related terms without flattening the response", async (t) => {
  const rows = Array.from({ length: 200 }, (_, row) => ({
    t: 1,
    list: Array.from({ length: 4 }, (_, term) => `term-${row}-${term}`),
  }));
  let url = "https://example.test/";
  t.mock.method(globalThis, "fetch", async () => Response.json({
    data: [{ t: 1, list: [] }, ...rows, { t: 0, url, title: "Result" }],
  }));
  const flatMap = Array.prototype.flatMap;
  let flattenedRelatedRows = false;
  // Keep the result assertions behavior-based and detect the extra array separately.
  t.after(() => { Array.prototype.flatMap = flatMap; });
  Array.prototype.flatMap = new Proxy(flatMap, {
    apply(target, receiver, args) {
      if (Array.isArray(receiver) && receiver.length > rows.length && receiver[0]?.t === 1) {
        flattenedRelatedRows = true;
      }
      return Reflect.apply(target, receiver, args);
    },
  });
  const tool = registeredSearch();
  const retained = await tool.execute("test", { query: "query" }, undefined, undefined);
  assert.equal(retained.details.originalRelatedCount, 800);
  assert.equal(retained.details.relatedCount, 10);
  assert.equal(retained.details.truncated, true);
  assert.deepEqual(retained.content[0].text.match(/^- .+$/gm),
    [...rows[0].list, ...rows[1].list, ...rows[2].list.slice(0, 2)].map((term) => `- ${term}`));

  url += "x".repeat(2048);
  const omitted = await tool.execute("test", { query: "query" }, undefined, undefined);
  assert.equal(omitted.details.originalRelatedCount, 800);
  assert.equal(omitted.details.relatedCount, 0);
  assert.equal(omitted.details.resultCount, 0);
  assert.equal(omitted.details.truncated, true);
  assert.match(omitted.content[0].text, /^No results retained.*\n\n\[Search output truncated\.\]$/);
  assert.equal(flattenedRelatedRows, false, "related rows must not be flattened into a response-sized array");
});

test("registered search clips astral text at every cap without leaving a lone surrogate", async (t) => {
  const astral = (codeUnits: number) => "😀".repeat(codeUnits / 2 + 8);
  t.mock.method(globalThis, "fetch", async () => Response.json({
    data: [
      { t: 0, url: "https://example.com/a", title: astral(512), snippet: astral(2048) },
      { t: 1, list: [astral(128)] },
    ],
    meta: { id: astral(256), node: astral(256) },
  }));
  const result = await registeredSearch().execute("test", { query: astral(512), limit: 1 }, undefined, undefined);
  const loneHigh = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
  const text = result.content[0].text;
  assert.doesNotMatch(text, loneHigh);
  assert.doesNotMatch(JSON.stringify(result.details), /\\ud[89ab][0-9a-f]{2}/i);
  assert.equal(result.details.truncated, true);
  for (const [prefix, cap] of [["# Kagi search: ", 512], ["1. ", 512], ["   Snippet: ", 2048], ["- ", 128]] as const) {
    const line = text.split("\n").find(candidate => candidate.startsWith(prefix) && candidate.includes("😀"));
    assert.ok(line, prefix);
    const field = line.slice(prefix.length);
    assert.ok(field.endsWith("…") && field.length <= cap, prefix);
  }
  for (const key of ["id", "node"] as const) {
    const value = result.details.meta![key] as string;
    assert.doesNotMatch(value, loneHigh);
    assert.ok(value.endsWith("…") && value.length <= 256, key);
  }
  assert.doesNotMatch(result.details.query, loneHigh);
  assert.ok(result.details.query.length <= 512);
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

test("registered search counts only retained rows toward the result limit", async (t) => {
  const firstUsable = "https://example.com/first";
  const laterUsable = "https://example.com/later";
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [
    { t: 0, url: `https://example.com/${"x".repeat(2048)}`, title: "Oversized URL" },
    { t: 0, url: firstUsable, title: "First usable result" },
    { t: 0, url: laterUsable, title: "Later usable result" },
  ] }));
  const result = await registeredSearch().execute("test", { query: "query", limit: 1 }, undefined, undefined);
  assert.deepEqual(result.details.urls, [firstUsable]);
  assert.equal(result.details.resultCount, 1);
  assert.equal(result.details.originalResultCount, 3);
  assert.equal(result.details.truncated, true);
  assert.ok(result.content[0].text.includes(`1. First usable result\n   URL: ${firstUsable}`));
  assert.doesNotMatch(result.content[0].text, /Oversized URL|Later usable result/);
  assert.match(result.content[0].text, /\[Search output truncated\.\]$/);
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
  const result = await registeredSearch().execute("test", { query: "Q".repeat(8192), limit: 20 }, undefined, undefined);
  assert.ok(result.content[0].text.length < 32768);
  assert.ok(JSON.stringify(result.details).length < 32768);
  assert.ok(result.details.resultCount > 0 && result.details.resultCount < 20);
  assert.deepEqual(result.details.urls, rows.slice(0, result.details.resultCount).map(row => row.url));
  assert.equal(result.details.truncated, true);
  assert.doesNotMatch(JSON.stringify(result), /Q{513}/);
});

test("registered search reports when every result URL is too large", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ data: [{ t: 0, url: `https://example.com/${"u".repeat(2049)}`, title: "Title" }] }));
  const result = await registeredSearch().execute("test", { query: "query" }, undefined, undefined);
  assert.equal(result.details.resultCount, 0);
  assert.deepEqual(result.details.urls, []);
  assert.equal(result.details.originalResultCount, 1);
  assert.equal(result.details.truncated, true);
  assert.match(result.content[0].text, /No results retained.*output limits/);
  assert.doesNotMatch(result.content[0].text, /No results found/);
});

for (const field of ["title", "url", "truncated"] as const) {
  test(`malformed UTF-8 in successful Kagi ${field} publishes no results`, async (t) => {
    const prefix = field === "url" ? '{"data":[{"t":0,"title":"title","url":"https://example.com/' : '{"data":[{"t":0,"url":"https://example.com/","title":"';
    const bytes = Buffer.concat([Buffer.from(prefix), Buffer.from(field === "truncated" ? [0xe2, 0x82] : [0xff]),
      ...(field === "truncated" ? [] : [Buffer.from('"}]}')])]);
    t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
      start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); },
    })));
    await assert.rejects(searchKagi("query"), /UTF-8/);
    await assert.rejects(registeredSearch().execute("test", { query: "query" }, undefined, undefined), /UTF-8/);
  });
}

for (const phase of ["fetch", "reader"] as const) {
  test(`Kagi ${phase} failure has bounded credential-safe diagnostics`, async (t) => {
    const privateError = new Error("Authorization: Bot test-key " + "x".repeat(10000), { cause: new Error("test-key") });
    t.mock.method(globalThis, "fetch", async () => {
      if (phase === "fetch") throw privateError;
      return new Response(new ReadableStream({ start(controller) { controller.error(privateError); } }));
    });
    for (const run of [() => searchKagi("query"), () => registeredSearch().execute("test", { query: "query" }, undefined, undefined)]) {
      await assert.rejects(run(), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.cause, undefined);
        assert.ok(error.message.length < 150);
        assert.doesNotMatch(error.stack! + JSON.stringify(error), /test-key|Authorization/);
        assert.match(error.message, phase === "fetch" ? /transport/ : /read response/);
        return true;
      });
    }
  });
}

for (const cleanup of ["cancel throws", "cancel rejects", "release throws after EOF"] as const) {
  test(`searchKagi preserves the read outcome when ${cleanup}`, async (t) => {
    const bytes = new TextEncoder().encode(JSON.stringify(valid));
    let reads = 0;
    let cancellations = 0;
    let releases = 0;
    const reader = {
      async read() {
        if (cleanup !== "release throws after EOF") throw new Error("private read failure");
        if (++reads === 1) return { done: false, value: bytes };
        return { done: true, value: undefined };
      },
      cancel() {
        ++cancellations;
        if (cleanup === "cancel throws") throw new Error("private cancellation failure");
        return Promise.reject(new Error("private cancellation rejection"));
      },
      releaseLock() {
        ++releases;
        throw new Error("private release failure");
      },
    };
    t.mock.method(globalThis, "fetch", async () => ({
      ok: true, status: 200, headers: new Headers(), body: { getReader: () => reader },
    }));

    if (cleanup === "release throws after EOF") {
      assert.deepEqual(await searchKagi("query"), valid);
    } else {
      await assert.rejects(searchKagi("query"), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "Kagi API could not read response; please retry.");
        assert.equal(error.cause, undefined);
        return true;
      });
    }
    assert.equal(cancellations, 1);
    assert.equal(releases, 1);
  });
}

test("malformed UTF-8 HTTP error bodies retain status without body evidence", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(Buffer.concat([
    Buffer.from("proxy echoed test-key "), Buffer.from([0xff]),
  ]), { status: 502 }));
  await assert.rejects(searchKagi("query"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /HTTP 502; check Kagi service status/);
    assert.doesNotMatch(error.stack!, /test-key|proxy echoed/);
    return true;
  });
});

for (const body of [
  '{"data":[],"data":[]}',
  '{"data":[{"t":0,"url":"private-first","url":"private-last","title":"t"}]}',
  '{"data":[],"meta":{},"m\\u0065ta":{}}',
  '{"data":[],"meta":{"id":"x","id":"x"}}',
  '{"data":[],"extra":{"nested":{"x":1,"x":2}}}',
  '{"data":[],"extra":' + '['.repeat(64) + '0' + ']'.repeat(64) + '}',
  '{"data":[],"extra":[' + Array.from({ length: 16384 }, () => '{}').join(',') + ']}',
  '{"data":[],"extra":[' + '0,'.repeat(16384) + '0]}',
  '{"data":[],"extra":{' + Array.from({ length: 16383 }, (_, i) => `"k${i}":0`).join(',') + '}}',
  '{"data":[],"extra":{"x":[1e309]}}',
  '{"data":[{"t":0,"url":"https://example.com/","title":"t","published":-1e309}]}',
]) {
  test(`Kagi structural admission rejects ambiguous or excessive JSON (${body.length} chars, ${body.slice(0, 45)})`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => new Response(body));
    for (const run of [() => searchKagi("synthetic"), () => registeredSearch().execute("test", { query: "synthetic" }, undefined, undefined)]) {
      await assert.rejects(run(), error => {
        assert.equal((error as Error).message, "Kagi API response is not valid JSON.");
        return true;
      });
    }
  });
}

test("Kagi admits multibyte optional extensions at structural boundaries", async (t) => {
  let body = '{"data":[],"extra":' + '['.repeat(63) + '"Grüße 🦊"' + ']'.repeat(63) + '}';
  t.mock.method(globalThis, "fetch", async () => new Response(body));
  assert.deepEqual(await searchKagi("synthetic"), JSON.parse(body));
  body = '{"data":[],"extra":[' + Array.from({ length: 16381 }, () => '{}').join(',') + ']}';
  assert.deepEqual(await searchKagi("synthetic"), JSON.parse(body));
  body = '{"data":[],"extra":[' + '0,'.repeat(16383) + '0]}';
  assert.deepEqual(await searchKagi("synthetic"), JSON.parse(body));
  body = '{"data":[],"extra":{' + Array.from({ length: 16382 }, (_, i) => `"k${i}":0`).join(',') + '}}';
  assert.deepEqual(await searchKagi("synthetic"), JSON.parse(body));
});

for (const url of [
  "javascript:alert('private-url')", "data:text/plain,private-url", "file:///private-url", "ftp://example.com/private-url",
  "/private-url", "//example.com/private-url", "https:example.com/private-url", "not a private-url", "https://", "https://[invalid/private-url",
  "https://private-user:private-password@example.com/", "https://private-user@example.com/", "https://:private-password@example.com/",
]) {
  test(`Kagi refuses non-navigable or credential-bearing result ${url.split(":")[0]}`, async (t) => {
    let requests = 0;
    t.mock.method(globalThis, "fetch", async () => {
      requests++;
      return Response.json({ data: [valid.data[0], { t: 0, url, title: "synthetic" }] });
    });
    for (const run of [() => searchKagi("synthetic"), () => registeredSearch().execute("test", { query: "synthetic" }, undefined, undefined)]) {
      await assert.rejects(run, { message: "Kagi API response has invalid search data." });
    }
    assert.equal(requests, 2, "only the stubbed API is requested; no result is fetched");
  });
}

test("Kagi preserves navigable HTTP(S) Unicode hosts and query identity", async (t) => {
  const urls = ["https://bücher.example/Grüße?q=a%26b&x=%24%26#Kapitel", "http://example.com:8080/a?b=1", "HTTPS://EXAMPLE.COM/path"];
  const payload = { data: urls.map(url => ({ t: 0, url, title: "synthetic" })) };
  t.mock.method(globalThis, "fetch", async () => Response.json(payload));
  assert.deepEqual(await searchKagi("synthetic"), payload);
  const result = await registeredSearch().execute("test", { query: "synthetic" }, undefined, undefined);
  assert.deepEqual(result.details.urls, urls);
  for (const url of urls) assert.ok(result.content[0].text.includes(url));
});

test("HTTP error status is reported without reading a stalled or oversized error body", async (t) => {
  let pulls = 0;
  let cancelled = 0;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (pulls === 1) controller.enqueue(new Uint8Array(2 * 1024 * 1024));
      return new Promise(() => {});
    },
    cancel() { cancelled += 1; },
  }, { highWaterMark: 0 }), { status: 503 }));
  const started = Date.now();
  await assert.rejects(searchKagi("query"), {
    message: "Kagi API request failed with HTTP 503; check Kagi service status or API access and retry.",
  });
  assert.ok(Date.now() - started < 5_000);
  assert.equal(pulls, 0);
  assert.equal(cancelled, 1);
});

for (const status of [400, 429, 500]) {
  test(`searchKagi HTTP ${status} diagnostics exclude all upstream evidence`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => new Response(
      "private-query-sentinel https://example.test/?signed=private-signature unrelated-token test-key", { status },
    ));
    await assert.rejects(searchKagi("synthetic-query"), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, `Kagi API request failed with HTTP ${status}; check Kagi service status or API access and retry.`);
      assert.doesNotMatch(error.stack! + JSON.stringify(error), /private-query|private-signature|unrelated-token|test-key/);
      assert.equal(error.cause, undefined);
      return true;
    });
  });
}
