import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { discoverSkills } from "./harness.js";
import { copySkill, createSkill, editableKind, readHarnessFile, removeSkill, writeHarnessFile } from "./harnessFiles.js";

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-harness-files-"));
  const roots = { workspace: path.join(root, "ws"), home: path.join(root, "home"), data: path.join(root, "data") };
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
  return { root, roots, write, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("only skills and instruction files can be edited", () => {
  const { roots, write, done } = sandbox();
  const skill = write(path.join(roots.home, ".claude", "skills", "keeper", "SKILL.md"), "old");
  const agents = write(path.join(roots.workspace, "AGENTS.md"), "rules");
  const other = write(path.join(roots.workspace, "src", "index.ts"), "code");
  assert.equal(editableKind(skill, roots), "skill");
  assert.equal(editableKind(path.join(roots.home, ".claude", "skills", "keeper", "docs", "more.md"), roots), "skill");
  assert.equal(editableKind(agents, roots), "instructions");
  assert.equal(editableKind(other, roots), null);
  // Loose in the folder of skills, or reached by climbing out of it.
  assert.equal(editableKind(path.join(roots.home, ".claude", "skills", "notes.md"), roots), null);
  assert.equal(editableKind(path.join(roots.home, ".claude", "skills", "keeper", "..", "..", "settings.json"), roots), null);
  assert.equal(editableKind("AGENTS.md", roots), null);
  // Another workspace's file is not this one's.
  assert.equal(editableKind(agents, { ...roots, workspace: null }), null);

  writeHarnessFile(skill, "new", roots);
  assert.equal(readHarnessFile(skill, roots).text, "new");
  assert.equal(readHarnessFile(agents, roots).kind, "instructions");
  assert.throws(() => readHarnessFile(other, roots), /only changes skills/);
  assert.throws(() => writeHarnessFile(other, "x", roots), /only changes skills/);
  assert.throws(() => writeHarnessFile(path.join(roots.workspace, "CLAUDE.md"), "x", roots), /File not found/);
  assert.equal(fs.readFileSync(other, "utf8"), "code");
  done();
});

test("a skill is created, copied to another provider and removed without losing it", () => {
  const { roots, done } = sandbox();
  const claude = path.join(roots.home, ".claude", "skills");
  const codex = path.join(roots.data, "agent", "codex", "skills");
  assert.throws(() => createSkill(path.join(roots.home, "elsewhere"), "x", "d", roots), /Not one of the folders/);
  assert.throws(() => createSkill(claude, "Bad Name", "d", roots), /lowercase/);
  assert.throws(() => createSkill(claude, "x", " ", roots), /description/);

  const { file } = createSkill(claude, "deploy", "Use when: shipping a build", roots);
  assert.throws(() => createSkill(claude, "deploy", "again", roots), /already/);
  fs.writeFileSync(path.join(path.dirname(file), "steps.md"), "1");
  let skills = discoverSkills(roots.workspace, roots.home, roots.data);
  assert.deepEqual(skills.map((s) => [s.name, s.description, s.providers, s.files]), [["deploy", "Use when: shipping a build", ["claude"], 1]]);

  const copy = copySkill(file, codex, roots);
  assert.equal(copy.file, path.join(codex, "deploy", "SKILL.md"));
  assert.equal(fs.readFileSync(path.join(codex, "deploy", "steps.md"), "utf8"), "1");
  assert.throws(() => copySkill(file, codex, roots), /already/);
  assert.throws(() => copySkill(path.join(claude, "deploy", "steps.md"), codex, roots), /SKILL\.md/);

  const { kept } = removeSkill(file, roots);
  assert.ok(kept && fs.existsSync(path.join(kept, "steps.md")));
  assert.equal(fs.existsSync(path.dirname(file)), false);
  skills = discoverSkills(roots.workspace, roots.home, roots.data);
  assert.deepEqual(skills.map((s) => s.providers), [["codex"]]);
  assert.throws(() => removeSkill(file, roots), /not found/);
  done();
});
