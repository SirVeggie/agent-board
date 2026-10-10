import assert from "node:assert/strict";
import { test } from "node:test";
import { grantRows, revokeGrant } from "./grants.js";
import type { Thread } from "./types.js";

type T = Pick<Thread, "cwd" | "worktree" | "scope" | "webGrants" | "threadGrants" | "helpersAllowed">;

const thread = (over: Partial<T> = {}): T => ({ cwd: null, worktree: null, scope: { kind: "page", ref: "p_a" }, ...over });

test("grantRows lists web grants, then the thread scopes still in effect", () => {
  const t = thread({
    webGrants: { all: true, domains: ["example.com"] },
    threadGrants: [{ kind: "page", id: "p_a" }, { kind: "page", id: "p_gone" }],
  });
  assert.deepEqual(grantRows(t, { pageFolder: () => null, folderInside: () => false, pageTitle: () => "Todo" }), [
    { kind: "web", key: "web:*", label: "Any website" },
    { kind: "web", key: "web:example.com", label: "example.com" },
    { kind: "threads", key: "threads:page:p_a", label: 'Threads on page "Todo"' },
  ]);
  assert.deepEqual(grantRows(thread()), []);
});

test("revokeGrant drops only the named grant", () => {
  const t = thread({ webGrants: { all: true, domains: ["a.com", "b.com"] }, threadGrants: [{ kind: "page", id: "p_a" }] });
  assert.deepEqual(revokeGrant(t, "web:*"), { webGrants: { all: false, domains: ["a.com", "b.com"] }, threadGrants: t.threadGrants });
  assert.deepEqual(revokeGrant(t, "web:a.com")?.webGrants, { all: true, domains: ["b.com"] });
  assert.deepEqual(revokeGrant(t, "threads:page:p_a")?.threadGrants, []);
  assert.equal(revokeGrant(t, "web:c.com"), null);
  assert.equal(revokeGrant(t, "threads:all"), null);
});

test("starting helpers unasked is a grant the user can take back", () => {
  const t = thread({ helpersAllowed: true, webGrants: { all: false, domains: ["a.com"] } });
  assert.deepEqual(grantRows(t).at(-1), { kind: "helpers", key: "helpers", label: "Start helpers without asking" });
  assert.deepEqual(revokeGrant(t, "helpers"), { webGrants: t.webGrants, threadGrants: undefined, helpersAllowed: false });
  assert.equal(revokeGrant(thread(), "helpers"), null);
});
