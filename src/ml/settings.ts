import fs from "node:fs";
import path from "node:path";
import { dataDir } from "../config.js";
import { slugId } from "../agent/openaiSources.js";
import { SEND_KINDS, type MlDayUsage, type MlFeature, type MlSettings, type MlSource, type MlSourceView, type SendKind } from "./types.js";

/** The hosted Jev API, offered as the starting point for a new source. */
export const JEV_BASE_URL = "https://api.typesafe.ai";
export const JEV_DEFAULT_MODEL = "jev-latest";

/**
 * Features built on the decision service, each with a switch in Settings. A feature adds itself here
 * and passes its id to decide() (docs/intent-detection-hooks-design.md).
 */
export const ML_FEATURES: MlFeature[] = [
  {
    id: "hooks",
    label: "Hook questions",
    hint: "Hook rules of the kind Question (Agent settings, Hooks) ask the classifier about messages, agent output and tool calls. Off: those rules never match.",
    default: true,
  },
  {
    id: "page-intent",
    label: "Page-creation hint",
    hint: "Each message you send in the floating chat is asked whether answering it needs a new page. On a confident yes the page's edge glows until the agent confirms or the turn ends. Off: the creating screen still starts when the agent announces a page.",
    default: true,
  },
  {
    id: "injection-scan",
    label: "Prompt-injection scan",
    hint: "What the agent reads (pages, files, command output, web pages) is asked whether it tries to give the agent instructions. On a hit the call is flagged, the agent is told it is data, and the turn's later calls that change or send anything need your approval. An extra layer, not a guarantee: the classifier reads the same text and can be fooled, and Cursor's built-in tool calls cannot be held. Needs Tool results on under what may be sent.",
    default: false,
  },
  {
    id: "search-rerank",
    label: "Search result check",
    hint: "Search by meaning asks about its 20 closest results in one call: does this fit the search? Those that fit move up and the rest are dropped. The search text and the start of each result are sent. If the answer is slow or fails, you get the usual order. Needs Tool results on under what may be sent.",
    default: false,
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sourceView(source: MlSource): MlSourceView {
  const { apiKey, ...rest } = source;
  return { ...rest, hasKey: Boolean(apiKey) };
}

export function defaultSettings(): MlSettings {
  return { sources: [], features: {}, send: Object.fromEntries(SEND_KINDS.map((kind) => [kind, true])) as Record<SendKind, boolean> };
}

/**
 * A source from the Settings form. `previous` is the stored one being edited: its id stays, and its
 * key stays unless the form sends a new one (apiKey: "" clears it) or points the source at another
 * host, so a saved key is never sent somewhere it was not entered for.
 */
export function normalizeSource(input: unknown, previous: MlSource | undefined, taken: Set<string>): MlSource {
  const body = isRecord(input) ? input : {};
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 60) : previous?.name ?? "";
  if (!name) throw new Error("A source needs a name");
  const rawUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : previous?.baseUrl ?? "";
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Base URL must be a full URL, e.g. ${JEV_BASE_URL}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Base URL must be http or https");
  // Requests go to /v1/systemone under it, so a pasted endpoint or version path is cut back.
  const baseUrl = url.toString().replace(/\/+$/, "").replace(/\/v1(\/systemone)?$/, "");
  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim().slice(0, 100) : previous?.model ?? JEV_DEFAULT_MODEL;
  const moved = previous !== undefined && new URL(previous.baseUrl).origin !== url.origin;
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : moved ? "" : previous?.apiKey ?? "";
  return { id: previous?.id ?? slugId(name, taken), name, baseUrl, ...(apiKey ? { apiKey } : {}), model };
}

/** Stored settings as read from disk: anything missing or malformed falls back to the default. */
export function normalizeSettings(input: unknown): MlSettings {
  const body = isRecord(input) ? input : {};
  const settings = defaultSettings();
  const taken = new Set<string>();
  for (const raw of Array.isArray(body.sources) ? body.sources : []) {
    if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id || taken.has(raw.id)) continue;
    try {
      settings.sources.push({ ...normalizeSource(raw, undefined, taken), id: raw.id });
      taken.add(raw.id);
    } catch {
      // A source that no longer validates is dropped rather than breaking the rest.
    }
  }
  if (typeof body.defaultSource === "string" && taken.has(body.defaultSource)) settings.defaultSource = body.defaultSource;
  else if (settings.sources.length) settings.defaultSource = settings.sources[0].id;
  if (isRecord(body.features)) {
    for (const [id, on] of Object.entries(body.features)) if (typeof on === "boolean") settings.features[id] = on;
  }
  if (isRecord(body.send)) {
    for (const kind of SEND_KINDS) if (typeof body.send[kind] === "boolean") settings.send[kind] = body.send[kind];
  }
  return settings;
}

export function featureOn(settings: MlSettings, id: string): boolean {
  return settings.features[id] ?? ML_FEATURES.find((feature) => feature.id === id)?.default ?? false;
}

/** Where the service keeps its settings and the day's counters. */
export type MlStore = {
  read(): MlSettings;
  write(settings: MlSettings): void;
  readUsage(): MlDayUsage | null;
  writeUsage(usage: MlDayUsage): void;
};

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

/**
 * ml-settings.json (sources with their keys, switches) and ml-usage.json (today's counters) in the
 * data folder on this PC. The counters have their own file so a call never rewrites the keys.
 */
export function fileStore(root: () => string = dataDir): MlStore {
  let cached: { mtimeMs: number; settings: MlSettings } | undefined;
  const settingsFile = () => path.join(root(), "ml-settings.json");
  const usageFile = () => path.join(root(), "ml-usage.json");
  return {
    read() {
      const file = settingsFile();
      let mtimeMs = -1;
      try {
        mtimeMs = fs.statSync(file).mtimeMs;
      } catch {
        // No file yet.
      }
      if (!cached || cached.mtimeMs !== mtimeMs) cached = { mtimeMs, settings: normalizeSettings(mtimeMs < 0 ? null : readJson(file)) };
      return structuredClone(cached.settings);
    },
    write(settings) {
      writeJson(settingsFile(), settings);
      cached = undefined;
    },
    readUsage() {
      const usage = readJson(usageFile());
      return isRecord(usage) && typeof usage.day === "string" ? (usage as MlDayUsage) : null;
    },
    writeUsage(usage) {
      writeJson(usageFile(), usage);
    },
  };
}

export function memoryStore(initial?: Partial<MlSettings>): MlStore {
  let settings = normalizeSettings(initial);
  let usage: MlDayUsage | null = null;
  return {
    read: () => structuredClone(settings),
    write: (next) => {
      settings = structuredClone(next);
    },
    readUsage: () => (usage ? { ...usage } : null),
    writeUsage: (next) => {
      usage = { ...next };
    },
  };
}
