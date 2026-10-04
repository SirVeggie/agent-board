import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { BOARD_BRIDGE_JS } from "./bridge.js";
import { SKILL_DIR, skillDocs, splitSections } from "./skillDocs.js";

/** Top-level keys of the object literal that starts at `start` in the bridge source. */
function objectKeys(start: string): string[] {
  const at = BOARD_BRIDGE_JS.indexOf(start);
  assert.ok(at >= 0, `bridge has no "${start}"`);
  const keys: string[] = [];
  let depth = 0;
  for (const line of BOARD_BRIDGE_JS.slice(at + start.length - 1).split("\n")) {
    const key = depth === 1 && /^\s*(?:get\s+)?([a-zA-Z]+)\s*[(:]/.exec(line);
    if (key) {
      keys.push(key[1]);
    }
    for (const ch of line) {
      depth += ch === "{" ? 1 : ch === "}" ? -1 : 0;
    }
    if (depth === 0) {
      break;
    }
  }
  return keys;
}

test("the scribe skill documents every member of window.scribe", () => {
  const docs = ["SKILL.md", "TEMPLATES.md"].map((name) => fs.readFileSync(path.join(SKILL_DIR, name), "utf8")).join("\n");
  const apis: Array<[prefix: string, start: string]> = [
    ["scribe.", "window.scribe = {"],
    ["scribe.agent.", "var agent = {"],
    ["scribe.permissions.", "var permissions = {"],
  ];
  for (const [prefix, start] of apis) {
    const keys = objectKeys(start);
    assert.ok(keys.length > 1, `found no keys in ${start}`);
    const missing = keys.filter((key) => !docs.includes(prefix + key));
    assert.deepEqual(missing, [], `document these in .cursor/skills/scribe: ${missing.map((key) => prefix + key).join(", ")}`);
  }
  assert.ok(objectKeys("window.scribe = {").includes("preview"));
});

const SAMPLE = `---
name: scribe
---

# Scribe

Intro text.

## Show

Show it.

### Patch

Patch it.

\`\`\`md
## Not a heading
\`\`\`

## Wait

Wait for it.
`;

test("splitSections nests ### in ## and skips fenced headings", () => {
  const { intro, sections } = splitSections(SAMPLE);
  assert.equal(intro, "# Scribe\n\nIntro text.");
  assert.deepEqual(
    sections.map((section) => section.heading),
    ["Show", "Patch", "Wait"]
  );
  assert.match(sections[0].text, /Patch it\.[\s\S]*## Not a heading/);
  assert.doesNotMatch(sections[0].text, /Wait for it/);
});

test("skillDocs serves contents, sections, all, and templates", () => {
  const read = (name: string) => (name === "SKILL.md" ? SAMPLE : name === "TEMPLATES.md" ? "# Templates" : null);
  const contents = skillDocs(undefined, read);
  assert.match(contents.text, /Intro text\.[\s\S]*- Show\n {2}- Patch\n- Wait/);
  assert.equal(skillDocs("patch", read).text, "### Patch\n\nPatch it.\n\n```md\n## Not a heading\n```");
  // "Show" holds "Patch", so a query matching both returns the section once.
  assert.equal(skillDocs("h", read).text.match(/Patch it/g)?.length, 1);
  assert.equal(skillDocs("all", read).text.startsWith("# Scribe"), true);
  assert.equal(skillDocs("templates", read).text, "# Templates");
  assert.equal(skillDocs("nope", read).error, true);
  assert.equal(skillDocs(undefined, () => null).error, true);
});

test("skillDocs reads the repo's skill", () => {
  const docs = skillDocs("Interactive pages");
  assert.equal(docs.error, undefined);
  assert.match(docs.text, /^## Interactive pages/);
});
