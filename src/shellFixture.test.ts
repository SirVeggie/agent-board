import assert from "node:assert/strict";
import { test } from "node:test";
import { launchChromium } from "./chromium.js";
import { loadShellScripts, shellScriptNames } from "./testSupport/shell.js";

test("fixture script discovery follows index order, strips versions, and picks up new modules", () => {
  assert.deepEqual(shellScriptNames(`
    <script src="./motion.js?v=1"></script>
    <script src='/api/appearance/bootstrap.js'></script>
    <script src='./new-module.js?v=42'></script>
    <script src="/vendor/marked.js"></script>`), ["motion.js", "new-module.js", "/vendor/marked.js"]);
});

test("shell fixture loads the index scripts, supports subsets, and bounds broken startup", async () => {
  const browser = await launchChromium({ headless: true, args: [], purpose: "Shell fixture loader test" });
  try {
    const page = await browser.newPage();
    await page.evaluate("window.loaded = []");
    await loadShellScripts(page, {
      transform: name => `window.loaded.push(${JSON.stringify(name)});`,
      ready: () => page.waitForFunction(() => (window as any).loaded.at(-1) === "desktop.js"),
    });
    assert.deepEqual(await page.evaluate("window.loaded"), shellScriptNames());
    await page.evaluate("window.loaded = []");
    await loadShellScripts(page, {
      scripts: ["agent-render.js", "motion.js"],
      transform: name => `window.loaded.push(${JSON.stringify(name)});`,
    });
    assert.deepEqual(await page.evaluate("window.loaded"), ["motion.js", "agent-render.js"]);
    await assert.rejects(loadShellScripts(page, { scripts: ["missing.js"] }), /absent from index.html: missing.js/);
    await page.close();

    for (const source of ["throw new Error('broken dependency')", "function {", "setTimeout(() => { throw new Error('async boot failed'); }, 10)"]) {
      const broken = await browser.newPage();
      await assert.rejects(loadShellScripts(broken, {
        scripts: ["motion.js"],
        transform: () => source,
        ready: () => broken.evaluate(() => new Promise(() => {})),
        timeout: 1000,
      }), /Shell fixture pageerror:/);
      assert.equal(broken.isClosed(), true, "failure cancels pending browser work");
    }

    const stuck = await browser.newPage();
    await assert.rejects(loadShellScripts(stuck, {
      scripts: [],
      ready: () => stuck.evaluate(() => new Promise(() => {})),
      timeout: 100,
    }), /startup timed out after 100ms/);
    assert.equal(stuck.isClosed(), true);
  } finally {
    await browser.close();
  }
});
