/**
 * Palette search prefixes (Ctrl+D). public/app.js copies these helpers — keep the two in sync.
 * Add a prefix here and in app.js when it ships.
 */

export type PalettePrefixId = "threads" | "ai" | "semantic";

export type PalettePrefixDef = {
  id: PalettePrefixId;
  label: string;
  default: string;
};

export const PALETTE_PREFIXES: PalettePrefixDef[] = [
  { id: "threads", label: "Threads", default: "=" },
  { id: "ai", label: "Ask AI", default: "?" },
  { id: "semantic", label: "By meaning", default: "~" },
];

export const PREFIX_MAX = 8;

export type PaletteQuery =
  | { id: "pages"; query: string }
  | { id: string; query: string; prefix: string };

export function normalizePrefix(raw: string, fallback: string): string {
  const value = String(raw ?? "").trim();
  if (!value || value.length > PREFIX_MAX || /\s/.test(value)) {
    return fallback;
  }
  return value;
}

export type PalettePrefix = PalettePrefixDef & { prefix: string };

/** Read stored overrides. Missing or invalid values fall back to each prefix's default. */
export function palettePrefixList(storedJson: string | null | undefined): PalettePrefix[] {
  let parsed: Record<string, unknown> = {};
  if (storedJson) {
    try {
      const value = JSON.parse(storedJson) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>;
      }
    } catch {
      parsed = {};
    }
  }
  return PALETTE_PREFIXES.map((def) => {
    const raw = parsed[def.id];
    return {
      ...def,
      prefix: normalizePrefix(typeof raw === "string" ? raw : "", def.default),
    };
  });
}

/** Persist only values that differ from the default, so a reset stays a missing key. */
export function serializePalettePrefixes(prefixes: Array<{ id: string; prefix: string; default: string }>): string {
  const out: Record<string, string> = {};
  for (const item of prefixes) {
    const value = normalizePrefix(item.prefix, item.default);
    if (value !== item.default) {
      out[item.id] = value;
    }
  }
  return JSON.stringify(out);
}

/**
 * A prefix matches at the start of the (trimmed) query.
 * Symbol prefixes may glue to the rest (`=foo`); a prefix that ends in a letter or digit needs a
 * following space, so a word prefix `th` does not steal `this`.
 */
export function prefixTakes(text: string, prefix: string): boolean {
  if (!prefix || !text.startsWith(prefix)) {
    return false;
  }
  const next = text[prefix.length];
  if (next === undefined || /\s/.test(next)) {
    return true;
  }
  return !/[0-9A-Za-z]/.test(prefix[prefix.length - 1]!);
}

export function parsePaletteQuery(input: string, prefixes: Array<{ id: string; prefix: string }>): PaletteQuery {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) {
    return { id: "pages", query: "" };
  }
  const ranked = prefixes
    .filter((item) => item.prefix)
    .slice()
    .sort((a, b) => b.prefix.length - a.prefix.length);
  for (const item of ranked) {
    if (prefixTakes(trimmed, item.prefix)) {
      return {
        id: item.id,
        query: trimmed.slice(item.prefix.length).trim(),
        prefix: item.prefix,
      };
    }
  }
  return { id: "pages", query: trimmed };
}

export function duplicatePrefixIds(prefixes: Array<{ id: string; prefix: string }>): Set<string> {
  const byPrefix = new Map<string, string[]>();
  for (const item of prefixes) {
    if (!item.prefix) {
      continue;
    }
    const list = byPrefix.get(item.prefix) || [];
    list.push(item.id);
    byPrefix.set(item.prefix, list);
  }
  const dups = new Set<string>();
  for (const ids of byPrefix.values()) {
    if (ids.length > 1) {
      for (const id of ids) {
        dups.add(id);
      }
    }
  }
  return dups;
}
