import { checkPermission, type PermissionGrant, type PermissionValue } from "../pagePermissions.js";
import { MAX_QUESTIONS, mlService, type MlService } from "./service.js";
import type { MlAnswers, MlErrorKind } from "./types.js";

/**
 * scribe.ml for pages (docs/classification-api-design.md): a page asks the decision service about
 * text of its own. The user allows it per page (the ml.decide permission), the page never learns
 * which source answers, and each page has its own limits so one page cannot use up the classifier.
 */
export const PAGE_ML_PERMISSION = "ml.decide";
export const PAGE_ML_FEATURE = "pages";
/** A page sends a card or a note, not a whole board. */
export const PAGE_MAX_STATE_CHARS = 20_000;
export const PAGE_CALLS_PER_MINUTE = 30;
export const PAGE_CALLS_PER_HOUR = 300;
/** Calls one page may have at the classifier at once; hooks and search share its few slots. */
export const PAGE_MAX_IN_FLIGHT = 2;
export const PAGE_MAX_TIMEOUT_MS = 15_000;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export type PageMlError = MlErrorKind | "denied";

export type PageDecideResult =
  | { ok: true; answers: MlAnswers; cached: boolean; ms: number }
  | { ok: false; error: PageMlError; message: string; permission?: string; retryAfterMs?: number };

export type PageCapabilities = {
  ok: true;
  /** A decide() from this page would reach the classifier now. */
  available: boolean;
  /** Why not, when it would not: the page's permission first, then Scribe's own setup. */
  reason?: "denied" | "disabled" | "no_source";
  permission: PermissionValue;
  types: Array<"yesno" | "choice" | "score">;
  limits: { stateChars: number; questions: number; perMinute: number; perHour: number };
};

export type PageMlOptions = { service?: MlService; now?: () => number };

export class PageMl {
  private readonly service: MlService;
  private readonly now: () => number;
  /** Call times of the last hour, by page. */
  private readonly calls = new Map<string, number[]>();
  private readonly inFlight = new Map<string, number>();

  constructor(options: PageMlOptions = {}) {
    this.service = options.service ?? mlService();
    this.now = options.now ?? Date.now;
  }

  capabilities(grants: Map<string, PermissionGrant>): PageCapabilities {
    const permission = checkPermission(grants, { perm: PAGE_ML_PERMISSION });
    const view = this.service.view();
    const on = view.features.find((f) => f.id === PAGE_ML_FEATURE)?.on !== false;
    const hasSource = view.sources.some((s) => s.id === view.defaultSource);
    const reason = permission !== "allow" ? "denied" : !on ? "disabled" : !hasSource ? "no_source" : undefined;
    return {
      ok: true,
      available: !reason,
      ...(reason ? { reason } : {}),
      permission,
      types: ["yesno", "choice", "score"],
      limits: { stateChars: PAGE_MAX_STATE_CHARS, questions: MAX_QUESTIONS, perMinute: PAGE_CALLS_PER_MINUTE, perHour: PAGE_CALLS_PER_HOUR },
    };
  }

  /**
   * One decide() for a page. Never asks the user: without the permission it is refused, and the
   * page asks up front with scribe.permissions.request. Never throws.
   */
  async decide(tabId: string, grants: Map<string, PermissionGrant>, body: unknown): Promise<PageDecideResult> {
    if (checkPermission(grants, { perm: PAGE_ML_PERMISSION }) !== "allow") {
      return { ok: false, error: "denied", message: "This page is not allowed to use the classifier", permission: PAGE_ML_PERMISSION };
    }
    const input = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
    const size = stateSize(input.state);
    if (size > PAGE_MAX_STATE_CHARS) {
      return { ok: false, error: "input_too_large", message: `state is ${size} characters; a page may send ${PAGE_MAX_STATE_CHARS}` };
    }
    const wait = this.take(tabId);
    if (wait > 0) {
      return { ok: false, error: "rate_limited", message: "This page has asked the classifier too often; try again later", retryAfterMs: wait };
    }
    if ((this.inFlight.get(tabId) ?? 0) >= PAGE_MAX_IN_FLIGHT) {
      return { ok: false, error: "busy", message: "This page's earlier questions are still being answered" };
    }
    this.inFlight.set(tabId, (this.inFlight.get(tabId) ?? 0) + 1);
    try {
      const timeoutMs = typeof input.timeoutMs === "number" && input.timeoutMs > 0 ? Math.min(input.timeoutMs, PAGE_MAX_TIMEOUT_MS) : undefined;
      const result = await this.service.decide(input.state, input.questions, { feature: PAGE_ML_FEATURE, timeoutMs });
      // The source and model stay with Scribe: the page gets the answers only.
      return result.ok
        ? { ok: true, answers: result.answers, cached: result.cached, ms: result.ms }
        : { ok: false, error: result.error, message: result.message };
    } finally {
      const left = (this.inFlight.get(tabId) ?? 1) - 1;
      if (left > 0) this.inFlight.set(tabId, left);
      else this.inFlight.delete(tabId);
    }
  }

  /** Count a call against the page's limits: 0 when it may go, else how long until it may. */
  private take(tabId: string): number {
    const now = this.now();
    const times = (this.calls.get(tabId) ?? []).filter((at) => now - at < HOUR);
    const lastMinute = times.filter((at) => now - at < MINUTE);
    let wait = 0;
    if (times.length >= PAGE_CALLS_PER_HOUR) wait = times[times.length - PAGE_CALLS_PER_HOUR] + HOUR - now;
    else if (lastMinute.length >= PAGE_CALLS_PER_MINUTE) wait = lastMinute[lastMinute.length - PAGE_CALLS_PER_MINUTE] + MINUTE - now;
    if (!wait) times.push(now);
    if (times.length) this.calls.set(tabId, times);
    else this.calls.delete(tabId);
    return wait;
  }
}

function stateSize(state: unknown): number {
  if (typeof state === "string") return state.length;
  try {
    return JSON.stringify(state)?.length ?? 0;
  } catch {
    // Not plain JSON: the service says so.
    return 0;
  }
}

let shared: PageMl | undefined;

/** The daemon's one page gate in front of the decision service. */
export function pageMl(): PageMl {
  return (shared ??= new PageMl());
}
