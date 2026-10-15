import assert from "node:assert/strict";
import { test } from "node:test";
import { mentionAt } from "./mention.js";
import fs from "node:fs";
import vm from "node:vm";

test("mentionAt finds @ after start or whitespace", () => {
  assert.deepEqual(mentionAt("@", 1), { start: 0, end: 1, query: "" });
  assert.deepEqual(mentionAt("@todo", 5), { start: 0, end: 5, query: "todo" });
  assert.deepEqual(mentionAt("see @todo now", 9), { start: 4, end: 9, query: "todo" });
  assert.equal(mentionAt("user@host", 9), null);
  assert.equal(mentionAt("see todo", 8), null);
});

test("mentionAt uses the prefix before the caret and replaces the whole token", () => {
  assert.deepEqual(mentionAt("@foobar", 4), { start: 0, end: 7, query: "foo" });
  assert.deepEqual(mentionAt("a @x b", 4), { start: 2, end: 4, query: "x" });
});

test("# finds thread references without treating embedded hashes or @ as thread tags", () => {
  assert.deepEqual(mentionAt("#", 1, "#"), { start: 0, end: 1, query: "" });
  assert.deepEqual(mentionAt("see #foobar next", 8, "#"), { start: 4, end: 11, query: "foo" });
  assert.equal(mentionAt("url#fragment", 12, "#"), null);
  assert.equal(mentionAt("@todo", 5, "#"), null);
});

test("the composer searches # threads and replaces the selected token with a context chip", async () => {
  const source = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8");
  const load = source.slice(source.indexOf("    async loadMentions("), source.indexOf("    localFolderMentions("));
  const pick = source.slice(source.indexOf("    pickMention("), source.indexOf("    async stop()"));
  const key = source.slice(source.indexOf("  function chipKey("), source.indexOf("  function chipIcon("));
  const methods = vm.runInNewContext(`${key}\n({${load}, ${pick}})`, {
    MENTION_LIMIT: 32,
    api: async (method: string, route: string) => {
      assert.equal(method, "GET");
      assert.equal(route, "/threads");
      return { threads: [
        { id: "self", title: "Thread work" },
        { id: "taken", title: "Thread taken" },
        { id: "target", title: "Thread to read" },
        { id: "other", title: "Something else" },
      ] };
    },
  });
  let rendered: any;
  const input = { value: "see #Thread next", selectionStart: 11, setSelectionRange(start: number, end: number) { assert.equal(start, end); this.selectionStart = start; } };
  const view = {
    ...methods, threadId: "self", mentionGen: 1, mentionLoading: true, mentions: [], input,
    slash: { hidden: true },
    knownMentionKeys: () => new Set(["thread:taken"]),
    renderMentionPicker: (result: any) => { rendered = result; },
    hidePicker() {}, renderContext() {}, autosize() {}, focus() {},
  };
  const token = { ...mentionAt(input.value, input.selectionStart, "#"), thread: true };
  await view.loadMentions(token, 1);
  assert.deepEqual(Array.from(rendered.threads, (t: any) => t.id), ["target"]);
  assert.equal(view.mentionLoading, false);
  view.pickMention(rendered.threads[0], token);
  assert.equal(input.value, "see  next");
  assert.deepEqual(JSON.parse(JSON.stringify(view.mentions)), [{ kind: "thread", id: "target", title: "Thread to read" }]);
});
