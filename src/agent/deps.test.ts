import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { dependencyDrift } from "./deps.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-deps-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

function lock(file: string, packages: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ lockfileVersion: 3, packages }));
}

test("dependencyDrift compares package-lock.json with node_modules' hidden lockfile", () => {
  assert.equal(dependencyDrift(root), null, "no lockfile: nothing to compare");
  lock(path.join(root, "package-lock.json"), {
    "": { name: "app" },
    "node_modules/a": { version: "1.0.0" },
    "node_modules/@scope/b": { version: "2.0.0" },
    "node_modules/a/node_modules/c": { version: "3.0.0" },
    "node_modules/win-only": { version: "1.0.0", optional: true, os: ["win32"] },
    "node_modules/local": { resolved: "packages/local", link: true },
  });
  assert.equal(dependencyDrift(root), null, "no node_modules: never installed");
  fs.mkdirSync(path.join(root, "node_modules"));
  assert.deepEqual(dependencyDrift(root), ["node_modules/.package-lock.json: missing"]);
  lock(path.join(root, "node_modules", ".package-lock.json"), {
    "node_modules/a": { version: "1.0.0" },
    "node_modules/@scope/b": { version: "1.9.0" },
  });
  assert.deepEqual(dependencyDrift(root), ["@scope/b@2.0.0 (installed 1.9.0)", "c: missing"]);
  lock(path.join(root, "node_modules", ".package-lock.json"), {
    "node_modules/a": { version: "1.0.0" },
    "node_modules/@scope/b": { version: "2.0.0" },
    "node_modules/a/node_modules/c": { version: "3.0.0" },
  });
  assert.deepEqual(dependencyDrift(root), []);
});
