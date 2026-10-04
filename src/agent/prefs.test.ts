import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_PREFS, prefsPatchFromChoices, settingPatch, workspaceKey } from "./prefs.js";

const grok = {
  provider: "cursor" as const,
  model: "cursor-grok-4.6",
  effort: "high",
  modelParams: { context: "1m", fast: "false" },
  mode: "code" as const,
  approval: "ask" as const,
  web: "limited" as const,
  scope: { kind: "global" as const, ref: null },
  cwd: "S:\\proj",
  useWorktree: true,
};

test("creating a thread remembers model, mode, and the rest, not only approval", () => {
  const patch = prefsPatchFromChoices(DEFAULT_PREFS, grok, settingPatch(grok));
  assert.equal(patch.provider, "cursor");
  assert.equal(patch.models?.cursor, "cursor-grok-4.6");
  assert.equal(patch.efforts?.cursor, "high");
  assert.deepEqual(patch.modelParams?.cursor, { context: "1m", fast: "false" });
  assert.equal(patch.mode, "code");
  assert.equal(patch.approval, "ask");
  assert.equal(patch.web, "limited");
  assert.equal(patch.recentWorkspaces?.[0], "S:\\proj");
  assert.equal(patch.worktrees?.[workspaceKey("S:\\proj")], true);
});

test("a page-scoped board thread does not overwrite the global mode default", () => {
  const page = { ...grok, mode: "board" as const, scope: { kind: "page" as const, ref: "t_1" } };
  const patch = prefsPatchFromChoices(DEFAULT_PREFS, page, settingPatch(page));
  assert.equal(patch.mode, undefined);
  assert.equal(patch.models?.cursor, "cursor-grok-4.6");
});

test("a model-only change still stores the provider so the next thread uses that model", () => {
  const patch = prefsPatchFromChoices(DEFAULT_PREFS, grok, { model: grok.model });
  assert.equal(patch.provider, "cursor");
  assert.equal(patch.models?.cursor, "cursor-grok-4.6");
  assert.equal(patch.mode, undefined);
});
