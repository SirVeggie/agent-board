import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.SCRIBE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-files-"));
const { filePath, filesBlock, guessMimeType, isTextFile, removeFiles, safeFileName, saveFiles } = await import("./attachments.js");

const b64 = (text: string) => Buffer.from(text).toString("base64");

test("text files are recognised by type or extension", () => {
  assert.equal(isTextFile("notes.md", ""), true);
  assert.equal(isTextFile("data", "application/json"), true);
  assert.equal(isTextFile("main.rs", "application/octet-stream"), true);
  assert.equal(isTextFile("report.pdf", "application/pdf"), false);
  assert.equal(isTextFile("photo.bin", "image/png"), false);
  assert.equal(guessMimeType("a.pdf", ""), "application/pdf");
  assert.equal(guessMimeType("a.ts", "application/octet-stream"), "text/plain");
  assert.equal(guessMimeType("a.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
});

test("file names are made safe and keep their extension", () => {
  assert.equal(safeFileName('a<b>:c"d/e\\f|g?h*.txt'), "a_b_c_d_e_f_g_h_.txt");
  assert.equal(safeFileName("..."), "file");
  assert.equal(safeFileName(" report.pdf "), "report.pdf");
});

test("saved files can be found by id and removed", () => {
  const [ref] = saveFiles("th_1", [{ name: "hello.txt", mimeType: "text/plain", data: b64("hi there") }]);
  assert.equal(ref.size, 8);
  const found = filePath("th_1", ref.id);
  assert.ok(found);
  assert.equal(fs.readFileSync(found, "utf8"), "hi there");
  assert.equal(filePath("th_1", "../../etc"), null);
  removeFiles("th_1", [ref.id]);
  assert.equal(filePath("th_1", ref.id), null);
});

test("the prompt inlines text files and names the rest by path", () => {
  const files = [
    { name: "notes.md", mimeType: "text/markdown", data: b64("# Title") },
    { name: "spec.pdf", mimeType: "application/pdf", data: b64("%PDF-1.4") },
    { name: "sheet.xlsx", mimeType: "application/vnd.ms-excel", data: b64("xx") },
  ];
  const refs = files.map((f, i) => ({ id: `f${i}`, name: f.name, mimeType: f.mimeType, size: 8, path: `/tmp/${f.name}` }));
  const claude = filesBlock(files, refs, { nativePdf: true, canReadFiles: true });
  assert.match(claude, /<attached_file name="notes.md"[^>]*>\n# Title\n<\/attached_file>/);
  assert.match(claude, /name="spec.pdf"[^>]*>\(attached below as a PDF document\)/);
  assert.match(claude, /name="sheet.xlsx"[^>]*path="\/tmp\/sheet.xlsx">\(not inlined: open it from the path/);
  const pages = filesBlock(files, refs, { nativePdf: false, canReadFiles: false });
  assert.match(pages, /name="spec.pdf"[^>]*>\(not inlined, and this thread has no file access/);
  assert.equal(filesBlock([], [], { nativePdf: true, canReadFiles: true }), "");
});
