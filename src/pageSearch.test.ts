import assert from "node:assert/strict";
import { test } from "node:test";
import { locationLabel, qualityLabel, searchPages, type PageSearchHit } from "./pageSearch.js";
import type { Tab } from "./types.js";

function tab(over: Partial<Tab> & Pick<Tab, "title">): Tab {
  const id = over.id ?? over.title.toLowerCase().replace(/\s+/g, "-");
  return {
    id,
    key: over.key ?? id,
    title: over.title,
    html: over.html ?? "",
    pinned: false,
    createdAt: 1,
    updatedAt: over.updatedAt ?? 1,
    stripSeq: 1,
    revision: 1,
    state: over.state ?? {},
    stateRevision: 0,
    stateUpdatedAt: 0,
    signalRevision: 0,
    signal: null,
    assets: [],
    ...(over.archivedAt ? { archivedAt: over.archivedAt } : {}),
    ...over,
  };
}

function titles(result: ReturnType<typeof searchPages>): string[] {
  return result.hits.map((item) => item.tab.title);
}

function hit(result: ReturnType<typeof searchPages>, title: string): PageSearchHit {
  const found = result.hits.find((item) => item.tab.title === title);
  assert.ok(found, `missing hit: ${title}`);
  return found;
}

test("phrase match is a case-insensitive contains of the full query", () => {
  const result = searchPages(
    [tab({ title: "Alpha Category Notes", html: "<p>unrelated</p>" })],
    [],
    "cat"
  );
  const match = hit(result, "Alpha Category Notes");
  assert.equal(match.location, "title");
  assert.equal(match.quality, "phrase");
});

test("ordered parts beat unordered, and comma/period split like spaces", () => {
  const pages = [
    tab({ title: "Gap", html: "<p>alpha then later omega</p>" }),
    tab({ title: "Scrambled", html: "<p>omega first and then alpha</p>" }),
  ];
  const result = searchPages(pages, [], "alpha, omega");
  assert.deepEqual(titles(result), ["Gap", "Scrambled"]);
  assert.equal(hit(result, "Gap").quality, "ordered");
  assert.equal(hit(result, "Scrambled").quality, "all");
});

test("period-separated parts match in order without needing exact words", () => {
  const result = searchPages(
    [tab({ title: "Report", html: "<p>deployment checklist notes</p>" })],
    [],
    "deploy.check"
  );
  const match = hit(result, "Report");
  assert.equal(match.location, "content");
  assert.equal(match.quality, "ordered");
});

test("partial requires at least half the parts", () => {
  const pages = [
    tab({ title: "Two of four", html: "<p>red blue</p>" }),
    tab({ title: "One of three", html: "<p>red</p>" }),
    tab({ title: "Two of three", html: "<p>red green</p>" }),
  ];
  const half = searchPages(pages, [], "red blue yellow purple");
  assert.deepEqual(titles(half), ["Two of four"]);
  assert.equal(hit(half, "Two of four").quality, "partial");
  assert.equal(hit(half, "Two of four").matchedParts, 2);

  const third = searchPages(pages, [], "red green yellow");
  assert.deepEqual(titles(third), ["Two of three"]);
  assert.equal(hit(third, "Two of three").quality, "partial");
  assert.equal(searchPages([pages[1]], [], "red blue yellow").hits.length, 0);
});

test("title wins over a stronger content match", () => {
  const pages = [
    tab({ title: "red blue notes", html: "<p>red blue yellow purple extra</p>" }),
    tab({ title: "elsewhere", html: "<p>red blue yellow purple extra</p>" }),
  ];
  const result = searchPages(pages, [], "red blue yellow purple");
  const weakTitle = hit(result, "red blue notes");
  assert.equal(weakTitle.location, "title");
  assert.equal(weakTitle.quality, "partial");
  assert.equal(hit(result, "elsewhere").location, "content");
  assert.equal(hit(result, "elsewhere").quality, "phrase");
  assert.equal(result.hits[0].tab.title, "red blue notes");
});

test("content ranks above data, and open ranks above archived on ties", () => {
  const open = [
    tab({ title: "State page", html: "<p>nope</p>", state: { note: "unique-token" }, updatedAt: 10 }),
    tab({ title: "Body page", html: "<p>unique-token lives here</p>", updatedAt: 5 }),
  ];
  const archived = [tab({ title: "Old body", html: "<p>unique-token lives here</p>", archivedAt: 1, updatedAt: 20 })];
  const result = searchPages(open, archived, "unique-token");
  assert.deepEqual(titles(result), ["Body page", "Old body", "State page"]);
  assert.equal(hit(result, "Body page").location, "content");
  assert.equal(hit(result, "State page").location, "data");
  assert.equal(hit(result, "Old body").archived, true);
});

test("empty query lists open tabs then archived", () => {
  const result = searchPages(
    [tab({ title: "Open A" }), tab({ title: "Open B" })],
    [tab({ title: "Archived", archivedAt: 2 })],
    "  "
  );
  assert.deepEqual(titles(result), ["Open A", "Open B", "Archived"]);
  assert.equal(result.hits[0].location, null);
  assert.equal(result.hits[2].archived, true);
});

test("key match is not reported as a title match", () => {
  const result = searchPages(
    [tab({ title: "Bot message rewrites", key: "valheim-wake-messages", html: "<p>unrelated</p>" })],
    [],
    "valheim"
  );
  const match = hit(result, "Bot message rewrites");
  assert.equal(match.location, "key");
  assert.equal(match.quality, "phrase");
  assert.equal(match.snippet, "valheim-wake-messages");
});

test("title still beats a key match", () => {
  const result = searchPages(
    [
      tab({ title: "Valheim idle spin", key: "other-key", html: "<p>nope</p>" }),
      tab({ title: "Bot rewrites", key: "valheim-wake-messages", html: "<p>nope</p>" }),
    ],
    [],
    "valheim"
  );
  assert.deepEqual(titles(result), ["Valheim idle spin", "Bot rewrites"]);
  assert.equal(hit(result, "Valheim idle spin").location, "title");
  assert.equal(hit(result, "Bot rewrites").location, "key");
});

test("labels cover every location and quality", () => {
  assert.equal(locationLabel("title"), "Title");
  assert.equal(locationLabel("key"), "Key");
  assert.equal(locationLabel("content"), "Content");
  assert.equal(locationLabel("data"), "Data");
  assert.equal(qualityLabel("phrase", 2, 2), "Phrase");
  assert.equal(qualityLabel("ordered", 2, 2), "In order");
  assert.equal(qualityLabel("all", 2, 2), "All terms");
  assert.equal(qualityLabel("partial", 2, 4), "Partial 2/4");
});
