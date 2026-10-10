import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PALETTE_PREFIXES,
  duplicatePrefixIds,
  normalizePrefix,
  palettePrefixList,
  parsePaletteQuery,
  prefixTakes,
  serializePalettePrefixes,
} from "./palettePrefixes.js";

const threads = { id: "threads", prefix: "=" };

test("threads default is =, Ask AI is ?, by meaning is ~", () => {
  assert.deepEqual(PALETTE_PREFIXES, [
    { id: "threads", label: "Threads", default: "=" },
    { id: "ai", label: "Ask AI", default: "?" },
    { id: "semantic", label: "By meaning", default: "~" },
  ]);
});

test("normalizePrefix trims, rejects blanks, spaces, and overlong values", () => {
  assert.equal(normalizePrefix(" > ", "?"), ">");
  assert.equal(normalizePrefix("", "="), "=");
  assert.equal(normalizePrefix("   ", "="), "=");
  assert.equal(normalizePrefix("= =", "="), "=");
  assert.equal(normalizePrefix("abcdefghij", "="), "=");
  assert.equal(normalizePrefix("??", "="), "??");
});

test("palettePrefixList uses defaults when storage is missing or junk", () => {
  assert.deepEqual(
    palettePrefixList(null).map((p) => p.prefix),
    ["=", "?", "~"]
  );
  assert.deepEqual(palettePrefixList("not-json").map((p) => p.prefix), ["=", "?", "~"]);
  assert.deepEqual(palettePrefixList("[]").map((p) => p.prefix), ["=", "?", "~"]);
  assert.deepEqual(palettePrefixList('{"threads":"#"}').map((p) => p.prefix), ["#", "?", "~"]);
  assert.deepEqual(palettePrefixList('{"threads":"","extra":"x"}').map((p) => p.prefix), ["=", "?", "~"]);
});

test("serializePalettePrefixes stores only overrides", () => {
  assert.equal(serializePalettePrefixes([{ id: "threads", prefix: "=", default: "=" }]), "{}");
  assert.equal(serializePalettePrefixes([{ id: "threads", prefix: "#", default: "=" }]), '{"threads":"#"}');
  assert.equal(serializePalettePrefixes([{ id: "threads", prefix: "= =", default: "=" }]), "{}");
});

test("symbol prefixes glue to the query; word prefixes need a boundary", () => {
  assert.equal(prefixTakes("=foo", "="), true);
  assert.equal(prefixTakes("=", "="), true);
  assert.equal(prefixTakes("= foo", "="), true);
  assert.equal(prefixTakes("foo", "="), false);
  assert.equal(prefixTakes("this", "th"), false);
  assert.equal(prefixTakes("th", "th"), true);
  assert.equal(prefixTakes("th foo", "th"), true);
});

test("parsePaletteQuery sends = to threads and everything else to pages", () => {
  assert.deepEqual(parsePaletteQuery("", [threads]), { id: "pages", query: "" });
  assert.deepEqual(parsePaletteQuery("  board  ", [threads]), { id: "pages", query: "board" });
  assert.deepEqual(parsePaletteQuery("=", [threads]), { id: "threads", query: "", prefix: "=" });
  assert.deepEqual(parsePaletteQuery("= palette", [threads]), { id: "threads", query: "palette", prefix: "=" });
  assert.deepEqual(parsePaletteQuery("=palette", [threads]), { id: "threads", query: "palette", prefix: "=" });
});

test("the longest matching prefix wins, then registry order", () => {
  const prefixes = [
    { id: "threads", prefix: "=" },
    { id: "ask", prefix: "==" },
  ];
  assert.deepEqual(parsePaletteQuery("==x", prefixes), { id: "ask", query: "x", prefix: "==" });
  assert.deepEqual(parsePaletteQuery("=x", prefixes), { id: "threads", query: "x", prefix: "=" });
  const same = [
    { id: "threads", prefix: "?" },
    { id: "ask", prefix: "?" },
  ];
  assert.equal(parsePaletteQuery("?hi", same).id, "threads");
});

test("a changed prefix is what parsePaletteQuery looks for", () => {
  const prefixes = [{ id: "threads", prefix: "#" }];
  assert.deepEqual(parsePaletteQuery("#board", prefixes), { id: "threads", query: "board", prefix: "#" });
  assert.deepEqual(parsePaletteQuery("=board", prefixes), { id: "pages", query: "=board" });
});

test("duplicatePrefixIds marks every id that shares a token", () => {
  assert.deepEqual([...duplicatePrefixIds([{ id: "threads", prefix: "=" }])], []);
  assert.deepEqual(
    [...duplicatePrefixIds([
      { id: "threads", prefix: "?" },
      { id: "ask", prefix: "?" },
    ])].sort(),
    ["ask", "threads"]
  );
});

test("~ sends the query to semantic search", () => {
  const prefixes = palettePrefixList(null);
  assert.deepEqual(parsePaletteQuery("~ talking to add tasks", prefixes), { id: "semantic", query: "talking to add tasks", prefix: "~" });
  assert.deepEqual(parsePaletteQuery("~", prefixes), { id: "semantic", query: "", prefix: "~" });
});
