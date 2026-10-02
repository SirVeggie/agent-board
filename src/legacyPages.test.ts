import assert from "node:assert/strict";
import { test } from "node:test";
import { upgradeLegacyHtml } from "./legacyPages.js";

test("Agent Board page API names become Scribe's, and nothing else changes", () => {
  const old = `<button data-board-signal="done">Go</button><a data-board-open="notes" data-board-mode="peek"></a>
<script>board.bind(el, "notes"); board.set({ a: 1 }); if (window.board) board.onChange(render);
const x = { board: 1 }; x.board.set = 2; // a kanban board.
</script><style>.board-stale{}</style>`;
  const next = upgradeLegacyHtml(old);
  assert.equal(
    next,
    `<button data-scribe-signal="done">Go</button><a data-scribe-open="notes" data-scribe-mode="peek"></a>
<script>scribe.bind(el, "notes"); scribe.set({ a: 1 }); if (window.scribe) scribe.onChange(render);
const x = { board: 1 }; x.board.set = 2; // a kanban board.
</script><style>.scribe-stale{}</style>`
  );
  assert.equal(upgradeLegacyHtml(next), next);
});
