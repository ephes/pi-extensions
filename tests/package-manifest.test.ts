import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface PiPackageManifest {
  pi?: {
    extensions?: string[];
    prompts?: string[];
  };
}

test("package manifest registers the conventional extensions directory for installed Pi discovery", () => {
  const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as PiPackageManifest;

  assert.deepEqual(pkg.pi?.extensions, ["./extensions"]);
  assert.deepEqual(pkg.pi?.prompts, ["./prompts"]);
});

// Keep the supported host and the development registration baseline aligned.
test("SDK baseline uses the maintained patched namespace", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  for (const name of ["pi-ai", "pi-coding-agent", "pi-tui"]) {
    const maintained = `@earendil-works/${name}`;
    assert.equal(pkg.peerDependencies[maintained], "^1.5.0");
    assert.equal(pkg.devDependencies[maintained], "^1.5.0");
    assert.ok(lock.packages[`node_modules/${maintained}`]);
  }
  assert.equal(pkg.peerDependencies.typebox, "^1.3.27");
  assert.equal(pkg.devDependencies.typebox, "^1.3.27");
  assert.ok(!Object.keys(lock.packages).some((name) => name.includes("node_modules/@mariozechner/pi-")));
});
