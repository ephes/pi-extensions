import assert from "node:assert/strict";
import dns from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import { mock } from "node:test";
import { fetchReadablePage } from "../../shared/web.js";

// Exercise the real fetch path in a child: the vulnerable version raises an
// unhandled stream error after fetch has already rejected.
const server = http.createServer((_request, response) => {
  response.writeHead(200, {
    "content-encoding": Array(6).fill("gzip").join(", "),
    "content-length": "100",
  });
  response.flushHeaders();
  response.socket!.end(); // Close before the promised body arrives.
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
const connect = net.connect;
mock.method(dns, "lookup", async () => [{ address: "1.1.1.1", family: 4 }]);
mock.method(net, "connect", () => connect({ host: "127.0.0.1", port: address.port }));
try {
  await assert.rejects(fetchReadablePage("http://public.example/"), /fetch failed/);
  // Keep the process alive long enough to observe a late unhandled error.
  await new Promise((resolve) => setTimeout(resolve, 50));
  console.log("controlled fetch error; process survived");
} finally {
  mock.restoreAll();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
