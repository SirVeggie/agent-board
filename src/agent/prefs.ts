import path from "node:path";
import type { ApprovalPolicy, ProviderId, Thread, ThreadMode, ThreadScope, WebAccess } from "./types.js";
import { DEFAULT_WEB_ALLOWLIST } from "./webAccess.js";

export type ModelChoice = { effort: string | null; modelParams: Record<string, string> };

/** Last-used chat settings. New threads and drafts start from these. */
export type Prefs = {
  provider: ProviderId;
  models: Partial<Record<ProviderId, string>>;
  efforts: Partial<Record<ProviderId, string | null>>;
  modelParams: Partial<Record<ProviderId, Record<string, string>>>;
  /**
   * Last effort and model params (fast, context) per model, keyed "provider:modelId". Switching to a
   * model brings back its own; efforts and modelParams above are the last used per provider.
   */
  modelSettings: Record<string, ModelChoice>;
  mode: ThreadMode;
  approval: ApprovalPolicy;
  /** Last Code-mode approval per provider. `approval` is the most recently used, and the fallback. */
  approvals: Partial<Record<ProviderId, ApprovalPolicy>>;
  web: WebAccess;
  /** Domains a thread with limited web access may search and fetch (subdomains included). */
  webAllowlist: string[];
  /**
   * Run the hooks in Claude Code's settings files and plugins in Claude threads. Off by default: a
   * fail-closed hook meant for the user's own terminal sessions can deny every tool call here.
   */
  claudeHooks: boolean;
  /**
   * Experimental: Cursor threads set to Ask or Edits run shell commands through Scribe, which asks
   * first, instead of Cursor's own shell under Auto-review. Board workers keep Cursor's shell.
   */
  cursorHostShell: boolean;
  recentWorkspaces: string[];
  /**
   * Last workspace used for a folder scope ("folder:<id>"), so new threads there start in it.
   * Still recorded for pages; new page threads take the latest AI reply on that page instead.
   */
  scopeWorkspaces: Record<string, string>;
  /** Starred models as "provider:modelId", in the order they were starred. Ctrl+' cycles them. */
  favoriteModels: string[];
  /** Last worktree choice per workspace (see workspaceKey), the default for new threads there. */
  worktrees: Record<string, boolean>;
  /** Writes the summary a fork to another provider starts from. */
  summarizer: { provider: ProviderId; model: string };
};

export const DEFAULT_PREFS: Prefs = {
  provider: "cursor",
  models: { cursor: "composer-2.5", claude: "default" },
  efforts: {},
  modelParams: { cursor: { fast: "false" } },
  modelSettings: {},
  mode: "code",
  approval: "ask",
  approvals: {},
  web: "on",
  webAllowlist: DEFAULT_WEB_ALLOWLIST,
  claudeHooks: false,
  cursorHostShell: false,
  recentWorkspaces: [],
  scopeWorkspaces: {},
  favoriteModels: [],
  worktrees: {},
  summarizer: { provider: "claude", model: "haiku" },
};

/** Same as dirKey in public/agent.js, which looks up these keys for new threads. */
export function workspaceKey(dir: string): string {
  return dir.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

export function modelKey(provider: ProviderId, model: string): string {
  return `${provider}:${model}`;
}

/** The effort and params a thread switching to this model starts with: its last ones, else the model's defaults. */
export function modelChoice(prefs: Prefs, provider: ProviderId, model: string): ModelChoice {
  const saved = prefs.modelSettings[modelKey(provider, model)];
  if (saved) return { effort: saved.effort ?? null, modelParams: { ...(saved.modelParams || {}) } };
  return { effort: null, modelParams: { ...(DEFAULT_PREFS.modelParams[provider] || {}) } };
}

/** Prefs saved before modelSettings existed: each provider's last model keeps the effort and params it had. */
export function seedModelSettings(saved: Partial<Prefs>): Prefs["modelSettings"] {
  if (saved.modelSettings) return saved.modelSettings;
  const seeded: Prefs["modelSettings"] = {};
  for (const [provider, model] of Object.entries(saved.models || {}) as [ProviderId, string][]) {
    if (!model) continue;
    seeded[modelKey(provider, model)] = { effort: saved.efforts?.[provider] ?? null, modelParams: { ...(saved.modelParams?.[provider] || {}) } };
  }
  return seeded;
}

type ChoiceThread = {
  provider: ProviderId;
  model: string;
  effort: string | null;
  modelParams: Record<string, string>;
  mode: ThreadMode;
  approval: ApprovalPolicy;
  web: WebAccess;
  scope: ThreadScope;
  cwd: string | null;
  useWorktree?: boolean;
};

/** Every setting a new thread should inherit, for rememberChoices. */
export function settingPatch(thread: ChoiceThread): Partial<Thread> {
  return {
    provider: thread.provider,
    model: thread.model,
    effort: thread.effort,
    modelParams: thread.modelParams,
    mode: thread.mode,
    approval: thread.approval,
    web: thread.web,
    ...(thread.cwd ? { cwd: thread.cwd } : {}),
    ...(typeof thread.useWorktree === "boolean" ? { useWorktree: thread.useWorktree } : {}),
  };
}

/**
 * Prefs keys to write so the next new thread matches `thread`, given which fields `patch` changed.
 * Empty object means nothing to store.
 */
export function prefsPatchFromChoices(prefs: Prefs, thread: ChoiceThread, patch: Partial<Thread>): Partial<Prefs> {
  const next: Partial<Prefs> = {};
  if (patch.model || patch.provider) {
    next.provider = thread.provider;
    next.models = { ...prefs.models, [thread.provider]: thread.model };
  }
  if (patch.effort !== undefined) next.efforts = { ...prefs.efforts, [thread.provider]: thread.effort };
  if (patch.modelParams) next.modelParams = { ...prefs.modelParams, [thread.provider]: thread.modelParams };
  if (patch.model || patch.provider || patch.effort !== undefined || patch.modelParams) {
    next.modelSettings = {
      ...prefs.modelSettings,
      [modelKey(thread.provider, thread.model)]: { effort: thread.effort, modelParams: { ...thread.modelParams } },
    };
  }
  if (patch.mode && thread.scope.kind !== "page" && thread.scope.kind !== "folder") next.mode = thread.mode;
  if (patch.approval) {
    next.approval = thread.approval;
    const seeded: Prefs["approvals"] = { ...prefs.approvals };
    for (const id of ["claude", "cursor", "pi"] as const) {
      if (seeded[id] === undefined) seeded[id] = prefs.approval;
    }
    seeded[thread.provider] = thread.approval;
    next.approvals = seeded;
  }
  if (patch.web) next.web = thread.web;
  if (patch.cwd && thread.cwd) {
    const cwd = path.normalize(thread.cwd);
    next.recentWorkspaces = [thread.cwd, ...prefs.recentWorkspaces.filter((dir) => path.normalize(dir) !== cwd)].slice(0, 12);
    if (thread.scope.kind === "page" || thread.scope.kind === "folder") {
      next.scopeWorkspaces = { ...prefs.scopeWorkspaces, [`${thread.scope.kind}:${thread.scope.ref}`]: thread.cwd };
    }
  }
  if (typeof patch.useWorktree === "boolean" && thread.cwd) {
    next.worktrees = { ...prefs.worktrees, [workspaceKey(thread.cwd)]: patch.useWorktree };
  }
  return next;
}
