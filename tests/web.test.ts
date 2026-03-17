import test from "node:test";
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
