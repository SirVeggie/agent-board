import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { launchChromium } from "./chromium.js";

test("shell effects settle on disable, entries clear once, and component buttons override defaults", async () => {
  const browser = await launchChromium({ headless: true, args: [], purpose: "Shell motion policy test" });
  try {
    const page = await browser.newPage();
    await page.setContent('<button class="test-control">Test</button><div class="agent-toggle busy"><svg></svg></div><div class="newpage-card"></div><div id="row"></div>');
    await page.addStyleTag({ content: ".test-control { height: 12px; background: rgb(255, 0, 0); }" });
    for (const name of ["app.css", "agent.css"]) {
      await page.addStyleTag({ content: fs.readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8") });
    }
    await page.addScriptTag({ content: fs.readFileSync(new URL("../public/motion.js", import.meta.url), "utf8") });
    await page.waitForFunction(() => getComputedStyle(document.querySelector("button")!).backgroundColor === "rgb(255, 0, 0)");
    const styles = await page.evaluate(() => {
      const button = getComputedStyle(document.querySelector("button")!);
      return { height: button.height, background: button.backgroundColor, blur: getComputedStyle(document.querySelector(".newpage-card")!).backdropFilter };
    });
    assert.deepEqual(styles, { height: "12px", background: "rgb(255, 0, 0)", blur: "none" });
    await page.evaluate(() => (window as any).scribeMotion.enter(document.querySelector("#row")));
    await page.waitForFunction(() => !document.querySelector("#row")!.hasAttribute("data-fx-enter"));
    const settled = await page.evaluate(async () => {
      const motion = (window as any).scribeMotion;
      const animation = motion.reveal(document.querySelector("#row"), false, { fill: "both" });
      document.documentElement.classList.add("fx-off");
      await animation.finished;
      const disabled = !motion.enabled();
      const paused = document.querySelector("svg")!.getAnimations().every(a => a.playState === "paused");
      const instant = motion.reveal(document.querySelector("#row"), true);
      const duration = instant.effect.getTiming().duration;
      animation.cancel();
      return { disabled, paused, duration };
    });
    assert.deepEqual(settled, { disabled: true, paused: true, duration: 0 });
    await page.evaluate(() => document.documentElement.classList.remove("fx-off"));
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(await page.evaluate(() => (window as any).scribeMotion.enabled()), false);
    assert.equal(await page.locator("svg").evaluate(node => node.getAnimations().length), 0);
  } finally {
    await browser.close();
  }
});
