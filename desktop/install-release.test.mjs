import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { installRelease } from "./install-release.mjs";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-install-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const built = path.join(dir, "custom-cargo-target", "release", "scribe.exe");
  const installed = path.join(dir, "app", "scribe.exe");
  fs.mkdirSync(path.dirname(built), { recursive: true });
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.writeFileSync(built, "new executable");
  fs.writeFileSync(installed, "previous executable");
  const events = [];
  return { dir, built, installed, events, runningApps: () => [installed],
    stop: () => events.push("stop"), restart: async (app, recovery) => events.push({ app, recovery }) };
}

test("stages output from a custom Cargo directory before stopping and restarts the installed app", async (t) => {
  const f = fixture(t);
  await installRelease({ ...f, stop: () => {
    assert.equal(fs.readFileSync(f.installed, "utf8"), "previous executable");
    const stage = fs.readdirSync(path.dirname(f.installed)).find((name) => name.startsWith(".scribe-install-"));
    assert.equal(fs.readFileSync(path.join(path.dirname(f.installed), stage, "new.exe"), "utf8"), "new executable");
    f.events.push("stop");
  } });
  assert.equal(fs.readFileSync(f.installed, "utf8"), "new executable");
  assert.deepEqual(f.events, ["stop", { app: f.installed, recovery: false }]);
  assert.deepEqual(fs.readdirSync(path.dirname(f.installed)), ["scribe.exe"]);
});

test("missing build output leaves the running app and installed executable alone", async (t) => {
  const f = fixture(t);
  fs.unlinkSync(f.built);
  await assert.rejects(installRelease(f), { code: "ENOENT" });
  assert.deepEqual(f.events, []);
  assert.equal(fs.readFileSync(f.installed, "utf8"), "previous executable");
});

test("failed replacement restores the installed executable and restarts the actual previous app path", async (t) => {
  const f = fixture(t);
  const previousApp = path.join(f.dir, "older-install", "board.exe");
  const io = { ...fs, renameSync(from, to) {
    if (path.basename(from) === "new.exe") throw new Error("replacement denied");
    fs.renameSync(from, to);
  } };
  await assert.rejects(installRelease({ ...f, io, runningApps: () => [previousApp] }), /replacement denied/);
  assert.equal(fs.readFileSync(f.installed, "utf8"), "previous executable");
  assert.deepEqual(f.events, ["stop", { app: previousApp, recovery: true }]);
  assert.deepEqual(fs.readdirSync(path.dirname(f.installed)), ["scribe.exe"]);
});

test("partial shutdown failure attempts to recover the previously running apps", async (t) => {
  const f = fixture(t);
  await assert.rejects(installRelease({ ...f, stop: () => { throw new Error("shutdown failed"); } }), /shutdown failed/);
  assert.deepEqual(f.events, [{ app: f.installed, recovery: true }]);
  assert.equal(fs.readFileSync(f.installed, "utf8"), "previous executable");
});

test("an install with no running app does not close or launch anything", async (t) => {
  const f = fixture(t);
  await installRelease({ ...f, runningApps: () => [] });
  assert.deepEqual(f.events, []);
  assert.equal(fs.readFileSync(f.installed, "utf8"), "new executable");
});

test("recovery launch failure is reported alongside the replacement error", async (t) => {
  const f = fixture(t);
  const io = { ...fs, renameSync() { throw new Error("executable locked"); } };
  await assert.rejects(installRelease({ ...f, io, restart: async () => { throw new Error("launch denied"); } }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors.map((item) => item.message), ["executable locked", "launch denied"]);
    return true;
  });
  assert.equal(fs.readFileSync(f.installed, "utf8"), "previous executable");
});

test("failed rollback preserves the backup and reports its location", async (t) => {
  const f = fixture(t);
  const io = { ...fs, renameSync(from, to) {
    if (["new.exe", "previous.exe"].includes(path.basename(from))) throw new Error("rename denied");
    fs.renameSync(from, to);
  } };
  await assert.rejects(installRelease({ ...f, io }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.errors[1].message, /saved at/);
    return true;
  });
  const stage = fs.readdirSync(path.dirname(f.installed)).find((name) => name.startsWith(".scribe-install-"));
  assert.equal(fs.readFileSync(path.join(path.dirname(f.installed), stage, "previous.exe"), "utf8"), "previous executable");
  assert.deepEqual(f.events, ["stop"]);
});
