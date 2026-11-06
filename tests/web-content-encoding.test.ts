import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("excessive content encodings with an early close cannot crash the process", () => {
  const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/excessive-content-encoding.ts", import.meta.url))], {
    encoding: "utf8", timeout: 10_000,
  });
  assert.ifError(child.error);
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /controlled fetch error; process survived/);
});
