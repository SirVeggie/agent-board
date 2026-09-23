import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mergeTemplateValues,
  normalizeTemplateInput,
  parseTemplateFields,
  parseTemplateValues,
  renderTemplateTitle,
  substituteTemplate,
} from "./templates.js";

const fields = parseTemplateFields([
  { key: "title", label: "Title", type: "text", required: true },
  { key: "item", label: "Item", type: "text", default: "task" },
  { key: "columns", label: "Columns", type: "number", default: 3, min: 1, max: 6 },
  { key: "done", label: "Show done", type: "checkbox" },
  {
    key: "theme",
    label: "Theme",
    type: "select",
    options: ["dark", { value: "light", label: "Light" }],
    default: "dark",
  },
]);

test("substitutes escaped placeholders", () => {
  const html = substituteTemplate("<h1>{{title}}</h1><p>{{missing}}</p>", { title: "A <b>x</b>" }, true);
  assert.equal(html, "<h1>A &lt;b&gt;x&lt;/b&gt;</h1><p></p>");
});

test("title uses titleTemplate, then title field, then template name", () => {
  assert.equal(renderTemplateTitle({ title: "Todo", titleTemplate: "{{title}} list", fields }, { title: "Shop" }), "Shop list");
  assert.equal(renderTemplateTitle({ title: "Todo", fields }, { title: "Shop" }), "Shop");
  assert.equal(renderTemplateTitle({ title: "Todo", fields: [] }, {}), "Todo");
});

test("parseTemplateValues fills defaults and coerces numbers", () => {
  const values = parseTemplateValues(fields, { title: "Shop", columns: "2" });
  assert.deepEqual(values, { title: "Shop", item: "task", columns: 2, done: false, theme: "dark" });
});

test("required and range checks", () => {
  assert.throws(() => parseTemplateValues(fields, {}), /Title is required/);
  assert.throws(() => parseTemplateValues(fields, { title: "A", columns: 9 }), /at most 6/);
});

test("normalizeTemplateInput rejects unknown placeholders", () => {
  assert.throws(
    () =>
      normalizeTemplateInput({
        title: "Todo",
        html: "<h1>{{nope}}</h1>",
        fields: [{ key: "title", label: "Title", type: "text" }],
      }),
    /unknown field/
  );
});

test("mergeTemplateValues keeps current values when fields stay compatible", () => {
  const values = mergeTemplateValues(fields, { title: "Shop", columns: 4, extra: "x" } as never);
  assert.equal(values.title, "Shop");
  assert.equal(values.columns, 4);
  assert.equal("extra" in values, false);
});
