import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { decodeHtml, extractReadableText, isBlockedIp, validateUrl } from "../shared/web.js";

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

test("IPv6 private literals are rejected before transport", async () => {
  for (const ip of ["::1", "fd00::1", "::ffff:127.0.0.1"]) {
    await assert.rejects(fetchReadablePage(`http://[${ip}]/`), /Blocked/);
  }
});

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

test("already cancelled caller does not resolve or connect", async (t) => {
  const lookup = t.mock.method(dns, "lookup", () => { throw new Error("Unexpected DNS"); });
  const reason = new Error("Cancelled before fetch");
  await assert.rejects(fetchReadablePage("http://public.example/", 20_000, AbortSignal.abort(reason)), (error) => error === reason);
  assert.equal(lookup.mock.callCount(), 0);
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
  await assert.rejects(fetchReadablePage("https://public.example/"), (error: unknown) => error instanceof Error && error.cause === stop);
  assert.equal(connected, true);
});
