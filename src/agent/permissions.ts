import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderId } from "./types.js";
import { isPlainRecord } from "./types.js";

/**
 * The providers' own allow / deny lists for tool calls ("Bash(npm test:*)", "Shell(git status)").
 * Claude Code reads permissions from its user settings and the project's .claude/settings.json and
 * settings.local.json; Cursor's CLI from ~/.cursor/cli-config.json and the project's .cursor/cli.json.
 * Only the permissions object is ever changed; everything else in those files is kept as it is.
 */

export type RuleKind = "allow" | "deny" | "ask";
export type PermissionScope = "user" | "project" | "local";

export type RuleSet = {
  provider: ProviderId;
  scope: PermissionScope;
  /** Where the rules live. */
  path: string;
  exists: boolean;
  /** Lists this provider reads; Cursor has no "ask". */
  kinds: RuleKind[];
  allow: string[];
  deny: string[];
  ask: string[];
  /** Set when the file could not be read as JSON; it is shown but not written. */
  error?: string;
};

const MAX_RULES = 500;
const MAX_RULE = 500;

function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

function cursorDir(): string {
  return process.env.CURSOR_CONFIG_DIR || path.join(os.homedir(), ".cursor");
}

function fileFor(provider: ProviderId, scope: PermissionScope, cwd: string | null): string | null {
  if (provider === "claude") {
    if (scope === "user") return path.join(claudeDir(), "settings.json");
    if (!cwd) return null;
    return path.join(cwd, ".claude", scope === "local" ? "settings.local.json" : "settings.json");
  }
  if (scope === "user") return path.join(cursorDir(), "cli-config.json");
  if (scope === "project" && cwd) return path.join(cwd, ".cursor", "cli.json");
  return null;
}

const SCOPES: Record<ProviderId, PermissionScope[]> = { claude: ["user", "project", "local"], cursor: ["user", "project"] };
const KINDS: Record<ProviderId, RuleKind[]> = { claude: ["allow", "ask", "deny"], cursor: ["allow", "deny"] };

function readJson(file: string): { data: Record<string, unknown>; exists: boolean; error?: string } {
  if (!fs.existsSync(file)) return { data: {}, exists: false };
  try {
    const text = fs.readFileSync(file, "utf8");
    const data = text.trim() ? JSON.parse(text) : {};
    return isPlainRecord(data) ? { data, exists: true } : { data: {}, exists: true, error: "Not a JSON object" };
  } catch (err) {
    return { data: {}, exists: true, error: (err as Error).message };
  }
}

function rules(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((rule): rule is string => typeof rule === "string") : [];
}

function cleanDir(cwd: string | null | undefined): string | null {
  if (!cwd) return null;
  const dir = path.resolve(cwd);
  return fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? dir : null;
}

export function listPermissions(cwd: string | null | undefined): RuleSet[] {
  const dir = cleanDir(cwd);
  const out: RuleSet[] = [];
  for (const provider of ["claude", "cursor"] as const) {
    for (const scope of SCOPES[provider]) {
      const file = fileFor(provider, scope, dir);
      if (!file) continue;
      const { data, exists, error } = readJson(file);
      const perms = isPlainRecord(data.permissions) ? data.permissions : {};
      out.push({
        provider,
        scope,
        path: file,
        exists,
        kinds: KINDS[provider],
        allow: rules(perms.allow),
        deny: rules(perms.deny),
        ask: rules(perms.ask),
        ...(error ? { error } : {}),
      });
    }
  }
  return out;
}

/** Replace one list (allow, deny or ask) in one provider's file, keeping the rest of the file. */
export function setRules(input: { provider: ProviderId; scope: PermissionScope; cwd?: string | null; kind: RuleKind; rules: unknown }): RuleSet {
  const { provider, scope, kind } = input;
  if (!SCOPES[provider]?.includes(scope)) throw new Error(`Unknown scope for ${provider}: ${scope}`);
  if (!KINDS[provider].includes(kind)) throw new Error(`${provider} has no ${kind} list`);
  const dir = cleanDir(input.cwd);
  if (scope !== "user" && !dir) throw new Error("Pick a workspace folder for project rules");
  const file = fileFor(provider, scope, dir);
  if (!file) throw new Error("No file for these rules");
  const list = [...new Set(rules(input.rules).map((rule) => rule.trim()).filter(Boolean))];
  if (list.length > MAX_RULES) throw new Error(`At most ${MAX_RULES} rules`);
  if (list.some((rule) => rule.length > MAX_RULE || /[\r\n]/.test(rule))) throw new Error("A rule is one line of at most 500 characters");
  const { data, error } = readJson(file);
  if (error) throw new Error(`Cannot update ${file}: ${error}`);
  const perms = isPlainRecord(data.permissions) ? { ...data.permissions } : {};
  if (list.length || Array.isArray(perms[kind])) perms[kind] = list;
  const next = { ...data, permissions: perms };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write next to the file and rename, so a reader never sees half a file.
  const tmp = `${file}.scribe-${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
  return listPermissions(dir).find((set) => set.provider === provider && set.scope === scope)!;
}
