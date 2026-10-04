import assert from "node:assert/strict";
import test from "node:test";
import { isSdkAgentId, mapModels, modelSelection, toolLists, wantsHostShell } from "./providers/cursor.js";

const models = mapModels([
  {
    id: "composer-2",
    displayName: "Composer 2",
    parameters: [
      { id: "fast", displayName: "Fast", values: [{ value: "false" }, { value: "true" }] },
      { id: "reasoning_effort", values: [{ value: "low" }, { value: "medium" }, { value: "high", displayName: "High" }] },
    ],
    variants: [{ displayName: "default", isDefault: true, params: [{ id: "reasoning_effort", value: "medium" }, { id: "fast", value: "false" }] }],
  },
  { id: "gpt-5", displayName: "GPT-5" },
]);

test("mapModels takes the effort parameter and defaults from the default variant", () => {
  const [composer, gpt] = models;
  assert.equal(composer.effortParam, "reasoning_effort");
  assert.equal(composer.defaultEffort, "medium");
  assert.deepEqual(composer.efforts.map((e) => e.id), ["low", "medium", "high"]);
  assert.deepEqual(composer.params, [{ id: "fast", label: "Fast", options: [{ id: "false", label: "false" }, { id: "true", label: "true" }], default: "false" }]);
  assert.deepEqual(gpt.efforts, []);
  assert.equal(gpt.effortParam, undefined);
});

test("modelSelection passes only parameters the model takes", () => {
  assert.deepEqual(modelSelection({ model: "composer-2", effort: "high", modelParams: { fast: "true", context: "1m" } }, models), {
    id: "composer-2",
    params: [
      { id: "fast", value: "true" },
      { id: "reasoning_effort", value: "high" },
    ],
  });
  assert.deepEqual(modelSelection({ model: "composer-2", effort: "extreme", modelParams: { fast: "maybe" } }, models), { id: "composer-2" });
  assert.deepEqual(modelSelection({ model: "unknown-model", effort: "high", modelParams: {} }, models), { id: "unknown-model" });
  assert.deepEqual(modelSelection({ model: "default", effort: null, modelParams: {} }, models), { id: "composer-2" });
});

test("toolLists: Pages and Ask are allowlists, web off drops the web tools", () => {
  assert.deepEqual(toolLists({ mode: "code", web: "on" }), { disallowedTools: ["askQuestion"] });
  assert.deepEqual(toolLists({ mode: "code", web: "off" }), { disallowedTools: ["askQuestion", "webSearch", "webFetch", "fetch", "xSearch"] });
  assert.deepEqual(toolLists({ mode: "plan", web: "limited" }), { disallowedTools: ["askQuestion", "webSearch", "webFetch", "fetch", "xSearch"] });
  const board = toolLists({ mode: "board", web: "off" }).tools!;
  assert.ok(board.includes("mcp"));
  for (const tool of ["shell", "edit", "write", "delete", "webSearch", "webFetch", "task"]) assert.ok(!board.includes(tool), tool);
  assert.ok(toolLists({ mode: "board", web: "on" }).tools!.includes("webSearch"));
  const ask = toolLists({ mode: "ask", web: "off" }).tools!;
  assert.ok(ask.includes("read") && ask.includes("grep") && ask.includes("mcp"));
  for (const tool of ["shell", "edit", "write", "delete", "webFetch"]) assert.ok(!ask.includes(tool), tool);
});

test("isSdkAgentId tells SDK agents from old ACP sessions", () => {
  assert.equal(isSdkAgentId("agent-7f0c2b9e-1111-2222-3333-444455556666"), true);
  assert.equal(isSdkAgentId("0f8e7d6c-1111-2222-3333-444455556666"), false);
  assert.equal(isSdkAgentId(null), false);
});

test("host shell: only Code and Plan threads that ask, and it drops the built-in shell but keeps mcp", () => {
  assert.equal(wantsHostShell({ mode: "code", approval: "ask" }, true), true);
  assert.equal(wantsHostShell({ mode: "plan", approval: "edits" }, true), true);
  assert.equal(wantsHostShell({ mode: "code", approval: "ask" }, false), false);
  assert.equal(wantsHostShell({ mode: "code", approval: "auto" }, true), false);
  assert.equal(wantsHostShell({ mode: "code", approval: "full" }, true), false);
  assert.equal(wantsHostShell({ mode: "board", approval: "ask" }, true), false);
  assert.equal(wantsHostShell({ mode: "ask", approval: "ask" }, true), false);
  const lists = toolLists({ mode: "code", web: "on" }, true).disallowedTools!;
  assert.ok(lists.includes("shell"));
  assert.ok(!lists.includes("mcp"));
});
