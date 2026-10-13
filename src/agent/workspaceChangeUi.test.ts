import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8");
const start = source.indexOf("    async setWorkspace(dir) {");
const end = source.indexOf("    async pickOtherWorkspace()", start);

test("workspace changes require confirmation and successful worktree cleanup", async () => {
  for (const scenario of ["cancel", "running", "failed", "change", "ordinary"]) {
    const calls: string[] = [];
    const thread = { id: "thread", status: scenario === "running" ? "running" : "idle" };
    const context = {
      dirKey: (dir: string) => dir,
      openWorktree: () => scenario === "ordinary" ? null : { branch: "agent/work" },
      notice: () => {},
      app: () => ({ confirm: async (warning: string) => {
        calls.push("confirm");
        assert.match(warning, /discards uncommitted changes/);
        return scenario !== "cancel";
      } }),
      api: async (_method: string, _url: string, body: { action: string }) => {
        calls.push(body.action);
        if (scenario === "failed") throw new Error("Cleanup failed");
        return { message: "Discarded" };
      },
    };
    const view = vm.runInNewContext(`({${source.slice(start, end)}})`, context);
    view.settings = () => ({ cwd: "old", scope: { kind: "workspace", ref: "old" } });
    view.thread = () => thread;
    view.updateSettings = async (patch: { cwd: string; scope: { ref: string } }) => {
      calls.push("update");
      assert.equal(patch.cwd, "new");
      assert.equal(patch.scope.ref, "new");
    };
    await view.setWorkspace("new");
    assert.deepEqual(calls, scenario === "cancel" ? ["confirm"]
      : scenario === "running" ? []
      : scenario === "failed" ? ["confirm", "discard"]
      : scenario === "ordinary" ? ["update"] : ["confirm", "discard", "update"]);
  }
});
