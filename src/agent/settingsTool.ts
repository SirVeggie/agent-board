/**
 * settings_find and settings_show: the agent looks up where a setting lives in Scribe's settings
 * dialogs and shows those rows in the chat, where the user changes them. The list comes from the
 * app window (settings-ui.js), which sends it when it connects and after a setting changes.
 */
import { isPlainRecord } from "./types.js";

export type SettingEntry = {
  id: string;
  kind: "section" | "row";
  dialog: string;
  category: string;
  section: string;
  label: string;
  hint?: string;
  control?: string;
  value?: string;
  options?: string[];
  disabled?: boolean;
};

const MAX_ENTRIES = 2000;
const MAX_SHOW = 30;
const MAX_FOUND = 40;

let catalog: SettingEntry[] = [];

const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

/** Takes the list the app window sent; anything malformed is dropped. */
export function setSettingsCatalog(input: unknown): number {
  const raw = isPlainRecord(input) && Array.isArray(input.settings) ? input.settings.slice(0, MAX_ENTRIES) : [];
  const out: SettingEntry[] = [];
  for (const e of raw) {
    if (!isPlainRecord(e)) continue;
    const id = str(e.id, 200);
    const label = str(e.label, 200);
    if (!id || !label || (e.kind !== "section" && e.kind !== "row")) continue;
    const entry: SettingEntry = { id, kind: e.kind, dialog: str(e.dialog, 80) ?? "", category: str(e.category, 80) ?? "", section: str(e.section, 120) ?? "", label };
    const hint = str(e.hint, 600);
    const control = str(e.control, 20);
    const value = typeof e.value === "string" ? e.value.slice(0, 200) : undefined;
    if (hint) entry.hint = hint;
    if (control) entry.control = control;
    if (value !== undefined) entry.value = value;
    if (Array.isArray(e.options)) entry.options = e.options.filter((o): o is string => typeof o === "string").slice(0, 30).map((o) => o.slice(0, 80));
    if (e.disabled === true) entry.disabled = true;
    out.push(entry);
  }
  catalog = out;
  return out.length;
}

export function settingsCatalog(): SettingEntry[] {
  return catalog;
}

function line(e: SettingEntry): string {
  const where = `${e.dialog} › ${e.category} › ${e.section}`;
  if (e.kind === "section") return `${e.id}  [whole section] ${where}`;
  const state = e.value !== undefined && e.value !== "" ? `: ${e.value}` : "";
  const options = e.options?.length ? ` (${e.control ?? "choice"}: ${e.options.join(" | ")})` : e.control ? ` (${e.control})` : "";
  const hint = e.hint ? ` — ${e.hint.length > 200 ? `${e.hint.slice(0, 199)}…` : e.hint}` : "";
  return `${e.id}  ${where} › ${e.label}${state}${options}${e.disabled ? " [unavailable now]" : ""}${hint}`;
}

/** settings_find: the settings matching the query's words (all of them without one), as lines for the model. */
export function findSettings(query: unknown): string {
  if (!catalog.length) throw new Error("The settings list is not available: no Scribe window has sent it yet. Ask the user to open Scribe, then try again.");
  const words = (typeof query === "string" ? query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [] : []).slice(0, 12);
  const usage = "Show any of them with settings_show (ids). A section id shows its whole section.";
  if (!words.length) return `${catalog.length} settings, in the dialogs' order:\n${catalog.map(line).join("\n")}\n\n${usage}`;
  const scored = catalog
    .map((e, i) => {
      const hay = `${e.label} ${e.section} ${e.category} ${e.dialog} ${e.hint ?? ""} ${(e.options ?? []).join(" ")}`.toLowerCase();
      const head = `${e.label} ${e.section}`.toLowerCase();
      let score = 0;
      for (const w of words) {
        if (head.includes(w)) score += 3;
        else if (hay.includes(w)) score += 1;
      }
      return { e, i, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, MAX_FOUND)
    .sort((a, b) => a.i - b.i);
  if (!scored.length) return `Nothing matched "${String(query)}". All ${catalog.length} settings:\n${catalog.map(line).join("\n")}\n\n${usage}`;
  return `${scored.length} match${scored.length === 1 ? "" : "es"} for "${String(query)}", in the dialogs' order:\n${scored.map((s) => line(s.e)).join("\n")}\n\n${usage}`;
}

/** settings_show's input: known ids, at most MAX_SHOW. Throws a message the agent can act on. */
export function parseShowInput(input: unknown): { ids: string[]; title?: string } {
  const body = isPlainRecord(input) ? input : {};
  const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).filter((id): id is string => typeof id === "string" && Boolean(id.trim())).map((id) => id.trim()))];
  if (!ids.length) throw new Error("Send at least one setting id from settings_find.");
  if (ids.length > MAX_SHOW) throw new Error(`At most ${MAX_SHOW} settings at a time.`);
  if (catalog.length) {
    const known = new Set(catalog.map((e) => e.id));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length) throw new Error(`Unknown setting id${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. Use ids exactly as settings_find lists them.`);
  }
  const title = str(body.title, 200);
  return { ids, ...(title ? { title } : {}) };
}
