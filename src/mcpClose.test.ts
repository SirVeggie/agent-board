import assert from "node:assert/strict";
import { test } from "node:test";
import { pageClosePayload } from "./mcp.js";

test("pageClosePayload keeps closed/deleted ids and drops closedCount", () => {
  assert.deepEqual(pageClosePayload({ closed: ["t_a"], closedCount: 51 }), { closed: ["t_a"] });
  assert.deepEqual(pageClosePayload({ deleted: ["t_b"], closedCount: 51 }), { deleted: ["t_b"] });
  assert.deepEqual(pageClosePayload({ closed: ["t_1", "t_2"], deleted: ["t_3"], closedCount: 0 }), {
    closed: ["t_1", "t_2"],
    deleted: ["t_3"],
  });
  assert.deepEqual(pageClosePayload({ closedCount: 12, extra: true }), {});
});
