import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyExpiredWindows,
  nextRefreshAt,
  nextResetAfter,
  parseResetsAt,
  planLimitsFromCursorUsage,
  planLimitsFromRateLimitInfo,
  planLimitsFromUsageReport,
  UNKNOWN_RESET_RETRY_MS,
  usageLimitResetsAt,
} from "./planLimits.js";

test("rate_limit_event unifiedWindows keeps utilization 0–1 and resetsAt in ms", () => {
  const now = 1_700_000_000_000;
  const next = planLimitsFromRateLimitInfo(
    {
      status: "allowed",
      unifiedWindows: {
        five_hour: { utilization: 0.84, resetsAt: 1_700_001_800 },
        seven_day: { utilization: 0.12, resetsAt: 1_700_500_000 },
      },
    },
    now
  );
  assert.deepEqual(next, {
    at: now,
    status: "allowed",
    windows: [
      { id: "five_hour", label: "5-hour", utilization: 0.84, resetsAt: 1_700_001_800_000 },
      { id: "seven_day", label: "Weekly", utilization: 0.12, resetsAt: 1_700_500_000_000 },
    ],
  });
});

test("a rate_limit_event without window figures keeps the last known ones", () => {
  const prev = planLimitsFromRateLimitInfo({ rateLimitType: "five_hour", utilization: 0.5, resetsAt: 100 }, 1)!;
  const next = planLimitsFromRateLimitInfo({ status: "allowed_warning" }, 2, prev);
  assert.equal(next?.windows[0]?.utilization, 0.5);
  assert.equal(next?.status, "allowed_warning");
  assert.equal(next?.at, 2);
});

test("get_usage report converts percent utilization and ISO reset times", () => {
  const now = 1_700_000_000_000;
  const next = planLimitsFromUsageReport(
    {
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 74, resets_at: "2024-01-01T12:00:00.000Z" },
        seven_day: { utilization: 10, resets_at: "2024-01-07T00:00:00.000Z" },
        extra_usage: { is_enabled: true, utilization: 0 },
      },
    },
    now
  );
  assert.equal(next?.windows[0]?.utilization, 0.74);
  assert.equal(next?.windows[0]?.resetsAt, Date.parse("2024-01-01T12:00:00.000Z"));
  assert.equal(next?.windows[1]?.utilization, 0.1);
  assert.equal(next?.overage, undefined);
});

test("get_usage is ignored when plan limits do not apply", () => {
  assert.equal(planLimitsFromUsageReport({ rate_limits_available: false, rate_limits: null }, 1), null);
  assert.equal(planLimitsFromUsageReport({ rate_limits_available: true, rate_limits: {} }, 1), null);
});

test("expired windows drop to 0% and roll the 5-hour reset forward", () => {
  const now = 1_700_000_000_000;
  const limits = {
    at: now - 60_000,
    windows: [
      { id: "five_hour", label: "5-hour", utilization: 0.9, resetsAt: now - 1000 },
      { id: "seven_day", label: "Weekly", utilization: 0.4, resetsAt: now + 86_400_000 },
    ],
  };
  const next = applyExpiredWindows(limits, now);
  assert.equal(next.windows[0]?.utilization, 0);
  assert.equal(next.windows[0]?.resetsAt, now - 1000 + 5 * 60 * 60 * 1000);
  assert.equal(next.windows[1]?.utilization, 0.4);
  assert.equal(next.at, now);
  assert.equal(applyExpiredWindows(next, now), next);
});

test("nextRefreshAt is the soonest window reset", () => {
  const limits = {
    at: 1,
    windows: [
      { id: "five_hour", label: "5-hour", utilization: 0.2, resetsAt: 50 },
      { id: "seven_day", label: "Weekly", utilization: 0.2, resetsAt: 20 },
    ],
  };
  assert.equal(nextRefreshAt(limits), 20);
  assert.equal(nextRefreshAt({ at: 1, windows: [{ id: "overage", label: "Extra usage", utilization: 1 }] }), null);
});

test("parseResetsAt accepts seconds, milliseconds, and ISO strings", () => {
  assert.equal(parseResetsAt(1_700_000_000), 1_700_000_000_000);
  assert.equal(parseResetsAt(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(parseResetsAt("2024-01-01T00:00:00.000Z"), Date.parse("2024-01-01T00:00:00.000Z"));
  assert.equal(parseResetsAt("nope"), undefined);
});

test("nextResetAfter walks forward in window-sized steps", () => {
  const start = 1_000;
  assert.equal(nextResetAfter("five_hour", start, start), start + 5 * 60 * 60 * 1000);
  assert.equal(nextResetAfter("seven_day_opus", start, start + 8 * 24 * 60 * 60 * 1000), start + 14 * 24 * 60 * 60 * 1000);
  assert.equal(nextResetAfter("overage", start, start), undefined);
});

test("usageLimitResetsAt tells a plan limit from other failures and finds when it resets", () => {
  const limits = {
    at: 1500,
    status: "rejected",
    windows: [
      { id: "five_hour", label: "5-hour", utilization: 1, resetsAt: 9000 },
      { id: "seven_day", label: "Weekly", utilization: 0.4, resetsAt: 7000 },
    ],
  };
  assert.equal(usageLimitResetsAt("Claude AI usage limit reached|1759339200", undefined, 1000, 2000), 1759339200 * 1000);
  // The exhausted window's reset, not the soonest one.
  assert.equal(usageLimitResetsAt("You've hit your limit · resets 3pm", limits, 1000, 2000), 9000);
  // A rejected rate_limit_event during the turn is enough, whatever the error says.
  assert.equal(usageLimitResetsAt("Claude reported an error", limits, 1000, 2000), 9000);
  // ...but not one from an earlier turn.
  assert.equal(usageLimitResetsAt("Claude reported an error", limits, 1600, 2000), undefined);
  assert.equal(usageLimitResetsAt("credit balance too low", { ...limits, status: "allowed" }, 1000, 2000), undefined);
  // A limit with no known reset tries again later.
  assert.equal(usageLimitResetsAt("5-hour limit reached ∙ resets 2am", undefined, 1000, 2000), 2000 + UNKNOWN_RESET_RETRY_MS);
});

test("Cursor GetCurrentPeriodUsage maps Included, Auto, API and on-demand to windows reset at the cycle end", () => {
  const now = 1_700_000_000_000;
  const next = planLimitsFromCursorUsage(
    {
      billingCycleStart: "1699000000000",
      billingCycleEnd: "1701000000000",
      planUsage: { totalSpend: 3000, includedSpend: 2000, limit: 4000, totalPercentUsed: 50, autoPercentUsed: 20, apiPercentUsed: 80 },
      spendLimitUsage: { individualLimit: 1000, individualUsed: 250, limitType: "user" },
      enabled: true,
    },
    now
  );
  assert.deepEqual(next, {
    at: now,
    overage: true,
    windows: [
      { id: "cursor_included", label: "Included", utilization: 0.5, resetsAt: 1_701_000_000_000 },
      { id: "cursor_auto", label: "Auto", utilization: 0.2, resetsAt: 1_701_000_000_000 },
      { id: "cursor_api", label: "API", utilization: 0.8, resetsAt: 1_701_000_000_000 },
      { id: "cursor_on_demand", label: "On-demand", utilization: 0.25, resetsAt: 1_701_000_000_000 },
    ],
  });
});

test("Cursor usage without percents falls back to included spend over the limit, and skips an unset on-demand limit", () => {
  const next = planLimitsFromCursorUsage({ billingCycleEnd: "0", planUsage: { includedSpend: 1000, limit: 4000 }, spendLimitUsage: { individualUsed: 0 } }, 1);
  assert.deepEqual(next, { at: 1, windows: [{ id: "cursor_included", label: "Included", utilization: 0.25 }] });
  assert.equal(planLimitsFromCursorUsage({}, 1), null);
});
