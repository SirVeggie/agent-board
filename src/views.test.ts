import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { launchChromium } from "./chromium.js";

test("peeks belong to a tab and splits follow tabs only within their space", async (t) => {
  let browser;
  try {
    browser = process.env.SCRIBE_TEST_CHROMIUM
      ? await chromium.launch({ executablePath: process.env.SCRIBE_TEST_CHROMIUM, headless: true })
      : await launchChromium({ headless: true, args: [], purpose: "Page views test" });
  } catch (error) {
    if ((error as Error).message.includes("Could not launch")) return t.skip("no Chromium installed");
    throw error;
  }
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await page.route("http://views.test/**", route => route.fulfill({ contentType: "text/html", body: '<main style="width:1100px;height:700px"></main>' }));
    await page.goto("http://views.test/");
    // tsx's named-function helper must also exist inside serialized evaluate callbacks.
    await page.addScriptTag({ content: "window.__name = (fn) => fn;" });
    await page.addScriptTag({ content: fs.readFileSync(new URL("../public/views.js", import.meta.url), "utf8") });
    const result = await page.evaluate(async () => {
      const w = window as any;
      const mainEl = document.querySelector("main")!;
      const pages = new Map(["a", "b", "c", "d"].map(id => [id, { id, title: id }]));
      const frames = new Map<string, { el: HTMLIFrameElement }>();
      let active = "a", space = "default", spaceIds = ["default"];
      let views: any;
      const select = (id: string) => { views.onSelect(id); active = id; views.layout(); };
      const host = {
        mainEl, contentOrigin: () => location.origin,
        tabs: () => [...pages.values()], closed: () => [], findAnyTab: (id: string) => pages.get(id),
        activeId: () => active, activeTab: () => pages.get(active),
        spaceId: () => space, spaceIds: () => spaceIds,
        frame: (id: string) => frames.get(id), frameIds: () => [...frames.keys()],
        ensureFrame: (meta: any) => {
          if (!frames.has(meta.id)) {
            const el = document.createElement("iframe");
            mainEl.append(el);
            frames.set(meta.id, { el });
          }
          return frames.get(meta.id);
        },
        discardFrame: (id: string) => { frames.get(id)?.el.remove(); frames.delete(id); },
        selectTab: select, openPage: select, showNotice: () => {}, linkMode: () => "tab",
        markSeen: () => {}, render: () => views.layout(),
      };
      views = w.createViews(host);
      const shown = () => [...views.shownIds()].sort().join(",");
      const observations: Record<string, unknown> = {};
      await views.open("c", "peek");
      await views.open("d", "peek", { source: { role: "peek" } });
      const originalFrame = frames.get("d")!.el;
      select("b");
      observations.otherTab = shown();
      observations.escapeOtherTab = views.escape();
      await views.open("c", "peek");
      select("a");
      observations.originalTab = shown();
      observations.sameFrame = frames.get("d")!.el === originalFrame;
      (mainEl.querySelector('[aria-label="Back"]') as HTMLButtonElement).click();
      observations.back = shown();
      spaceIds = ["one", "two"]; space = "one";
      views.prune(); views.layout();
      observations.firstSpace = shown();
      space = "two"; views.prune(); views.layout();
      observations.otherSpaceSameTab = shown();
      await views.open("d", "split");
      select("b");
      observations.splitFollowsTab = shown();
      space = "one"; views.prune(); views.layout();
      observations.restoredOtherPeek = shown();
      views.closePeek();
      await views.open("c", "split");
      space = "two"; views.prune(); views.layout();
      observations.restoredSplit = shown();
      select("d");
      observations.selectSplitTarget = shown();
      space = "one"; active = "a"; views.prune(); views.layout();
      observations.originalSplit = shown();
      (mainEl.querySelector('[aria-label="Show as peek"]') as HTMLButtonElement).click();
      observations.convertedPeek = shown();
      select("b");
      observations.convertedPeekOtherTab = shown();
      select("a");
      pages.delete("c"); views.onDeleted("c"); views.layout();
      observations.deletedTarget = shown();
      views = w.createViews(host); views.prune(); views.layout();
      observations.deletedSplitNotRestored = shown();
      await views.open("d", "split");
      views = w.createViews(host); views.prune(); views.layout();
      observations.splitAfterReload = shown();
      spaceIds = ["two"]; space = "two"; views.prune(); views.layout();
      observations.deletedSpaceRemoved = localStorage.getItem("scribe.spaceSplits");
      return observations;
    });
    assert.deepEqual(result, {
      otherTab: "b", escapeOtherTab: false, originalTab: "a,d", sameFrame: true, back: "a,c",
      firstSpace: "a,c", otherSpaceSameTab: "a", splitFollowsTab: "b,d",
      restoredOtherPeek: "b,c", restoredSplit: "b,d", selectSplitTarget: "d",
      originalSplit: "a,c", convertedPeek: "a,c", convertedPeekOtherTab: "b",
      deletedTarget: "a", deletedSplitNotRestored: "a",
      splitAfterReload: "a,d", deletedSpaceRemoved: "{}",
    });
  } finally {
    await browser.close();
  }
});
