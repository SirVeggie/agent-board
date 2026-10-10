import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { launchChromium } from "./chromium.js";

test("peeks stay with their tab; split panes can be focused, arranged and replaced by pointer drag", async (t) => {
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
      let active: string | null = "a", space = "default", spaceIds = ["default"];
      let draft: { id: string, title: string, draft: boolean } | null = null;
      let views: any;
      const select = (id: string) => { views.onSelect(id); active = id; views.layout(); };
      const host = {
        mainEl, contentOrigin: () => location.origin,
        tabs: () => [...pages.values()], closed: () => [],
        findAnyTab: (id: string) => pages.get(id) || (draft?.id === id ? draft : null),
        activeId: () => active, activeTab: () => pages.get(active!) || (draft?.id === active ? draft : null),
        isBlank: (tab: any) => Boolean(tab?.draft), draftId: () => draft?.id || null,
        activate: (id: string) => select(id),
        newPage: async () => { draft = { id: "new", title: "New page", draft: true }; active = "new"; views.layout(); return true; },
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
      // A split replaces the pane without focus; picking another tab changes the focused one.
      const panes = () => ["a", "b"].map(pane => [...frames].find(([, f]) => f.el.dataset.pane === pane)?.[0] || "-").join("");
      const focused = () => (mainEl.querySelector(".pane-head.focused") as HTMLElement)?.dataset.pane;
      const click = (label: string, pane?: string) =>
        (mainEl.querySelector(`${pane ? `.pane-head[data-pane="${pane}"] ` : ""}[aria-label="${label}"]`) as HTMLButtonElement).click();
      await views.open("d", "split");
      observations.split = [panes(), focused(), active];
      select("b");
      observations.selectChangesFocusedPane = [panes(), focused()];
      // Picking the other pane's tab, or pressing in its page, moves focus there; nothing moves on screen.
      select("d");
      observations.selectOtherPane = [panes(), focused(), active];
      views.onFrameActive("b");
      observations.pressInPane = [panes(), focused(), active];
      mainEl.querySelector('.pane-head[data-pane="b"]')!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      observations.pressOnHeader = [focused(), active];
      // Focus that arrives by another route (Back, an agent's focus request) is followed too.
      active = "b"; views.layout();
      observations.focusByOtherRoute = [panes(), focused()];
      click("Swap panes");
      observations.swapped = [panes(), focused(), active];
      click("Stack panes");
      observations.stacked = [mainEl.classList.contains("split-col"), mainEl.querySelector(".split-divider")!.getAttribute("aria-orientation")];
      click("Show side by side");
      // The split is its space's: another space has none, and coming back restores it.
      space = "one"; active = "b"; views.prune(); views.layout();
      observations.otherSpace = shown();
      views.closePeek();
      space = "two"; views.prune(); views.layout();
      observations.restoredSplit = [panes(), focused()];
      // Either pane can be closed; its page stays a tab and the other pane fills the page area.
      click("Close pane", "b");
      observations.closeFocused = [shown(), active];
      await views.open("b", "split");
      click("Close pane", "b");
      observations.closeOther = [shown(), active];
      // Closing a pane's tab ends the split on the other pane.
      await views.open("b", "split");
      observations.closedTabNeighbor = views.returnTarget("d");
      views.onClosed("b"); views.layout();
      observations.closedOtherTab = shown();
      // Splitting the tab you are on opens a New page beside it, with focus.
      await views.open("d", "split");
      observations.splitActive = [shown(), focused(), active, panes()];
      select("d");
      observations.newPageKeptBeside = [shown(), focused()];
      click("Close pane", "b");
      draft = null;
      // A pane as a peek, and back.
      await views.open("a", "split");
      click("Show as peek", "b");
      observations.paneToPeek = [shown(), mainEl.classList.contains("has-split"), mainEl.classList.contains("has-peek")];
      click("Show in split");
      observations.peekToSplit = [panes(), mainEl.classList.contains("has-peek")];
      // Reloading keeps the split; a deleted page ends it.
      views = w.createViews(host); views.prune(); views.layout();
      observations.afterReload = [panes(), focused()];
      pages.delete("a"); views.onDeleted("a"); views.layout();
      observations.deletedTarget = shown();
      views = w.createViews(host); views.prune(); views.layout();
      observations.deletedSplitNotRestored = shown();
      await views.open("b", "split");
      spaceIds = ["one"]; space = "one"; views.prune(); views.layout();
      observations.deletedSpaceRemoved = localStorage.getItem("scribe.spaceSplits");
      // Pointer drop zones cover frames; arranging and replacing reuse the frame pool.
      select("b");
      await views.open("c", "split");
      const keptFrame = frames.get("c")!.el;
      const box = mainEl.getBoundingClientRect();
      views.beginPageDrag({ pane: "b" });
      const topDrop = views.updatePageDrag(box.left + box.width / 2, box.top + 5);
      observations.edgeDrop = topDrop;
      observations.overlayVisible = [...mainEl.querySelectorAll(".pane-drop-overlay")].some(el => !(el as HTMLElement).hidden);
      views.endPageDrag();
      await views.dropPage({ pane: "b" }, topDrop);
      observations.dragStack = [panes(), mainEl.classList.contains("split-col")];
      views.beginPageDrag({ id: "d" });
      const replace = views.updatePageDrag(box.left + box.width / 2, box.top + box.height / 4);
      await views.dropPage({ id: "d" }, replace);
      views.endPageDrag();
      observations.dragReplace = [panes(), active];
      await views.dropPage({ id: "d" }, { edge: "right" });
      observations.dragRight = [panes(), mainEl.classList.contains("split-col")];
      views.beginPageDrag({ pane: "a" });
      observations.noDropOutside = views.updatePageDrag(box.right + 20, box.bottom + 20);
      views.endPageDrag();
      observations.cancelKeepsLayout = panes();
      await views.dropPage({ pane: "b" }, { strip: true });
      observations.dragToStrip = [shown(), pages.has("d"), frames.get("c")!.el === keptFrame];
      views.beginPageDrag({ id: "c" });
      await views.dropPage({ id: "c" }, { edge: "left" });
      views.endPageDrag();
      observations.dragTabToSplit = [panes(), active];
      await views.dropPage({ pane: "b" }, { strip: true });
      await views.dropPage({ id: "c" }, { edge: "bottom" });
      observations.dragOnlyTab = [shown(), mainEl.classList.contains("split-col")];
      observations.overlayCleaned = [(mainEl.querySelector(".pane-drop-overlay") as HTMLElement).hidden, document.body.classList.contains("dragging-pane")];
      return observations;
    });
    assert.deepEqual(result, {
      otherTab: "b", escapeOtherTab: false, originalTab: "a,d", sameFrame: true, back: "a,c",
      firstSpace: "a,c", otherSpaceSameTab: "a",
      split: ["ad", "a", "a"], selectChangesFocusedPane: ["bd", "a"],
      selectOtherPane: ["bd", "b", "d"], pressInPane: ["bd", "a", "b"], pressOnHeader: ["b", "d"],
      focusByOtherRoute: ["bd", "a"], swapped: ["db", "b", "b"], stacked: [true, "horizontal"],
      otherSpace: "b,c", restoredSplit: ["db", "b"],
      closeFocused: ["d", "d"], closeOther: ["d", "d"],
      closedTabNeighbor: "b", closedOtherTab: "d",
      splitActive: ["d,new", "b", "new", "d-"], newPageKeptBeside: ["d,new", "a"],
      paneToPeek: ["a,d", false, true], peekToSplit: ["da", false],
      afterReload: ["da", "a"], deletedTarget: "d", deletedSplitNotRestored: "d",
      deletedSpaceRemoved: "{}",
      edgeDrop: { edge: "top" }, overlayVisible: true, dragStack: ["cb", true],
      dragReplace: ["db", "b"], dragRight: ["bd", false], noDropOutside: null,
      cancelKeepsLayout: "bd", dragToStrip: ["b", true, true], dragTabToSplit: ["cb", "b"],
      dragOnlyTab: ["c,new", true], overlayCleaned: [true, false],
    });
    // Exercise the actual app.js controller with mouse input, including crossing live iframes.
    await page.setContent('<div id="strip"><div id="tabs"></div></div><main></main>');
    await page.addStyleTag({ content: fs.readFileSync(new URL("../public/app.css", import.meta.url), "utf8") + '\n#strip {height:50px} #tabs {display:flex;height:50px} main {position:relative;width:1100px;height:650px} .tab {width:150px;height:40px} iframe {position:absolute;inset:40px 0 0;width:100%;height:90%}' });
    const appSource = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
    const controller = appSource.slice(appSource.indexOf("  function onTabPointerDown("), appSource.indexOf('  /**\n   * Library row dragged over the strip'));
    await page.addScriptTag({ content: `{
      const state = { tabs: ['a','b','c'].map(id => ({id,title:id,pinned:false})), activeId:'a' };
      const mainEl = document.querySelector('main'), tabsEl = document.querySelector('#tabs'), tabsWrap = document.querySelector('#strip');
      const libraryToggle = document.createElement('button'), tabEls = new Map(), frames = new Map();
      let drag = null, dragScrollTimer = 0, toggleHoverTimer = 0, dragSuppressClick = false;
      const hoverCard = {suspend(){},resume(){}}, library = {stripDragCancel(){},stripDragMove(){return false},stripDragDrop(){return false}};
      const lookupTab = el => state.tabs.find(t => t.id === el.dataset.id);
      const stopTabScroll = () => {}, updateTabFade = () => {}, flipStrip = fn => fn();
      const libraryShown = () => false, setSidebarTab = () => {}, setSideOpen = () => {};
      const select = id => { views.onSelect(id); state.activeId=id; views.layout(); };
      const renderTabs = () => { for(const tab of state.tabs) tabsEl.appendChild(tabEls.get(tab.id)); };
      const views = window.createViews({mainEl,startPaneDrag,contentOrigin:()=>location.origin,
        tabs:()=>state.tabs,closed:()=>[],activeId:()=>state.activeId,activeTab:()=>state.tabs.find(t=>t.id===state.activeId),
        findAnyTab:id=>state.tabs.find(t=>t.id===id),isBlank:()=>false,draftId:()=>null,
        spaceId:()=> 'pointer-test',spaceIds:()=>['pointer-test'],activate:select,selectTab:select,
        frame:id=>frames.get(id),frameIds:()=>[...frames.keys()],ensureFrame:meta=>{
          if(!frames.has(meta.id)){const el=document.createElement('iframe');mainEl.appendChild(el);frames.set(meta.id,{el});}
          return frames.get(meta.id);
        },discardFrame:()=>{},markSeen:()=>{},render:()=>views.layout()
      });
      for(const tab of state.tabs){ const el=document.createElement('div');el.className='tab';el.dataset.id=tab.id;el.textContent=tab.title;
        el.addEventListener('pointerdown',e=>onTabPointerDown(e,el));tabEls.set(tab.id,el); }
      renderTabs(); views.layout();
      window.addEventListener('keydown',e=>{if(e.key==='Escape')abortDrag();});
      window.dragTest = {views,state,frames};
      ${controller}
    }` });
    const moveDrag = async (selector: string, x: number, y: number) => {
      const rect = await page.locator(selector).boundingBox();
      assert.ok(rect);
      await page.mouse.move(rect.x + 40, rect.y + rect.height / 2);
      await page.mouse.down();
      await page.mouse.move(rect.x + 50, rect.y + rect.height / 2);
      await page.mouse.move(x, y, { steps: 5 });
    };
    const area = await page.locator('main').boundingBox();
    assert.ok(area);
    await moveDrag('.tab[data-id="b"]', area.x + area.width - 5, area.y + area.height / 2);
    await page.mouse.up();
    assert.equal(await page.locator('main').evaluate(el => el.classList.contains('has-split')), true);
    await moveDrag('.pane-head[data-pane="b"]', area.x + area.width / 2, area.y + 5);
    await page.mouse.up();
    assert.equal(await page.locator('main').evaluate(el => el.classList.contains('split-col')), true);
    await moveDrag('.tab[data-id="c"]', area.x + area.width / 2, area.y + area.height * 0.75);
    await page.mouse.up();
    assert.equal(await page.evaluate(() => (window as any).dragTest.frames.get('c').el.dataset.pane), 'b');
    await moveDrag('.pane-head[data-pane="b"]', 80, 25);
    await page.mouse.up();
    assert.equal(await page.locator('main').evaluate(el => el.classList.contains('has-split')), false);
    assert.equal(await page.locator('.tab').count(), 3);
    await moveDrag('.tab[data-id="b"]', area.x + 5, area.y + 200);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    assert.equal(await page.locator('main').evaluate(el => el.classList.contains('has-split')), false);
    assert.equal(await page.locator('.pane-drop-overlay').evaluate(el => (el as HTMLElement).hidden), true);
    assert.equal(await page.evaluate(() => document.body.classList.contains('dragging-pane')), false);
    await moveDrag('.tab[data-id="b"]', area.x + 5, area.y + 200);
    await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 })));
    await page.mouse.up();
    assert.equal(await page.locator('main').evaluate(el => el.classList.contains('has-split')), false);
    assert.equal(await page.locator('.tab').count(), 3);
  } finally {
    await browser.close();
  }
});
