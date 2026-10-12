import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { chromium } from "playwright-core";
import { launchChromium } from "../chromium.js";

test("MCP dialog discovers Claude servers and imports one with its scope and ask approval", async (t) => {
  let browser;
  try {
    browser = process.env.SCRIBE_TEST_CHROMIUM
      ? await chromium.launch({ executablePath: process.env.SCRIBE_TEST_CHROMIUM, headless: true })
      : await launchChromium({ headless: true, args: [], purpose: "MCP dialog test" });
  } catch (error) {
    if ((error as Error).message.includes("Could not launch")) return t.skip("no Chromium installed");
    throw error;
  }
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const view = { path: "scribe/mcp.json", defaultModes: ["code", "plan", "ask"], file: { mcpServers: {} as Record<string, unknown>, workspaces: {} as Record<string, any> } };
    const candidate = (name: string, scope = "global", source = "claude") => ({ source, name, scope, file: scope === "global" ? "home/.claude.json" : `${scope}/.mcp.json`, server: { command: name, approve: "auto" } });
    const candidates = [candidate("keeper"), candidate("shared", "/project"), candidate("cursor-only", "global", "cursor"), candidate("codex-only", "global", "codex")];
    const imported: any[] = [];
    let fail = false;
    await page.route("http://mcp.test/**", async (route) => {
      const url = new URL(route.request().url());
      if (!url.pathname.startsWith("/api/agent/")) return route.fulfill({ contentType: "text/html", body: "<main></main>" });
      if (route.request().method() === "POST") {
        if (fail) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "write failed" }) });
        for (const item of route.request().postDataJSON().items) {
          imported.push(item);
          if (item.scope === "global") view.file.mcpServers[item.name] = item.server;
          else view.file.workspaces[item.scope] = { path: item.scope, mcpServers: { [item.name]: item.server } };
        }
      }
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(url.pathname.endsWith("/import") && route.request().method() === "GET" ? { candidates } : view) });
    });
    await page.goto("http://mcp.test/");
    await page.addScriptTag({ content: "window.__name = (fn) => fn;" });
    await page.evaluate(() => {
      (window as any).scribeApp = { showNotice: (text: string) => {
        let notice = document.getElementById("notice");
        if (!notice) { notice = document.createElement("div"); notice.id = "notice"; document.body.append(notice); }
        notice.textContent = text;
      } };
    });
    for (const name of ["motion.js", "dom-sync.js", "audio.js", "audio-composer.js", "agent-render.js"]) await page.addScriptTag({ content: fs.readFileSync(new URL(`../../public/${name}`, import.meta.url), "utf8") });
    const source = fs.readFileSync(new URL("../../public/agent.js", import.meta.url), "utf8");
    await page.addScriptTag({ content: source.replace(/  if \(document.readyState === "loading"\)[\s\S]*?else boot\(\);/, "  window.mcpTest = mcpServers;") });
    await page.evaluate(() => (window as any).mcpTest.open());
    assert.equal(await page.getByRole("button", { name: "Import keeper from home/.claude.json" }).count(), 1);
    assert.equal(await page.getByText("cursor-only", { exact: true }).count(), 0);
    await page.getByRole("button", { name: "Import keeper from home/.claude.json" }).click();
    await page.getByRole("button", { name: "Edit", exact: true }).waitFor();
    assert.deepEqual(imported[0], { name: "keeper", scope: "global", server: { command: "keeper", approve: "ask" } });
    assert.equal(await page.getByRole("button", { name: "Import keeper from home/.claude.json" }).count(), 0);
    // The discovered workspace is selectable even when Scribe has no entries there yet.
    await page.getByRole("combobox", { name: "Where the servers apply" }).selectOption("/project");
    const shared = page.getByRole("button", { name: "Import shared from /project/.mcp.json" });
    fail = true;
    await shared.click();
    await page.getByText("write failed", { exact: true }).waitFor();
    assert.equal(await shared.isEnabled(), true);
    fail = false;
    await shared.click();
    await page.getByRole("button", { name: "Edit", exact: true }).waitFor();
    assert.equal(imported[1].scope, "/project");
    assert.equal(imported[1].server.approve, "ask");
    await page.getByRole("button", { name: "Import…", exact: true }).click();
    const importer = page.locator(".ag-mcp-import");
    await importer.getByRole("checkbox", { name: "Codex", exact: true }).waitFor();
    assert.match(await importer.innerText(), /codex-only/);
    await importer.getByRole("checkbox", { name: /codex-only/ }).check();
    await importer.getByRole("button", { name: "Import", exact: true }).click();
    await importer.waitFor({ state: "detached" });
    assert.equal(imported[2].name, "codex-only");
    assert.equal(imported[2].scope, "global");
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
