import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";

/**
 * Windows: the daemon runs detached, so it has no console of its own, and every console program it
 * starts without windowsHide opens a new, visible console window. The Cursor SDK starts git (on every
 * turn) and the user's MCP servers that way. This makes hidden the default for everything the daemon
 * starts. A caller that passes windowsHide or detached keeps its choice.
 */
export function hideChildWindows(): void {
  if (process.platform !== "win32") return;
  const cp = childProcess as unknown as Record<string, unknown>;
  for (const [name, at] of WRAPPED) {
    const original = cp[name] as ((...argv: unknown[]) => unknown) & { [promisify.custom]?: (...argv: unknown[]) => unknown };
    if (typeof original !== "function" || (original as { scribeHidden?: boolean }).scribeHidden) continue;
    const wrapped = Object.assign((...argv: unknown[]) => original(...hideByDefault(argv, at(argv))), { scribeHidden: true });
    // promisify(execFile) resolves { stdout, stderr } only through this hook; the Cursor SDK relies on it.
    const custom = original[promisify.custom];
    if (custom) Object.defineProperty(wrapped, promisify.custom, { value: (...argv: unknown[]) => custom(...hideByDefault(argv, at(argv))) });
    cp[name] = wrapped;
  }
  syncBuiltinESMExports();
}

/** Where each function takes its options: after the optional args array (which may be passed as null), or right after the command. */
const afterArgs = (argv: unknown[]) => (Array.isArray(argv[1]) || (argv[1] == null && argv.length > 2) ? 2 : 1);
const afterCommand = () => 1;
const WRAPPED: Array<[string, (argv: unknown[]) => number]> = [
  ["spawn", afterArgs],
  ["spawnSync", afterArgs],
  ["execFile", afterArgs],
  ["execFileSync", afterArgs],
  ["fork", afterArgs],
  ["exec", afterCommand],
  ["execSync", afterCommand],
];

/** The call's arguments with windowsHide: true added to the options at `at`, unless they already decide. */
export function hideByDefault(argv: unknown[], at: number): unknown[] {
  const next = argv.slice();
  const options = next[at];
  if (typeof options === "function") {
    next.splice(at, 0, { windowsHide: true });
  } else if (options === undefined || options === null) {
    next[at] = { windowsHide: true };
  } else if (typeof options === "object" && !("windowsHide" in options) && !(options as { detached?: unknown }).detached) {
    next[at] = { ...options, windowsHide: true };
  }
  return next;
}
