import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);

test("CI runs the production audit with a high-severity failure threshold", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["audit:prod"], "npm audit --omit=dev --audit-level=high");
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /run: npm run audit:prod\s*\n/);
  assert.doesNotMatch(workflow, /continue-on-error/);
});

test("production audit fails when the scanner returns an error", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-audit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ["package.json", "package-lock.json"]) {
    copyFileSync(new URL(`../${name}`, import.meta.url), path.join(root, name));
  }
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests++;
    response.writeHead(503, { "content-type": "application/json" });
    response.end('{"error":"synthetic scanner unavailable"}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await assert.rejects(run("npm", ["run", "audit:prod", "--", `--registry=http://127.0.0.1:${address.port}`, "--fetch-retries=0"], {
    cwd: root, timeout: 15_000,
    env: { ...process.env, npm_config_cache: path.join(root, "cache") },
  }), (error: unknown) => {
    const failure = error as Error & { code: number; stdout: string; stderr: string };
    assert.equal(failure.code, 1);
    assert.match(failure.stdout + failure.stderr, /503|audit endpoint/);
    assert.ok(requests > 0, "the scanner was actually contacted");
    return true;
  });
});
