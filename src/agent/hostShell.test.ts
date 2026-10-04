import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import { clampTimeout, clipOutput, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, runCommand, shellFor } from "./hostShell.js";

test("shellFor: PowerShell on Windows, a POSIX shell elsewhere", () => {
  assert.equal(shellFor("echo hi", "win32").file, "powershell.exe");
  assert.deepEqual(shellFor("echo hi", "win32").args.slice(-2), ["-Command", "echo hi"]);
  assert.deepEqual(shellFor("echo hi", "linux").args, ["-c", "echo hi"]);
});

test("clipOutput keeps the start and the end", () => {
  assert.equal(clipOutput("short", 10), "short");
  const clipped = clipOutput("a".repeat(50) + "b".repeat(50), 20);
  assert.ok(clipped.startsWith("aaaaaa"));
  assert.ok(clipped.endsWith("b".repeat(14)));
  assert.match(clipped, /80 characters cut/);
});

test("clampTimeout falls back to the default and caps the maximum", () => {
  assert.equal(clampTimeout(undefined), DEFAULT_TIMEOUT_MS);
  assert.equal(clampTimeout(-5), DEFAULT_TIMEOUT_MS);
  assert.equal(clampTimeout(5000), 5000);
  assert.equal(clampTimeout(MAX_TIMEOUT_MS * 3), MAX_TIMEOUT_MS);
});

test("runCommand returns output and exit code", async () => {
  const ok = await runCommand({ command: "echo scribe-ok", cwd: os.tmpdir(), timeoutMs: 30_000 });
  assert.equal(ok.exitCode, 0);
  assert.match(ok.output, /scribe-ok/);
  const bad = await runCommand({ command: "exit 3", cwd: os.tmpdir(), timeoutMs: 30_000 });
  assert.equal(bad.exitCode, 3);
});

test("runCommand stops on the signal", async () => {
  const abort = new AbortController();
  const sleep = process.platform === "win32" ? "Start-Sleep -Seconds 20" : "sleep 20";
  const running = runCommand({ command: sleep, cwd: os.tmpdir(), timeoutMs: 30_000, signal: abort.signal });
  setTimeout(() => abort.abort(), 1500);
  const result = await running;
  assert.equal(result.cancelled, true);
  assert.notEqual(result.exitCode, 0);
});
