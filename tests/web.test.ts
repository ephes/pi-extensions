import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { decodeHtml, expandXhtmlSelfClosingTags, extractTitle, extractReadableText, isBlockedIp, validateUrl } from "../shared/web.js";

test("isBlockedIp blocks private, loopback, and mapped IPv4 ranges", () => {
  const blocked = [
    "10.0.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "192.168.1.10",
    "172.16.0.1",
    "::",
    "::1",
    "fe80::1",
    "fd00::1",
    "ff02::1",
    "::ffff:10.0.0.1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "0:0:0:0:0:ffff:10.0.0.1",
    "0:0:0:0:0:ffff:7f00:1",
  ];

  for (const ip of blocked) {
    assert.equal(isBlockedIp(ip), true, `${ip} should be blocked`);
  }
});

test("isBlockedIp allows public addresses", () => {
  const allowed = [
    "1.1.1.1",
    "8.8.8.8",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
  ];

  for (const ip of allowed) {
    assert.equal(isBlockedIp(ip), false, `${ip} should be allowed`);
  }
});

test("isBlockedIp classifies equivalent IPv6 spellings consistently", () => {
  const groups = [
    { blocked: true, addresses: ["::1", "0:0:0:0:0:0:0:1", "0000:0000:0000:0000:0000:0000:0000:0001", "0::1"] },
    { blocked: true, addresses: ["::", "0:0:0:0:0:0:0:0", "0000::0000"] },
    { blocked: true, addresses: ["::ffff:127.0.0.1", "0:0:0:0:0:ffff:7f00:1", "0000:0000:0000:0000:0000:FFFF:7F00:0001", "0::ffff:7f00:1"] },
    { blocked: true, addresses: ["::ffff:192.168.1.1", "0000:0000:0000:0000:0000:ffff:c0a8:0101"] },
    { blocked: true, addresses: ["fe80::1", "FE80:0000:0000:0000:0000:0000:0000:0001", "fe80::1%eth0"] },
    { blocked: true, addresses: ["fd00::1", "FD00:0000:0000:0000:0000:0000:0000:0001", "ff02::1"] },
    { blocked: false, addresses: ["2606:4700:4700::1111", "2606:4700:4700:0000:0000:0000:0000:1111"] },
    { blocked: false, addresses: ["::ffff:8.8.8.8", "0000:0000:0000:0000:0000:FFFF:0808:0808"] },
  ];
  for (const { blocked, addresses } of groups) {
    for (const ip of addresses) assert.equal(isBlockedIp(ip), blocked, ip);
  }
});


const specialBlocked = [
  "fec0::1", "FEDF:0000:0000:0000:0000:0000:0000:0001", "feff::1",
  "64:ff9b::7f00:1", "0064:FF9B:0000:0000:0000:0000:0A00:0001",
  "64:ff9b::c0a8:101", "64:ff9b::a9fe:a9fe", "64:ff9b::ac10:1",
  "64:ff9b::6440:1", "64:ff9b::e000:1", "64:ff9b::", "64:ff9b::1",
  "64:ff9b:1::808:808", "0064:ff9b:0001:abcd:0000:0000:0000:0001",
];

test("special IPv6 policy covers site-local and translation ranges", () => {
  for (const ip of specialBlocked) assert.equal(isBlockedIp(ip), true, ip);
  for (const ip of ["64:ff9b::808:808", "0064:ff9b:0:0:0:0:0101:0101", "64:ff9b::ffff:ffff:ffff", "64:ff9b:2::1", "fe7f::1"]) {
    assert.equal(isBlockedIp(ip), false, ip);
  }
});

test("validateUrl rejects unsupported schemes and local targets", () => {
  assert.throws(() => validateUrl(new URL("ftp://example.com/file.txt")), /Unsupported URL scheme/);
  assert.throws(() => validateUrl(new URL("http://localhost/test")), /Blocked local hostname/);
  assert.throws(() => validateUrl(new URL("http://127.0.0.1/test")), /Blocked local hostname|Blocked private or local IP address/);
  assert.throws(() => validateUrl(new URL("http://192.168.1.15/test")), /Blocked private or local IP address/);
});

test("extractReadableText removes scripts and preserves readable text blocks", () => {
  const html = `
    <html>
      <head><title>Example</title><script>console.log("ignore");</script></head>
      <body>
        <article>
          <h1>Hello</h1>
          <p>World &amp; friends</p>
          <style>p { color: red; }</style>
        </article>
      </body>
    </html>
  `;

  const text = extractReadableText(html);
  assert.match(text, /Hello/);
  assert.match(text, /World & friends/);
  assert.doesNotMatch(text, /console\.log/);
  assert.doesNotMatch(text, /color: red/);
});

test("decodeHtml decodes supported entities", () => {
  assert.equal(decodeHtml("Tom &amp; Jerry &lt;3&nbsp;\"quoted\"&#39;"), 'Tom & Jerry <3 "quoted"\'');
});

// A local fixture stands in for approved public addresses; no external traffic.
import dns from "node:dns/promises";
import net from "node:net";
import http from "node:http";
import tls from "node:tls";
import undici, { Agent, type Response as UndiciResponse } from "undici";
import { fetchReadablePage } from "../shared/web.js";

async function fixture(t: TestContext, handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const connect = net.connect;
  const connections: string[] = [];
  t.mock.method(net, "connect", (options: net.TcpNetConnectOpts) => {
    assert.ok(options.lookup, "connection must use the approved resolver");
    const hostname = options.host!;
    connections.push(hostname);
    options.lookup(hostname, { all: true }, (error, addresses) => {
      assert.ifError(error);
      assert.deepEqual(addresses, [
        { address: "2606:4700:4700::1111", family: 6 },
        { address: "1.1.1.1", family: 4 },
      ]);
    });
    for (const family of [4, 6]) {
      options.lookup(hostname, { family }, (error, ip, actualFamily) => {
        assert.ifError(error);
        assert.equal(actualFamily, family);
        assert.equal(ip, family === 4 ? "1.1.1.1" : "2606:4700:4700::1111");
      });
    }
    return connect({ host: "127.0.0.1", port: address.port });
  });
  return connections;
}
const approved = [
  { address: "2606:4700:4700::1111", family: 6 },
  { address: "1.1.1.1", family: 4 },
];

for (const cleanup of ["reject", "stall", "throw"] as const) {
  for (const primary of ["success", "body-failure", "abort"] as const) {
    test(`dispatcher cleanup ${cleanup} preserves ${primary} within its budget`, async (t) => {
      const controller = new AbortController();
      t.mock.method(dns, "lookup", async () => approved);
      await fixture(t, (_request, response) => {
        response.writeHead(200, { "content-type": "text/plain" });
        if (primary === "success") response.end("safe content");
        else {
          response.write("partial body");
          setImmediate(() => {
            if (primary === "abort") controller.abort(new Error("controlled cancellation"));
            else response.destroy();
          });
        }
      });
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const destroy: (this: Agent, error: Error | null, callback: () => void) => void = Agent.prototype.destroy;
      let started!: () => void;
      const cleanupStarted = new Promise<void>(resolve => { started = resolve; });
      let rejectLate!: (reason: unknown) => void;
      let calls = 0;
      t.mock.method(Agent.prototype, "destroy", function (this: Agent) {
        calls++;
        // Close real fixture sockets, then substitute the lifecycle settlement.
        destroy.call(this, null, () => {});
        started();
        if (cleanup === "throw") throw new Error("private cleanup https://secret.example/token?signature=private");
        if (cleanup === "reject") return Promise.reject(new Error("private cleanup https://secret.example/token?signature=private"));
        return new Promise<void>((_resolve, reject) => { rejectLate = reject; });
      });
      let settled = false;
      let outcome: { page?: Awaited<ReturnType<typeof fetchReadablePage>>; error?: unknown } = {};
      const observed = fetchReadablePage("http://public.example/?signature=private", undefined, controller.signal).then(
        page => { outcome = { page }; settled = true; },
        error => { outcome = { error }; settled = true; },
      );
      await cleanupStarted;
      // Allow immediate rejection / cancellation to settle before the deadline.
      await new Promise<void>(resolve => setImmediate(resolve));
      if (primary === "abort") assert.equal(settled, true, "cancellation does not wait for cleanup");
      t.mock.timers.tick(100);
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(settled, true, "cleanup cannot stall the primary outcome");
      await observed;
      assert.equal(calls, 1);
      if (primary === "success") assert.equal(outcome.page?.content, "safe content");
      else {
        assert.ok(outcome.error instanceof Error);
        assert.match(outcome.error.message, primary === "abort" ? /controlled cancellation/ : /Unable to read response/);
        assert.doesNotMatch(outcome.error.message, /private|secret|signature/);
      }
      // A rejection after the cleanup deadline must also be consumed.
      rejectLate?.(new Error("late private cleanup rejection"));
      await new Promise<void>(resolve => setImmediate(resolve));
    });
  }
}

for (const cause of ["caller", "deadline"] as const) {
  for (const bodyOutcome of ["complete", "failed"] as const) {
    test(`dispatcher retirement observes ${cause} cancellation after a ${bodyOutcome} body`, async (t) => {
      t.mock.method(dns, "lookup", async () => approved);
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const body = bodyOutcome === "complete" ? "readable content" : new ReadableStream<Uint8Array>({
        pull(controller) { controller.error(new Error("private body failure")); },
      });
      t.mock.method(undici, "fetch", async () => new undici.Response(body, {
        headers: { "content-type": "text/plain" },
      }));

      let started!: () => void;
      const retirementStarted = new Promise<void>(resolve => { started = resolve; });
      let finishRetirement!: () => void;
      const retirement = new Promise<void>(resolve => { finishRetirement = resolve; });
      const destroy = t.mock.method(Agent.prototype, "destroy", () => {
        started();
        return retirement;
      });

      const controller = new AbortController();
      const reason = new Error("caller cancelled during dispatcher retirement");
      const outcome = fetchReadablePage("https://public.example/", undefined, controller.signal)
        .then(() => undefined, (error: unknown) => error);
      await retirementStarted;
      try {
        if (cause === "caller") controller.abort(reason);
        else t.mock.timers.tick(30_000);

        const error = await Promise.race([
          outcome,
          new Promise<undefined>(resolve => { setImmediate(() => resolve(undefined)); }),
        ]);
        assert.equal(destroy.mock.callCount(), 1);
        assert.ok(error instanceof Error, "fetch must reject before dispatcher retirement finishes");
        if (bodyOutcome === "failed") {
          assert.equal(error.message, "Unable to read response from https://public.example/; retry the request.");
        } else if (cause === "caller") {
          assert.equal(error, reason);
        } else {
          assert.match(error.message, /Web fetch timed out after 30 seconds/);
        }
      } finally {
        finishRetirement();
      }
    });
  }
}

test("fetch pins validated IPv4/IPv6 answers without another DNS lookup and preserves Host", async (t) => {
  let lookups = 0;
  t.mock.method(dns, "lookup", async () => ++lookups === 1 ? approved : [{ address: "127.0.0.1", family: 4 }]);
  const connections = await fixture(t, (request, response) => {
    assert.equal(request.headers.host, "public.example");
    response.end("<p>Pinned content</p>");
  });
  const page = await fetchReadablePage("http://public.example/");
  assert.equal(page.content, "Pinned content");
  assert.equal(lookups, 1);
  assert.deepEqual(connections, ["public.example"]);
});

test("redirects resolve and pin each new destination", async (t) => {
  const hosts: string[] = [];
  t.mock.method(dns, "lookup", async (hostname: string) => { hosts.push(hostname); return approved; });
  const connections = await fixture(t, (request, response) => {
    if (request.headers.host === "public.example") {
      response.writeHead(302, { location: "http://other.example/" });
      response.end();
    } else response.end("<p>Redirected</p>");
  });
  assert.equal((await fetchReadablePage("http://public.example/")).content, "Redirected");
  assert.deepEqual(hosts, ["public.example", "other.example"]);
  assert.deepEqual(connections, hosts);
});

test("redirect with any private fallback answer is rejected before connecting", async (t) => {
  t.mock.method(dns, "lookup", async (hostname: string) => hostname === "public.example" ? approved : [
    ...approved, { address: "::1", family: 6 },
  ]);
  const connections = await fixture(t, (_request, response) => {
    response.writeHead(302, { location: "http://private.example/" });
    response.end();
  });
  await assert.rejects(fetchReadablePage("http://public.example/"), /Blocked hostname/);
  assert.deepEqual(connections, ["public.example"]);
});

test("expanded loopback DNS answer is rejected before transport", async (t) => {
  t.mock.method(dns, "lookup", async () => [...approved, { address: "0:0:0:0:0:0:0:1", family: 6 }]);
  const connect = t.mock.method(net, "connect", () => { throw new Error("Unexpected connection"); });
  const tlsConnect = t.mock.method(tls, "connect", () => { throw new Error("Unexpected TLS connection"); });
  for (const scheme of ["http", "https"]) {
    await assert.rejects(fetchReadablePage(`${scheme}://public.example/`), /Blocked hostname/);
  }
  assert.equal(connect.mock.callCount(), 0);
  assert.equal(tlsConnect.mock.callCount(), 0);
});

test("IPv6 private literals are rejected before transport", async () => {
  for (const ip of ["::1", "fd00::1", "::ffff:127.0.0.1"]) {
    await assert.rejects(fetchReadablePage(`http://[${ip}]/`), /Blocked/);
  }
});


for (const ip of specialBlocked) {
  test(`special IPv6 ${ip} is rejected in literals and mixed DNS answers before transport`, async (t) => {
    t.mock.method(dns, "lookup", async () => [...approved, { address: ip, family: 6 }]);
    const connect = t.mock.method(net, "connect", () => { throw new Error("Unexpected connection"); });
    const tlsConnect = t.mock.method(tls, "connect", () => { throw new Error("Unexpected TLS connection"); });
    for (const scheme of ["http", "https"]) {
      await assert.rejects(fetchReadablePage(`${scheme}://[${ip}]/`), /Blocked/);
      await assert.rejects(fetchReadablePage(`${scheme}://public.example/`), /Blocked hostname/);
    }
    assert.equal(connect.mock.callCount(), 0);
    assert.equal(tlsConnect.mock.callCount(), 0);
  });
}

async function flushMicrotasks() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

test("total deadline bounds a never-resolving DNS lookup", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(dns, "lookup", () => new Promise(() => {}));
  const pending = fetchReadablePage("http://public.example/");
  const rejected = assert.rejects(pending, /timed out.*retry/);
  t.mock.timers.tick(29_999);
  await flushMicrotasks();
  t.mock.timers.tick(1);
  await rejected;
});

test("caller cancellation interrupts DNS immediately", async (t) => {
  t.mock.method(dns, "lookup", () => new Promise(() => {}));
  const controller = new AbortController();
  const pending = fetchReadablePage("http://public.example/", 20_000, controller.signal);
  const reason = new Error("Caller cancelled");
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
});

test("already cancelled caller does not start a deadline, resolve or connect", async (t) => {
  const setTimeout = t.mock.method(globalThis, "setTimeout");
  const lookup = t.mock.method(dns, "lookup", () => { throw new Error("Unexpected DNS"); });
  const fetch = t.mock.method(undici, "fetch", () => { throw new Error("Unexpected fetch"); });
  const reason = new Error("Cancelled before fetch");
  await assert.rejects(fetchReadablePage("http://public.example/", 20_000, AbortSignal.abort(reason)), (error) => error === reason);
  const defaultAbort = AbortSignal.abort();
  await assert.rejects(fetchReadablePage("http://public.example/", undefined, defaultAbort), (error) => error === defaultAbort.reason);
  assert.equal(setTimeout.mock.callCount(), 0);
  assert.equal(lookup.mock.callCount(), 0);
  assert.equal(fetch.mock.callCount(), 0);
});

for (const stage of ["headers", "body", "dripping body"] as const) {
  test(`total deadline interrupts stalled ${stage} and closes the connection`, async (t) => {
    t.mock.method(dns, "lookup", async () => approved);
    let ready!: () => void;
    const received = new Promise<void>((resolve) => { ready = resolve; });
    let closed!: Promise<void>;
    let reply!: http.ServerResponse;
    await fixture(t, (request, response) => {
      closed = new Promise<void>((resolve) => request.socket.once("close", resolve));
      reply = response;
      if (stage !== "headers") {
        response.writeHead(200, { "content-type": "text/html" });
        response.write("<p>Small first chunk</p>");
      }
      ready();
    });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const pending = fetchReadablePage("http://public.example/");
    const rejected = assert.rejects(pending, /timed out.*retry/);
    await received;
    // Let the real transport deliver headers/body before advancing its deadline.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (stage === "dripping body") {
      for (let i = 0; i < 3; i++) {
        reply.write("<p>Another small chunk</p>");
        await new Promise<void>((resolve) => setImmediate(resolve));
        t.mock.timers.tick(9_999);
      }
      t.mock.timers.tick(3);
    } else t.mock.timers.tick(30_000);
    await rejected;
    await closed;
  });
}

test("redirects share the original deadline", async (t) => {
  await fixture(t, (_request, response) => {
    t.mock.timers.tick(20_000);
    response.writeHead(302, { location: "http://other.example/" });
    response.end();
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const lookupReached = new Promise<void>((resolve) => {
    t.mock.method(dns, "lookup", async (hostname: string) => {
      if (hostname === "other.example") { resolve(); return new Promise(() => {}); }
      return approved;
    });
  });
  const pending = fetchReadablePage("http://public.example/");
  const rejected = assert.rejects(pending, /timed out.*retry/);
  await lookupReached;
  t.mock.timers.tick(10_000);
  await rejected;
});


test("HTTPS retains the original TLS server name with a pinned resolver", async (t) => {
  t.mock.method(dns, "lookup", async () => approved);
  let connected = false;
  const stop = new Error("Stop before a real TLS connection");
  t.mock.method(tls, "connect", (options: tls.ConnectionOptions) => {
    connected = true;
    assert.equal(options.servername, "public.example");
    assert.equal(options.host, "public.example");
    assert.ok(options.lookup);
    options.lookup("public.example", { all: true }, (error, records) => {
      assert.ifError(error);
      assert.deepEqual(records, approved);
    });
    throw stop;
  });
  await assert.rejects(fetchReadablePage("https://public.example/"), (error: unknown) => error instanceof Error && /Failed to fetch https:\/\/public.example/.test(error.message) && error.cause === undefined);
  assert.equal(connected, true);
});

test("HTML entities decode once in title and body extraction", () => {
  const encoded = "&amp;lt; &#x1F600; &#169; &copy; &euro; &NotEqualTilde; &nbsp; &lt;code&gt;";
  const expected = "&lt; 😀 © © € ≂̸ <code>";
  assert.equal(extractTitle(`<title>${encoded}</title>`), expected);
  assert.equal(extractReadableText(`<p>${encoded}</p>`), expected);
  assert.equal(decodeHtml("&amp;lt; &amp;#169;"), "&lt; &#169;");
});

test("malformed HTML references remain safe", () => {
  const malformed = "&unknown; &#xZZ; &#; &";
  assert.equal(decodeHtml(malformed), malformed);
  assert.equal(extractTitle(`<title>${malformed}</title>`), malformed);
  assert.equal(extractReadableText(`<p>${malformed}</p>`), malformed);
  assert.equal(decodeHtml("&#x110000; &#xD800; &#0;"), "� � �");
});

for (const { status, range } of [
  { status: 200 },
  { status: 206 },
  { status: 200, range: "bytes 0-3/12" },
  { status: 200, range: "" },
  { status: 203 },
]) {
  test(`readable representation admission for HTTP ${status}, Content-Range ${JSON.stringify(range)}`, async (t) => {
    t.mock.method(dns, "lookup", async () => approved);
    const headers = new undici.Headers({ "content-type": "text/plain" });
    if (range !== undefined) headers.set("content-range", range);
    let reads = 0;
    let cancellations = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads++;
        controller.enqueue(new TextEncoder().encode("page"));
        controller.close();
      },
      cancel() { cancellations++; },
    }, { highWaterMark: 0 });
    t.mock.method(undici, "fetch", async (...args: Parameters<typeof undici.fetch>) => {
      const [, options] = args;
      assert.equal(new undici.Headers(options?.headers).has("range"), false);
      return new undici.Response(body, { status, headers });
    });

    const page = fetchReadablePage("http://public.example/");
    if (status === 200 && range === undefined) {
      assert.equal((await page).content, "page");
      assert.equal(reads, 1);
      assert.equal(cancellations, 0);
    } else {
      await assert.rejects(page, { message: "Expected a complete HTTP 200 response without Content-Range." });
      assert.equal(reads, 0);
      assert.equal(cancellations, 1);
    }
  });
}

for (const contentType of ["text/html", "application/xhtml+xml; charset=UTF-8", "TEXT/HTML; charset=utf-8", undefined]) {
  test(`fetch extracts HTML for Content-Type ${contentType ?? "absent"}`, async (t) => {
    t.mock.method(dns, "lookup", async () => approved);
    await fixture(t, (_request, response) => {
      if (contentType) response.setHeader("content-type", contentType);
      response.end("<title>Example &amp; title</title><p>Hello &lt;world&gt;</p>");
    });
    const page = await fetchReadablePage("http://public.example/");
    assert.equal(page.title, "Example & title");
    assert.match(page.content, /Hello <world>/);
    assert.equal(page.truncated, false);
  });
}

test("web tool takes its heading from the parsed document head", async (t) => {
  t.mock.method(dns, "lookup", async () => approved);
  const decoys = '<!-- <title>Comment</title> --><script>const title = "<title>Script</title>";</script>';
  const body = "<body><p>Readable body</p><svg><title>Graphic</title></svg><title>Body title</title></body>";
  const html = [
    `<head>${decoys}<title>  Real &amp; title&nbsp;  here </title></head>${body}`,
    `<head>${decoys}</head>${body}`,
  ];
  const fetch = t.mock.method(undici, "fetch", async () => new undici.Response(html.shift(), {
    headers: { "content-type": "text/html" },
  }));
  const { default: extension } = await import("../extensions/web_content.js");
  type Result = { content: Array<{ text: string }>; details: { title?: string } };
  let execute!: (id: string, params: { url: string }) => Promise<Result>;
  extension({ registerTool(tool: { execute: typeof execute }) { execute = tool.execute; } } as never);

  for (const [title, heading] of [["Real & title here", "Real & title here"], [undefined, "Page content"]] as const) {
    const result = await execute("test", { url: "http://public.example/" });
    assert.equal(result.details.title, title);
    assert.equal(result.content[0].text.split("\n", 1)[0], `# ${heading}`);
    assert.match(result.content[0].text, /Readable body/);
  }
  assert.equal(fetch.mock.callCount(), 2);
});

test("fetch closes self-closing XHTML elements before HTML parsing", async (t) => {
  t.mock.method(dns, "lookup", async () => approved);
  const xhtml = '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>X</title><script src="a.js"/>'
    + '<style type="text/css" /></head><body><nav/><iframe src="b"/><p>Body <br/>text</p><textarea/>'
    + "<p>More</p></body></html>";
  await fixture(t, (_request, response) => {
    response.setHeader("content-type", "application/xhtml+xml");
    response.end(xhtml);
  });
  const page = await fetchReadablePage("http://public.example/");
  assert.equal(page.title, "X");
  assert.equal(page.content, "X\n\nBody\n\ntext\n\nMore");
});

test("fetch normalizes quoted XHTML tags and preserves literal CDATA", async (t) => {
  t.mock.method(dns, "lookup", async () => approved);
  const xhtml = '<head><title>Example</title><script data-test="a > b"/></head>'
    + '<body><p>After script</p><math xmlns="http://www.w3.org/1998/Math/MathML">'
    + '<mrow><![CDATA[literal <sample/> text]]></mrow></math></body>';
  const mediaTypes = ["application/xhtml+xml", "text/html"];
  t.mock.method(undici, "fetch", async () => new undici.Response(xhtml, {
    headers: { "content-type": mediaTypes.shift()! },
  }));

  const page = await fetchReadablePage("http://public.example/");
  assert.equal(page.title, "Example");
  assert.match(page.content, /After script/);
  assert.match(page.content, /literal <sample\/> text/);

  assert.equal((await fetchReadablePage("http://public.example/")).content, "Example");
});

test("XHTML self-closing expansion skips non-tag regions and quoted delimiters", () => {
  const unchanged = '<?example "<fake/>"?>'
    + '<!DOCTYPE html [<!-- ]> <fake/> --><!ENTITY sample "<fake/>">]>'
    + '<!-- a > b <fake/> --><![CDATA[<fake/>]]>'
    + '<p data-test="a > b /">Text</p>';
  assert.equal(
    expandXhtmlSelfClosingTags(unchanged + `<script data-test='a > b' src="x/"/>`),
    unchanged + `<script data-test='a > b' src="x/"></script>`,
  );
  const unfinished = '<!-- <fake/>';
  assert.equal(expandXhtmlSelfClosingTags(unfinished), unfinished);
});

test("XHTML self-closing expansion keeps void elements and stays linear", () => {
  assert.equal(expandXhtmlSelfClosingTags('<br/><IMG src="a"/><div class="x"/>'), '<br/><IMG src="a"/><div class="x"></div>');
  const started = performance.now();
  expandXhtmlSelfClosingTags("<a ".repeat(500_000));
  expandXhtmlSelfClosingTags("<a".repeat(500_000));
  assert.ok(performance.now() - started < 2_000);
});

for (const contentType of ["text/plain", "Text/Plain; charset=UTF-8"]) {
  test(`fetch preserves plain text verbatim for ${contentType}`, async (t) => {
    const text = "  2 < 3 and 4 > 1\n<title>literal</title> &amp; café\r\n";
    t.mock.method(dns, "lookup", async () => approved);
    await fixture(t, (_request, response) => {
      response.setHeader("content-type", contentType);
      response.end(text);
    });
    const page = await fetchReadablePage("http://public.example/");
    assert.equal(page.title, undefined);
    assert.equal(page.content, text);
    assert.equal(page.sourceTruncated, false);
    assert.equal(page.outputTruncated, false);
    assert.equal(page.truncated, false);
  });
}

for (const { contentType, mediaType, encoding } of [
  { contentType: 'text/plain; note="a; charset=utf-16le"; Charset="Windows-1252"', mediaType: "plain", encoding: "latin1" },
  { contentType: "text/html; charset=iso-8859-1", mediaType: "html", encoding: "latin1" },
  { contentType: "application/xhtml+xml; charset=utf-16le", mediaType: "html", encoding: "utf16le" },
  { contentType: "text/plain; charset=unsupported-encoding", mediaType: "plain", encoding: "utf8" },
  { contentType: "text/plain", mediaType: "plain", encoding: "utf8" },
  { contentType: undefined, mediaType: "html", encoding: "utf8" },
] as const) {
  test(`fetch decodes readable response charset for ${contentType ?? "absent Content-Type"}`, async (t) => {
    t.mock.method(dns, "lookup", async () => approved);
    const html = mediaType === "html";
    await fixture(t, (_request, response) => {
      if (contentType) response.setHeader("content-type", contentType);
      response.end(Buffer.from(html ? "<title>Café</title><p>Crème brûlée</p>" : "Crème brûlée", encoding));
    });
    const page = await fetchReadablePage("http://public.example/");
    assert.equal(page.title, html ? "Café" : undefined);
    assert.equal(page.content, html ? "Café\n\nCrème brûlée" : "Crème brûlée");
  });
}

for (const contentType of ["application/pdf", "image/png", "application/octet-stream", "application/json", ""]) {
  test(`fetch rejects unsupported Content-Type ${contentType || "empty"} before reading its body`, async (t) => {
    t.mock.method(dns, "lookup", async () => approved);
    let closed!: Promise<void>;
    await fixture(t, (request, response) => {
      closed = new Promise<void>((resolve) => request.socket.once("close", resolve));
      response.writeHead(200, { "content-type": contentType });
      response.flushHeaders(); // Never send a body: rejection must not wait for it.
    });
    await assert.rejects(fetchReadablePage("http://public.example/"), {
      message: "Unsupported response Content-Type; expected text/html, application/xhtml+xml or text/plain.",
    });
    await closed;
  });
}

test("unsupported response errors stay bounded for a long Content-Type", async (t) => {
  t.mock.method(dns, "lookup", async () => approved);
  await fixture(t, (_request, response) => {
    response.setHeader("content-type", `application/${"x".repeat(4000)}`);
    response.end("binary fixture");
  });
  await assert.rejects(fetchReadablePage("http://public.example/"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Unsupported response Content-Type/);
    assert.ok(error.message.length < 150);
    return true;
  });
});

for (const contentType of ["text/html", "text/plain"]) {
  for (const sourceTruncated of [false, true]) {
    for (const outputTruncated of [false, true]) {
      test(`${contentType} keeps independent source flags: source=${sourceTruncated}, shortOutput=${outputTruncated}`, async (t) => {
        const text = "x".repeat(sourceTruncated ? 2 * 1024 * 1024 + 1 : 2000);
        t.mock.method(dns, "lookup", async () => approved);
        await fixture(t, (_request, response) => {
          response.setHeader("content-type", contentType);
          response.end(text);
        });
        const maxChars = outputTruncated ? 1000 : 40000;
        const page = await fetchReadablePage("http://public.example/", maxChars);
        assert.equal(page.sourceTruncated, sourceTruncated);
        assert.equal(page.outputTruncated, sourceTruncated || outputTruncated);
        assert.equal(page.truncated, sourceTruncated || outputTruncated);
        assert.equal(page.content, text.slice(0, Math.min(maxChars, 2 * 1024 * 1024)));
      });
    }
  }
}

test("caller cancellation interrupts a stalled plain-text body", async (t) => {
  t.mock.method(dns, "lookup", async () => approved);
  const controller = new AbortController();
  let ready!: () => void;
  const received = new Promise<void>((resolve) => { ready = resolve; });
  await fixture(t, (_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("2 < 3 and 4 > 1");
    ready();
  });
  const pending = fetchReadablePage("http://public.example/", 20_000, controller.signal);
  const reason = new Error("Caller cancelled plain text");
  const rejected = assert.rejects(pending, (error) => error === reason);
  await received;
  controller.abort(reason);
  await rejected;
});

for (const overLimit of [false, true]) {
  test(`web body bounds consecutive empty reads (over limit=${overLimit})`, async (t) => {
    t.mock.method(dns, "lookup", async () => approved);
    const empty = new Uint8Array();
    const chunks = [Uint8Array.of(65), ...Array<Uint8Array>(256).fill(empty), Uint8Array.of(66),
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
    t.mock.method(undici, "fetch", async () => ({
      ok: true, status: 200, headers: new Headers({ "content-type": "text/plain" }),
      body: { getReader: () => reader },
    }));

    const pending = fetchReadablePage("https://public.example/");
    if (overLimit) {
      await assert.rejects(pending, { message: "Response body exceeded the consecutive empty-read limit; retry the request." });
      assert.equal(reads, 2 + 256 + 257);
    } else {
      const page = await pending;
      assert.equal(page.content, "AB");
      assert.equal(page.truncated, false);
      assert.equal(reads, chunks.length + 1);
    }
    assert.equal(cancel.mock.callCount(), overLimit ? 1 : 0);
    assert.equal(release.mock.callCount(), 1);
  });
}

for (const size of [2 * 1024 * 1024 - 1, 2 * 1024 * 1024, 2 * 1024 * 1024 + 1]) {
  test(`source truncation reports omitted bytes at size ${size}`, async (t) => {
    t.mock.method(dns, "lookup", async () => approved);
    const body = "A".repeat(size);
    await fixture(t, (_request, response) => {
      response.setHeader("content-type", "text/plain");
      response.write(body.slice(0, 17));
      response.end(body.slice(17));
    });
    const page = await fetchReadablePage("http://public.example/", 3 * 1024 * 1024);
    assert.equal(page.sourceTruncated, size > 2 * 1024 * 1024);
    assert.equal(page.outputTruncated, true);
    assert.equal(page.truncated, true);
    assert.equal(page.content, body.slice(0, 40000));
  });
}

for (const { ending, expected, sourceTruncated } of [
  { ending: "complete", expected: "Prefix🙂", sourceTruncated: false },
  { ending: "cutoff", expected: "Prefix", sourceTruncated: true },
  { ending: "incomplete at EOF", expected: "Prefix�", sourceTruncated: false },
]) {
  test(`readable UTF-8 with ${ending}`, async (t) => {
    t.mock.method(dns, "lookup", async () => approved);
    const encoder = new TextEncoder();
    const prefix = encoder.encode("Prefix");
    const scalar = encoder.encode("🙂");
    const firstHalf = scalar.subarray(0, 2);
    const fillerBytes = 2 * 1024 * 1024 - prefix.length - firstHalf.length;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (ending !== "complete") {
          // Discard the padding during HTML extraction so the output cap cannot hide the last character.
          controller.enqueue(encoder.encode(`<!--${"x".repeat(fillerBytes - 7)}-->`));
        }
        controller.enqueue(prefix);
        controller.enqueue(firstHalf);
        if (ending !== "incomplete at EOF") controller.enqueue(scalar.subarray(2));
        controller.close();
      },
    });
    t.mock.method(undici, "fetch", async () => new undici.Response(body, {
      headers: { "content-type": "text/html" },
    }));

    const page = await fetchReadablePage("http://public.example/");
    assert.equal(page.content, expected);
    assert.equal(page.sourceTruncated, sourceTruncated);
    assert.equal(page.outputTruncated, false);
    assert.equal(page.truncated, sourceTruncated);
  });
}

for (const cancel of [false, true]) {
  test(`post-cap EOF probe remains bounded (caller cancel=${cancel})`, async (t) => {
    t.mock.method(dns, "lookup", async () => approved);
    let decoded!: () => void;
    const reachedCap = new Promise<void>((resolve) => { decoded = resolve; });
    const decode = TextDecoder.prototype.decode;
    let decodedBytes = 0;
    t.mock.method(TextDecoder.prototype, "decode", function(this: TextDecoder, ...args: Parameters<typeof decode>) {
      const text = decode.apply(this, args);
      decodedBytes += args[0]?.byteLength ?? 0;
      if (decodedBytes === 2 * 1024 * 1024) decoded();
      return text;
    });
    let closed!: Promise<void>;
    await fixture(t, (request, response) => {
      closed = new Promise<void>((resolve) => request.socket.once("close", resolve));
      response.setHeader("content-type", "text/plain");
      response.write("A".repeat(2 * 1024 * 1024));
    });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const controller = new AbortController();
    const pending = fetchReadablePage("http://public.example/", 3 * 1024 * 1024, controller.signal);
    const rejection = assert.rejects(pending, cancel ? /cancelled/ : /timed out/);
    // Observe consumption at the decoder boundary, not merely a server write.
    await reachedCap;
    if (cancel) controller.abort(new Error("caller cancelled"));
    else t.mock.timers.tick(30_000);
    await rejection;
    await closed;
  });
}

for (const outcome of ["http", "empty", "redirect-missing", "redirect-limit", "transport", "body", "credentials", "invalid-redirect"] as const) {
  test(`signed initial and redirected URLs stay out of ${outcome} errors`, async (t) => {
    t.mock.method(dns, "lookup", async () => approved);
    const paths: string[] = [];
    await fixture(t, (request, response) => {
      paths.push(request.url!);
      if (paths.length === 1) {
        response.writeHead(302, { location: "http://other.example/final?redirect-signature=hidden#redirect-fragment" });
      } else if (outcome === "credentials") response.writeHead(302, { location: "http://redirect-user:redirect-password@other.example/final?signed-secret=hidden#fragment" });
      else if (outcome === "invalid-redirect") response.writeHead(302, { location: "http://redirect-user:redirect-password@[invalid?signed-secret=hidden#fragment" });
      else if (outcome === "body") {
        response.writeHead(200, { "content-type": "text/plain", "content-length": 100 });
        response.write("hello");
        setImmediate(() => response.destroy());
        return;
      } else if (outcome === "http") response.writeHead(403);
      else if (outcome === "redirect-missing") response.writeHead(302);
      else if (outcome === "redirect-limit") response.writeHead(302, { location: "/final?redirect-signature=hidden#redirect-fragment" });
      else if (outcome === "transport") { request.socket.destroy(); return; }
      response.end();
    });
    await assert.rejects(fetchReadablePage("http://public.example/start?signature=secret%2Bvalue#initial-fragment"), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.stack! + JSON.stringify(error), /signature|secret|hidden|fragment|redirect-user|redirect-password/);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(paths[0], "/start?signature=secret%2Bvalue");
    assert.equal(paths[1], "/final?redirect-signature=hidden");
  });
}

test("web tool keeps signed transport and final state while displaying a safe URL", async (t) => {
  t.mock.method(dns, "lookup", async () => approved);
  const requests: string[] = [];
  await fixture(t, (request, response) => {
    requests.push(request.url!);
    response.setHeader("content-type", "text/plain");
    response.end("Synthetic document body");
  });
  const { default: extension } = await import("../extensions/web_content.js");
  type Result = { content: Array<{ text: string }>; details: { url: string } };
  let execute!: (id: string, params: unknown, signal: undefined, onUpdate: (result: Result) => void) => Promise<Result>;
  extension({ registerTool(tool: { execute: typeof execute }) { execute = tool.execute; } } as never);
  const url = "http://public.example/document?signature=exact%2Bbytes&key=synthetic#fragment";
  const updates: Result[] = [];
  const result = await execute("test", { url }, undefined, (update) => updates.push(update));
  assert.deepEqual(requests, ["/document?signature=exact%2Bbytes&key=synthetic"]);
  assert.equal(result.details.url, url);
  assert.equal(result.content[0].text, "# Page content\n\nURL: http://public.example/document\n\nSynthetic document body");
  assert.doesNotMatch(JSON.stringify(updates), /signature|exact|synthetic|fragment/);
});

test("invalid input URLs produce controlled diagnostics without raw input", async () => {
  await assert.rejects(fetchReadablePage("http://user:password@[invalid?secret#fragment"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "Invalid web URL.");
    assert.doesNotMatch(JSON.stringify(error), /password|secret|fragment/);
    return true;
  });
});

test("shared and registered readable output limits use one finite integer policy", async (t) => {
  t.mock.method(dns, "lookup", async () => approved);
  await fixture(t, (_request, response) => { response.setHeader("content-type", "text/plain"); response.end("x".repeat(45000)); });
  const { default: extension } = await import("../extensions/web_content.js");
  let tool!: { execute(id: string, params: unknown, signal: undefined, update: (value: unknown) => void): Promise<{ details: { charCount: number; outputTruncated: boolean } }> };
  extension({ registerTool(value: typeof tool) { tool = value; } } as never);
  for (const [limit, expected] of [[NaN, 12000], [undefined, 12000], [Infinity, 12000], [-Infinity, 12000], [-5, 1000], [1001.9, 1001], [2500, 2500], [100000, 40000]] as const) {
    const page = await fetchReadablePage("http://public.example/", limit);
    assert.equal(page.content.length, expected, `shared ${limit}`);
    assert.equal(page.outputTruncated, true);
    assert.equal(page.sourceTruncated, false);
    const result = await tool.execute("test", { url: "http://public.example/", maxChars: limit }, undefined, () => {});
    assert.equal(result.details.charCount, expected, `tool ${limit}`);
    assert.equal(result.details.outputTruncated, true);
  }
});

for (const cleanup of ["success", "reject", "throw"] as const) {
  for (const cause of ["caller", "deadline"] as const) {
    test(`late fetch response body is cancelled once after ${cause}, cleanup ${cleanup} preserves primary error`, async (t) => {
      t.mock.method(dns, "lookup", async () => approved);
      t.mock.timers.enable({ apis: ["setTimeout"] });
      let deliver!: (response: UndiciResponse) => void;
      let entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      t.mock.method(undici, "fetch", () => {
        entered();
        return new Promise<UndiciResponse>(resolve => { deliver = resolve; });
      });
      let destroyed = 0;
      t.mock.method(Agent.prototype, "destroy", () => {
        destroyed++;
        return Promise.reject(new Error("private destroy evidence"));
      });
      const controller = new AbortController();
      const reason = new Error("synthetic caller cancellation");
      const run = fetchReadablePage("https://public.example/", undefined, controller.signal);
      const rejected = assert.rejects(run, error => cause === "caller" ? error === reason : error instanceof Error && /timed out/.test(error.message));
      await started;
      if (cause === "caller") controller.abort(reason);
      else t.mock.timers.tick(30000);
      await rejected;
      assert.equal(destroyed, 1);
      let cancelled = 0;
      const body = { cancel() {
        cancelled++;
        if (cleanup === "throw") throw new Error("private cancellation evidence");
        return cleanup === "reject" ? Promise.reject(new Error("private cancellation evidence")) : Promise.resolve();
      } };
      deliver({ body } as UndiciResponse);
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(cancelled, 1);
      assert.equal(destroyed, 1);
    });
  }
}
