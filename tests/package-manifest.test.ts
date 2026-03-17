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
