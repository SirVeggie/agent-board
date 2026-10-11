import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_SDKS, createSdkUpdateCheck, installedSdkVersion, newerSdkVersion } from "./sdkUpdates.js";

test("SDK versions compare numeric components and SemVer prereleases", () => {
  for (const [latest, installed, expected] of [
    ["1.0.10", "1.0.9", true], ["2.0.0", "1.99.99", true],
    ["1.0.0", "1.0.0", false], ["1.0.0", "2.0.0", false],
    ["1.0.0", "1.0.0-rc.1", true], ["1.0.0-rc.1", "1.0.0", false],
    ["1.0.0-rc.10", "1.0.0-rc.2", true], ["1.0.0-rc", "1.0.0-beta", true],
    ["1.0.0-beta", "1.0.0-beta.1", false], ["1.0.0-beta", "1.0.0-1", true],
    ["1.0.0+build.2", "1.0.0+build.1", false],
    ["invalid", "1.0.0", null], ["1.0.0", "^1.0.0", null], ["1.0.0-01", "1.0.0", null],
  ] as const) assert.equal(newerSdkVersion(latest, installed), expected, `${latest} vs ${installed}`);
});

test("installed versions resolve the actual SDK manifests, including ESM-only packages", () => {
  for (const sdk of AGENT_SDKS) assert.match(installedSdkVersion(sdk.package) ?? "", /^\d+\.\d+\.\d+/, sdk.package);
  assert.equal(installedSdkVersion("@scribe/nonexistent-sdk"), null);
});

test("checks use fixed registry endpoints, share pending requests and cache with explicit refresh", async () => {
  let at = 10, requests = 0;
  const check = createSdkUpdateCheck({
    now: () => at, installed: () => "1.0.9",
    fetch: (async (url, options) => {
      requests++;
      assert.ok(AGENT_SDKS.some((sdk) => url === `https://registry.npmjs.org/${encodeURIComponent(sdk.package)}/latest`));
      assert.ok(options?.signal);
      return new Response(JSON.stringify({ version: "1.0.10" }));
    }) as typeof fetch,
  });
  const first = check();
  assert.equal(check(true), first);
  const report = await first;
  assert.equal(report.checkedAt, 10);
  assert.ok(report.sdks.every((sdk) => sdk.outdated && sdk.installed === "1.0.9" && sdk.latest === "1.0.10"));
  assert.equal(await check(), report);
  assert.equal(requests, AGENT_SDKS.length);
  await check(true);
  assert.equal(requests, AGENT_SDKS.length * 2);
  at += 6 * 60 * 60_000;
  await check();
  assert.equal(requests, AGENT_SDKS.length * 3);
});

test("partial failures and unknown installed versions are never reported as current and retry sooner", async () => {
  let at = 1, requests = 0;
  const check = createSdkUpdateCheck({
    now: () => at,
    installed: (name) => name === AGENT_SDKS[4].package ? null : "1.0.0",
    fetch: (async () => {
      const index = requests++ % AGENT_SDKS.length;
      if (index === 0) throw new DOMException("timeout", "TimeoutError");
      if (index === 1) return new Response("", { status: 503 });
      if (index === 2) return new Response(JSON.stringify({ version: "bad" }));
      return new Response(JSON.stringify({ version: "1.0.0" }));
    }) as typeof fetch,
  });
  const report = await check();
  assert.deepEqual(report.sdks.map((sdk) => sdk.outdated), [null, null, null, false, null]);
  assert.match(report.sdks[0].error!, /timed out/);
  assert.match(report.sdks[1].error!, /503/);
  assert.match(report.sdks[2].error!, /invalid version/);
  assert.match(report.sdks[4].error!, /could not be read/);
  at += 5 * 60_000;
  await check();
  assert.equal(requests, AGENT_SDKS.length * 2);
});
