import { estimateCost, type CostRecord, type MessageTiming, type RateSnapshot, type TokenRates } from "./pricing.js";

export type DeepSeekProfile = {
  id: string;
  model: string;
  reference: string;
  verifiedAt: number;
  /** Start of reviewed applicability, not a claimed provider publication date. */
  effectiveFrom: number;
  effectiveTo: number;
  timezone: "UTC";
  windows: [number, number][];
  rates: { peak: TokenRates; offPeak: TokenRates };
  calendar: {
    id: string; reference: string; coverageFrom: string; coverageTo: string;
    timezone: "Asia/Shanghai"; providerConfirmed: false;
    holidays: [string, string][];
  };
};
export type TariffDecision = {
  status: "unresolved";
  selected: "catalog" | "unknown";
  profile: DeepSeekProfile;
  observedWindow?: "peak" | "offPeak" | "holiday" | "calendar-unavailable";
  boundary: "crossed" | "not-observed" | "unavailable";
  reasons: string[];
};

const reviewed = Date.parse("2026-10-12T00:00:00Z");
const calendar: DeepSeekProfile["calendar"] = {
  id: "cn-state-council-2026-notice7-reviewed-2026-10-12",
  reference: "https://en.bjhd.gov.cn/workinginhaidian/supportingservices/publicholidays/202512/t20251211_4797062.shtml",
  coverageFrom: "2026-01-01", coverageTo: "2027-01-01",
  timezone: "Asia/Shanghai", providerConfirmed: false,
  holidays: [["2026-01-01", "2026-01-03"], ["2026-02-15", "2026-02-23"], ["2026-04-04", "2026-04-06"], ["2026-05-01", "2026-05-05"], ["2026-06-19", "2026-06-21"], ["2026-09-25", "2026-09-27"], ["2026-10-01", "2026-10-07"]],
};

/** No network refresh. Freshness and applicability are separate: this review covers
 * future calls until replaced, but never dates before the review or beyond 2026. */
export function deepSeekProfile(provider: string, model: string, endpoint?: string): DeepSeekProfile | undefined {
  if (endpoint) {
    try {
      const url = new URL(endpoint);
      if (url.origin !== "https://api.deepseek.com" || !["", "/", "/v1", "/v1/", "/beta", "/beta/"].includes(url.pathname)) return;
    } catch { return; }
  } else if (provider !== "deepseek") return;
  const flash = ["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"].includes(model);
  if (!flash && model !== "deepseek-v4-pro") return;
  return {
    id: `deepseek-${flash ? "flash" : "v4-pro"}-reviewed-2026-10-12`, model,
    reference: "https://api-docs.deepseek.com/quick_start/pricing/",
    verifiedAt: reviewed, effectiveFrom: reviewed, effectiveTo: Date.parse("2027-01-01T00:00:00Z"),
    timezone: "UTC", windows: [[60, 240], [360, 600]],
    rates: flash
      ? { peak: { input: "0.3", output: "1.2", cacheRead: "0.006" }, offPeak: { input: "0.15", output: "0.6", cacheRead: "0.003" } }
      : { peak: { input: "1.32", output: "3.96", cacheRead: "0.044" }, offPeak: { input: "0.66", output: "1.98", cacheRead: "0.022" } },
    calendar: structuredClone(calendar),
  };
}

/** An observation under an explicitly unconfirmed holiday-date interpretation.
 * Weekdays/windows are UTC. Substitute working weekends still stay off-peak. */
export function observedWindow(profile: DeepSeekProfile, at: number): NonNullable<TariffDecision["observedWindow"]> {
  const date = new Date(at);
  const holidayDate = new Intl.DateTimeFormat("en-CA", { timeZone: profile.calendar.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  const c = profile.calendar;
  if (holidayDate < c.coverageFrom || holidayDate >= c.coverageTo) return "calendar-unavailable";
  if (c.holidays.some(([from, to]) => holidayDate >= from && holidayDate <= to)) return "holiday";
  if ([0, 6].includes(date.getUTCDay())) return "offPeak";
  const minute = date.getUTCHours() * 60 + date.getUTCMinutes();
  return profile.windows.some(([from, to]) => minute >= from && minute < to) ? "peak" : "offPeak";
}

/** Detect intervening transitions too, even when the two endpoints match. */
function crossed(profile: DeepSeekProfile, from: number, to: number): boolean {
  const initial = observedWindow(profile, from);
  if (observedWindow(profile, to) !== initial) return true;
  // UTC day/window edges and Shanghai date edges, including intervening holidays.
  for (let day = Math.floor(from / 86400000) * 86400000; day <= to; day += 86400000) {
    for (const minute of [0, ...profile.windows.flat(), 960]) {
      const at = day + minute * 60000;
      if (at > from && at < to && observedWindow(profile, at) !== initial) return true;
    }
    // Never scan outside the supported calendar year indefinitely.
    if (day - from > 366 * 86400000) return true;
  }
  return false;
}

/** Until dispatch/retry coverage and provider conventions are confirmed, retain
 * the catalog estimate. Reviewed tariff candidates are audit evidence only. */
export function recordTariff(record: CostRecord, timing: MessageTiming): CostRecord {
  record.timing = { ...timing };
  const profile = record.rate.tariffProfile;
  if (!profile || record.rate.origin === "custom") return record;
  const start = timing.payloadObservedAt;
  const validTime = start !== undefined && Number.isFinite(start) && Number.isFinite(timing.endedAt) && timing.endedAt >= start;
  const reasons = ["HTTP dispatch and internal retry timing unavailable", "DeepSeek boundary billing timestamp unconfirmed", "DeepSeek holiday timezone and calendar interpretation unconfirmed"];
  const applicable = validTime && start >= profile.effectiveFrom && timing.endedAt < profile.effectiveTo;
  if (!applicable) reasons.push("Reviewed tariff applicability unavailable for this message");
  const window = validTime ? observedWindow(profile, start) : undefined;
  if (window === "calendar-unavailable" || (validTime && observedWindow(profile, timing.endedAt) === "calendar-unavailable")) reasons.push("Holiday calendar coverage unavailable");
  const boundary = validTime ? (crossed(profile, start, timing.endedAt) ? "crossed" : "not-observed") : "unavailable";
  if (boundary === "crossed") reasons.push("Observed message interval crosses a tariff/calendar boundary");
  record.tariff = { status: "unresolved", selected: record.rate.origin === "catalog" ? "catalog" : "unknown", profile: structuredClone(profile), ...(window ? { observedWindow: window } : {}), boundary, reasons };
  record.missing.push(...reasons);
  if (applicable) {
    const amounts = Object.values(profile.rates).map((rates) => estimateCost(record.id, record.at, { ...record.rate, rates } as RateSnapshot, record.tokens));
    if (amounts.every((r) => !r.missing.length && r.estimatedUsd !== undefined)) {
      record.tariffCandidatesUsd = { lower: Math.min(...amounts.map((r) => r.estimatedUsd!)), upper: Math.max(...amounts.map((r) => r.estimatedUsd!)) };
    }
  }
  return record;
}
