import assert from "node:assert/strict";
import { test } from "node:test";
import { pageShowHead } from "./providers/claude.js";

test("streaming page_show reports early only with an explicit background choice", () => {
  for (const background of [true, false]) {
    const input = { key: "scribe:trip-plan", title: 'Trip "plan"', background };
    assert.deepEqual(pageShowHead(JSON.stringify(input).slice(0, -1) + ',"html":"<h1'), input);
    assert.deepEqual(pageShowHead(JSON.stringify(input).slice(0, -1) + ',"htmlPath":"C:'), input);
  }
  assert.equal(pageShowHead('{"key":"scribe:trip-plan","title":"Trip'), null);
});

test("background after the content cannot briefly show the creating screen", () => {
  const prefix = '{"title":"Evidence","html":"' + "x".repeat(1000);
  assert.equal(pageShowHead(prefix), null);
  assert.equal(pageShowHead(prefix + '","background":tru'), null);
  assert.deepEqual(pageShowHead(prefix + '","background":true}'), { title: "Evidence", background: true });
  assert.deepEqual(pageShowHead(prefix + '"}'), { title: "Evidence" });
  assert.equal(pageShowHead('{"title":"Notes","htmlPath":"C:'), null);
});

test("nested and quoted fields are not taken for the call's own", () => {
  const input = { state: { background: false, title: "Other" }, html: '"background":false', background: true };
  assert.deepEqual(pageShowHead(JSON.stringify(input)), { background: true });
  assert.equal(pageShowHead('{"state":{"background":false},"title":"Evidence","html":"<h1'), null);
  assert.equal(pageShowHead('{"html":' + JSON.stringify('<script>const o = {"background":false,"key":"scribe:other","title":"x"};').slice(0, -1)), null);
  assert.equal(pageShowHead(`{"id":"t_1",${" ".repeat(400)}`), null);
});
