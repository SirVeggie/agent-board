import { allowedGrants, scopeLabel, type AccessScope, type ScopeLookup } from "./threadAccess.js";
import type { Thread } from "./types.js";

/**
 * What the user granted a thread while it ran (web requests, thread access), as rows the chat
 * can list and take back one by one. key names the grant for a revoke.
 */
export type GrantRow = { kind: "web" | "threads" | "helpers"; key: string; label: string };

type GrantThread = Pick<Thread, "cwd" | "worktree" | "scope" | "webGrants" | "threadGrants" | "helpersAllowed">;

function scopeKey(scope: AccessScope): string {
  if (scope.kind === "all") return "threads:all";
  if (scope.kind === "workspace") return `threads:workspace:${scope.path}`;
  return `threads:${scope.kind}:${scope.id}`;
}

/** The thread's grants that are in effect: web first (any site, then domains), then readable thread scopes, then helper agents. */
export function grantRows(thread: GrantThread, lookup?: ScopeLookup): GrantRow[] {
  const rows: GrantRow[] = [];
  if (thread.webGrants?.all) rows.push({ kind: "web", key: "web:*", label: "Any website" });
  for (const domain of thread.webGrants?.domains ?? []) rows.push({ kind: "web", key: `web:${domain}`, label: domain });
  for (const scope of allowedGrants(thread, thread.threadGrants ?? [])) {
    const label = scopeLabel(scope, lookup);
    rows.push({ kind: "threads", key: scopeKey(scope), label: label.charAt(0).toUpperCase() + label.slice(1) });
  }
  if (thread.helpersAllowed) rows.push({ kind: "helpers", key: "helpers", label: "Start helpers without asking" });
  return rows;
}

/** The thread's grant fields without the one key names; null when nothing matches. */
export function revokeGrant(thread: GrantThread, key: string): Pick<Thread, "webGrants" | "threadGrants" | "helpersAllowed"> | null {
  if (key === "helpers") {
    return thread.helpersAllowed ? { webGrants: thread.webGrants, threadGrants: thread.threadGrants, helpersAllowed: false } : null;
  }
  if (key === "web:*" && thread.webGrants?.all) {
    return { webGrants: { ...thread.webGrants, all: false }, threadGrants: thread.threadGrants };
  }
  if (key.startsWith("web:")) {
    const domain = key.slice(4);
    const domains = thread.webGrants?.domains ?? [];
    if (!domains.includes(domain)) return null;
    return { webGrants: { ...thread.webGrants, domains: domains.filter((d) => d !== domain) }, threadGrants: thread.threadGrants };
  }
  const scopes = thread.threadGrants ?? [];
  const kept = scopes.filter((s) => scopeKey(s) !== key);
  if (kept.length === scopes.length) return null;
  return { webGrants: thread.webGrants, threadGrants: kept };
}
