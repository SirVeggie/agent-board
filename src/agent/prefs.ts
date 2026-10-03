import path from "node:path";
import type { ApprovalPolicy, ProviderId, Thread, ThreadMode, ThreadScope } from "./types.js";

/** Last-used chat settings. New threads and drafts start from these. */
export type Prefs = {
  provider: ProviderId;
  models: Partial<Record<ProviderId, string>>;
  efforts: Partial<Record<ProviderId, string | null>>;
  modelParams: Partial<Record<ProviderId, Record<string, string>>>;
  mode: ThreadMode;
  approval: ApprovalPolicy;
  /** Last Code-mode approval per provider. `approval` is the most recently used, and the fallback. */
  approvals: Partial<Record<ProviderId, ApprovalPolicy>>;
  web: boolean;
  recentWorkspaces: string[];
  /** Last workspace used for a scope ("page:<id>", "folder:<id>"), so new threads there start in it. */
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
  mode: "code",
  approval: "ask",
  approvals: {},
  web: true,
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

type ChoiceThread = {
  provider: ProviderId;
  model: string;
  effort: string | null;
  modelParams: Record<string, string>;
  mode: ThreadMode;
  approval: ApprovalPolicy;
  web: boolean;
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
  if (patch.mode && thread.scope.kind !== "page" && thread.scope.kind !== "folder") next.mode = thread.mode;
  if (patch.approval) {
    next.approval = thread.approval;
    const seeded: Prefs["approvals"] = { ...prefs.approvals };
    for (const id of ["claude", "cursor", "openai"] as const) {
      if (seeded[id] === undefined) seeded[id] = prefs.approval;
    }
    seeded[thread.provider] = thread.approval;
    next.approvals = seeded;
  }
  if (typeof patch.web === "boolean") next.web = thread.web;
  if (patch.cwd && thread.cwd) {
    const cwd = path.normalize(thread.cwd);
    next.recentWorkspaces = [thread.cwd, ...prefs.recentWorkspaces.filter((dir) => path.normalize(dir) !== cwd)].slice(0, 12);
    if (thread.scope.kind !== "global") {
      next.scopeWorkspaces = { ...prefs.scopeWorkspaces, [`${thread.scope.kind}:${thread.scope.ref}`]: thread.cwd };
    }
  }
  if (typeof patch.useWorktree === "boolean" && thread.cwd) {
    next.worktrees = { ...prefs.worktrees, [workspaceKey(thread.cwd)]: patch.useWorktree };
  }
  return next;
}
