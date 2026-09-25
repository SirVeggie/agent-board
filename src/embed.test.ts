import assert from "node:assert/strict";
import { test } from "node:test";
import { baseUrl } from "./config.js";
import { embedUrlFromHtml } from "./embed.js";

function page(meta: string): string {
  return `<!DOCTYPE html><html><head>${meta}<title>t</title></head><body></body></html>`;
}

test("reads the embed URL from the meta tag, in either attribute order", () => {
  assert.equal(
    embedUrlFromHtml(page('<meta name="agent-board-embed" content="http://127.0.0.1:8188/">')),
    "http://127.0.0.1:8188/"
  );
  assert.equal(
    embedUrlFromHtml(page("<meta content='https://example.com/a' name='agent-board-embed'>")),
    "https://example.com/a"
  );
});

test("decodes the HTML escaping templates apply", () => {
  assert.equal(
    embedUrlFromHtml(page('<meta name="agent-board-embed" content="http://h/?a=1&amp;b=2">')),
    "http://h/?a=1&b=2"
  );
});

test("pages without the meta tag are not embeds", () => {
  assert.equal(embedUrlFromHtml(page('<meta name="viewport" content="width=device-width">')), undefined);
  assert.equal(embedUrlFromHtml("<p>fragment</p>"), undefined);
});

test("rejects URLs that would run with the board's origin", () => {
  for (const url of ["javascript:alert(1)", "data:text/html,<p>x</p>", "about:blank", `${baseUrl()}/`, "not a url", ""]) {
    assert.equal(embedUrlFromHtml(page(`<meta name="agent-board-embed" content="${url}">`)), undefined, url);
  }
});
