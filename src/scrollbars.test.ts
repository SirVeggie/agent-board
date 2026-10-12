import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { launchChromium } from './chromium.js';

test('floating scrollbars keep layout stable, reveal nearby, fade and drag both axes', async () => {
  const browser = await launchChromium({ headless: true, args: [], purpose: 'Floating scrollbar test' });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="surface" style="position:absolute;left:100px;top:100px;width:300px;height:150px;overflow:auto;transition:height 300ms linear"><div style="width:600px;height:250px">Content</div></div>');
    await page.addStyleTag({ content: fs.readFileSync(new URL('../public/app.css', import.meta.url), 'utf8') });
    await page.addScriptTag({ content: fs.readFileSync(new URL('../public/scrollbars.js', import.meta.url), 'utf8') });
    const surface = page.locator('#surface');
    await page.waitForFunction(() => document.querySelectorAll('.overlay-scrollbar:not([hidden])').length === 2);
    assert.equal(await surface.evaluate(el => el.clientWidth), 300);
    await page.mouse.move(380, 130); // Near the edge, outside the 12px handle.
    await page.waitForFunction(() => document.querySelector('.overlay-scrollbar.vertical')!.classList.contains('active'));
    await page.mouse.move(50, 50);
    await surface.evaluate(el => { el.scrollTop = 30; });
    await page.waitForFunction(() => document.querySelector('.overlay-scrollbar.vertical')!.classList.contains('active'));
    await page.waitForFunction(() => !document.querySelector('.overlay-scrollbar.vertical')!.classList.contains('active'));
    const vertical = await page.locator('.overlay-scrollbar.vertical .overlay-scrollbar-thumb').boundingBox();
    assert.ok(vertical);
    await page.mouse.move(vertical.x + 6, vertical.y + 10);
    await page.mouse.down();
    await page.mouse.move(vertical.x + 6, vertical.y + 45);
    await page.mouse.up();
    assert.ok(await surface.evaluate(el => el.scrollTop) > 50);
    const horizontal = await page.locator('.overlay-scrollbar.horizontal .overlay-scrollbar-thumb').boundingBox();
    assert.ok(horizontal);
    await page.mouse.move(horizontal.x + 10, horizontal.y + 6);
    await page.mouse.down();
    await page.mouse.move(horizontal.x + 80, horizontal.y + 6);
    await page.mouse.up();
    assert.ok(await surface.evaluate(el => el.scrollLeft) > 100);
    // Grow through the overflow threshold. Every animation frame must retain full content width.
    const widths = await surface.evaluate(async el => {
      el.style.height = '350px';
      const widths: number[] = [];
      const start = performance.now();
      while (performance.now() - start < 400) {
        await new Promise(requestAnimationFrame);
        widths.push(el.clientWidth);
      }
      return widths;
    });
    assert.ok(widths.length > 3);
    assert.ok(widths.every(width => width === 300));
    await page.waitForFunction(() => (document.querySelector('.overlay-scrollbar.vertical') as HTMLElement).hidden);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await page.locator('.overlay-scrollbar.horizontal').evaluate(el => getComputedStyle(el).transitionDuration), '0s');
  } finally { await browser.close(); }
});

test('floating handles follow dynamic surfaces and disappear behind a modal or on removal', async () => {
  const browser = await launchChromium({ headless: true, args: [], purpose: 'Floating scrollbar lifecycle test' });
  try {
    const page = await browser.newPage();
    await page.setContent('<main></main>');
    await page.addStyleTag({ content: fs.readFileSync(new URL('../public/app.css', import.meta.url), 'utf8') });
    await page.addScriptTag({ content: fs.readFileSync(new URL('../public/scrollbars.js', import.meta.url), 'utf8') });
    await page.evaluate(() => {
      document.querySelector('main')!.innerHTML = '<textarea aria-label="Text" style="position:absolute;left:100px;top:100px;width:300px;height:100px;overflow:auto">' + 'Line\n'.repeat(50) + '</textarea>';
    });
    await page.waitForFunction(() => document.querySelector('.overlay-scrollbar:not([hidden])'));
    await page.evaluate(() => {
      const modal = document.createElement('div');
      modal.id = 'cover';
      modal.style.cssText = 'position:fixed;inset:0;background:black;z-index:40';
      document.body.append(modal);
    });
    await page.waitForFunction(() => !document.querySelector('.overlay-scrollbar:not([hidden])'));
    await page.locator('#cover').evaluate(el => el.remove());
    await page.waitForFunction(() => document.querySelector('.overlay-scrollbar:not([hidden])'));
    await page.locator('textarea').evaluate(el => { el.hidden = true; });
    await page.waitForFunction(() => !document.querySelector('.overlay-scrollbar:not([hidden])'));
    await page.locator('textarea').evaluate(el => el.remove());
    await page.waitForFunction(() => !document.querySelector('.overlay-scrollbar'));
  } finally { await browser.close(); }
});
