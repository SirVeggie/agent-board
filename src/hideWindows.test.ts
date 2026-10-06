import assert from "node:assert/strict";
import childProcess, { execFile, spawnSync } from "node:child_process";
import { test } from "node:test";
import { promisify } from "node:util";
import { hideByDefault, hideChildWindows } from "./hideWindows.js";

test("hideByDefault adds windowsHide where the options go", () => {
  const cb = () => undefined;
  assert.deepEqual(hideByDefault(["git", ["status"]], 2), ["git", ["status"], { windowsHide: true }]);
  assert.deepEqual(hideByDefault(["git", ["status"], { cwd: "x" }], 2), ["git", ["status"], { cwd: "x", windowsHide: true }]);
  assert.deepEqual(hideByDefault(["git", ["status"], cb], 2), ["git", ["status"], { windowsHide: true }, cb]);
  assert.deepEqual(hideByDefault(["git", ["status"], null, cb], 2), ["git", ["status"], { windowsHide: true }, cb]);
  assert.deepEqual(hideByDefault(["dir", cb], 1), ["dir", { windowsHide: true }, cb]);
});

test("hideByDefault leaves callers that decide alone", () => {
  assert.deepEqual(hideByDefault(["app", [], { windowsHide: false }], 2), ["app", [], { windowsHide: false }]);
  assert.deepEqual(hideByDefault(["app", [], { detached: true, stdio: "ignore" }], 2), ["app", [], { detached: true, stdio: "ignore" }]);
});

test("hideChildWindows keeps child_process working, promisified execFile included", { skip: process.platform !== "win32" }, async () => {
  hideChildWindows();
  hideChildWindows();
  assert.equal((childProcess.execFile as unknown as { scribeHidden?: boolean }).scribeHidden, true);
  assert.equal(execFile, childProcess.execFile, "named ESM imports see the wrapped function");
  const { stdout, stderr } = await promisify(childProcess.execFile)(process.execPath, ["-e", "process.stdout.write('ok')"]);
  assert.equal(stdout, "ok");
  assert.equal(stderr, "");
  const sync = spawnSync(process.execPath, null as unknown as string[], { input: "process.stdout.write('in')", encoding: "utf8" });
  assert.equal(sync.stdout, "in");
});
