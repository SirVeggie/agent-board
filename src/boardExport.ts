import path from "node:path";
import { prepareAssetFromBuffer } from "./assets.js";
import { MAX_ASSETS_PER_TAB, MAX_ASSETS_TOTAL_BYTES } from "./config.js";
import { normalizeTemplateInput } from "./templates.js";
import {
  isPlainObject,
  type BoardState,
  type PreparedAsset,
  type Tab,
  type Template,
  type TemplateBinding,
  type TemplateValues,
} from "./types.js";

export const EXPORT_FORMAT = "agent-board-export";
export const EXPORT_VERSION = 1;

export type BoardExportAsset = {
  name: string;
  mimeType: string;
  data: string;
};

/** templateId refers to an entry in the same file's templates list. */
export type PageTemplateBinding = Omit<TemplateBinding, "tabId">;

export type BoardExportPage = {
  key: string;
  title: string;
  html: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
  state: BoardState;
  assets: BoardExportAsset[];
  template?: PageTemplateBinding;
};

export type BoardExportFile = {
  format: typeof EXPORT_FORMAT;
  version: number;
  exportedAt: number;
  templates: Template[];
  pages: BoardExportPage[];
};

export type ImportPageInput = {
  key?: string;
  title: string;
  html: string;
  pinned?: boolean;
  createdAt?: number;
  updatedAt?: number;
  archivedAt?: number;
  state?: BoardState;
  assets?: PreparedAsset[];
  template?: PageTemplateBinding;
};

export type ParsedImport = {
  kind: "export" | "html";
  templates: Template[];
  pages: ImportPageInput[];
};

export function buildExport(
  entries: Array<{ tab: Tab; assets: PreparedAsset[] }>,
  templates: Template[] = []
): BoardExportFile {
  const included = new Set(templates.map((template) => template.id));
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: Date.now(),
    templates,
    pages: entries.map(({ tab, assets }) => ({
      key: tab.key,
      title: tab.title,
      html: tab.html,
      pinned: Boolean(tab.pinned),
      createdAt: tab.createdAt,
      updatedAt: tab.updatedAt,
      ...(typeof tab.archivedAt === "number" ? { archivedAt: tab.archivedAt } : {}),
      state: isPlainObject(tab.state) ? tab.state : {},
      assets: assets.map((asset) => ({
        name: asset.name,
        mimeType: asset.mimeType,
        data: asset.buffer.toString("base64"),
      })),
      ...(tab.templateId && included.has(tab.templateId)
        ? {
            template: {
              templateId: tab.templateId,
              values: tab.templateValues ?? {},
              stateVersion: tab.templateStateVersion ?? 0,
              compatible: tab.templateCompatible !== false,
              ...(tab.templateIncompatibleReason ? { reason: tab.templateIncompatibleReason } : {}),
            },
          }
        : {}),
    })),
  };
}

export function serializeExport(file: BoardExportFile): string {
  return JSON.stringify(file);
}

export function parseImport(input: Buffer | string, filename = ""): ParsedImport {
  const text = stripBom(typeof input === "string" ? input : input.toString("utf8")).trim();
  if (!text) {
    throw new Error("file is empty");
  }
  const json = tryParseJson(text);
  if (json !== undefined) {
    return { kind: "export", ...contentFromExport(json) };
  }
  if (looksLikeHtml(text) || isHtmlFilename(filename)) {
    return {
      kind: "html",
      templates: [],
      pages: [
        {
          title: titleFromHtml(text, titleFromFilename(filename)),
          html: text,
        },
      ],
    };
  }
  throw new Error("not a recognized Agent Board file");
}

export function titleFromHtml(html: string, fallback: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) {
    return fallback;
  }
  const title = decodeEntities(match[1].replace(/<[^>]+>/g, "")).trim();
  return title || fallback;
}

export function titleFromFilename(name: string): string {
  let stem = path.basename(name);
  stem = stem.replace(/\.board\.json$/i, "");
  stem = stem.replace(/\.(json|html?|xhtml)$/i, "");
  stem = stem.replace(/[-_]+/g, " ").trim();
  return stem || "Imported page";
}

export function exportFilename(title: string): string {
  return `${safeStem(title)}.board.json`;
}

export function exportAllFilename(at = Date.now()): string {
  const d = new Date(at);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `agent-board-${year}-${month}-${day}.json`;
}

export function safeStem(title: string): string {
  const cleaned = title.replace(/[<>:"/\\|?*]+/g, " ").trim().replace(/\s+/g, "-");
  return (cleaned || "page").slice(0, 80);
}

function contentFromExport(value: unknown): Pick<ParsedImport, "templates" | "pages"> {
  if (!isExportFile(value)) {
    throw new Error("not an Agent Board export");
  }
  if (value.version !== EXPORT_VERSION) {
    throw new Error(`unsupported export version: ${value.version}`);
  }
  const rawTemplates: unknown = value.templates ?? [];
  if (!Array.isArray(rawTemplates)) {
    throw new Error("templates must be an array");
  }
  if (!value.pages.length && !rawTemplates.length) {
    throw new Error("export has no pages or templates");
  }
  const templates = rawTemplates.map((raw, index) => templateFromExport(raw, index));
  const templateIds = new Set<string>();
  for (const template of templates) {
    if (templateIds.has(template.id)) {
      throw new Error(`duplicate template id: ${template.id}`);
    }
    templateIds.add(template.id);
  }
  return {
    templates,
    pages: value.pages.map((page, index) => pageFromExport(page, index, templateIds)),
  };
}

function templateFromExport(raw: unknown, index: number): Template {
  if (!isPlainObject(raw)) {
    throw new Error(`templates[${index}] is invalid`);
  }
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) {
    throw new Error(`templates[${index}] is missing an id`);
  }
  let normalized: ReturnType<typeof normalizeTemplateInput>;
  try {
    normalized = normalizeTemplateInput({
      title: typeof raw.title === "string" ? raw.title : "",
      description: typeof raw.description === "string" ? raw.description : undefined,
      html: typeof raw.html === "string" ? raw.html : "",
      fields: raw.fields,
      titleTemplate: typeof raw.titleTemplate === "string" ? raw.titleTemplate : undefined,
      initialState: raw.initialState === undefined || raw.initialState === null ? undefined : (raw.initialState as BoardState),
      stateVersion: raw.stateVersion === undefined ? undefined : (raw.stateVersion as number),
    });
  } catch (err) {
    throw new Error(`templates[${index}]: ${(err as Error).message}`);
  }
  const now = Date.now();
  return {
    id,
    key: typeof raw.key === "string" ? raw.key : "",
    title: normalized.title,
    description: normalized.description,
    html: normalized.html,
    fields: normalized.fields,
    ...(normalized.titleTemplate ? { titleTemplate: normalized.titleTemplate } : {}),
    ...(normalized.initialState ? { initialState: normalized.initialState } : {}),
    stateVersion: normalized.stateVersion ?? 1,
    createdAt: finiteNumber(raw.createdAt) ?? now,
    updatedAt: finiteNumber(raw.updatedAt) ?? now,
  };
}

function bindingFromExport(raw: unknown, pageIndex: number, templateIds: Set<string>): PageTemplateBinding | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!isPlainObject(raw)) {
    throw new Error(`pages[${pageIndex}].template is invalid`);
  }
  const templateId = typeof raw.templateId === "string" ? raw.templateId : "";
  if (!templateIds.has(templateId)) {
    throw new Error(`pages[${pageIndex}] uses template "${templateId}", which is not in the file`);
  }
  const reason = typeof raw.reason === "string" && raw.reason.trim() ? raw.reason.trim() : undefined;
  return {
    templateId,
    values: isPlainObject(raw.values) ? (raw.values as TemplateValues) : {},
    stateVersion: finiteNumber(raw.stateVersion) ?? 0,
    compatible: raw.compatible !== false,
    ...(reason ? { reason } : {}),
  };
}

function pageFromExport(raw: unknown, index: number, templateIds: Set<string>): ImportPageInput {
  if (!raw || typeof raw !== "object") {
    throw new Error(`pages[${index}] is invalid`);
  }
  const page = raw as Record<string, unknown>;
  const title = typeof page.title === "string" ? page.title.trim() : "";
  const html = typeof page.html === "string" ? page.html : "";
  if (!title) {
    throw new Error(`pages[${index}] is missing a title`);
  }
  if (!html.trim()) {
    throw new Error(`pages[${index}] is missing html`);
  }
  return {
    key: typeof page.key === "string" ? page.key : undefined,
    title,
    html,
    pinned: page.pinned === true,
    createdAt: finiteNumber(page.createdAt),
    updatedAt: finiteNumber(page.updatedAt),
    archivedAt: finiteNumber(page.archivedAt),
    state: isPlainObject(page.state) ? page.state : {},
    assets: assetsFromExport(page.assets, index),
    template: bindingFromExport(page.template, index, templateIds),
  };
}

function assetsFromExport(raw: unknown, pageIndex: number): PreparedAsset[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new Error(`pages[${pageIndex}].assets must be an array`);
  }
  if (raw.length > MAX_ASSETS_PER_TAB) {
    throw new Error(`too many assets (${raw.length}, max ${MAX_ASSETS_PER_TAB})`);
  }
  const used = new Set<string>();
  const out: PreparedAsset[] = [];
  let total = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (!item || typeof item !== "object") {
      throw new Error(`pages[${pageIndex}].assets[${i}] is invalid`);
    }
    const rec = item as { name?: unknown; mimeType?: unknown; data?: unknown };
    if (typeof rec.name !== "string" || typeof rec.mimeType !== "string" || typeof rec.data !== "string") {
      throw new Error(`pages[${pageIndex}].assets[${i}] must include name, mimeType, and data`);
    }
    const buffer = Buffer.from(rec.data, "base64");
    const asset = prepareAssetFromBuffer(rec.name, rec.mimeType, buffer);
    const key = asset.name.toLowerCase();
    if (used.has(key)) {
      throw new Error(`pages[${pageIndex}] duplicate asset name: ${asset.name}`);
    }
    used.add(key);
    total += asset.buffer.length;
    if (total > MAX_ASSETS_TOTAL_BYTES) {
      throw new Error(`assets are too large (${total} bytes, max ${MAX_ASSETS_TOTAL_BYTES})`);
    }
    out.push(asset);
  }
  return out;
}

function isExportFile(value: unknown): value is BoardExportFile {
  if (!value || typeof value !== "object") {
    return false;
  }
  const rec = value as { format?: unknown; version?: unknown; pages?: unknown };
  return rec.format === EXPORT_FORMAT && typeof rec.version === "number" && Array.isArray(rec.pages);
}

function tryParseJson(text: string): unknown {
  if (text[0] !== "{" && text[0] !== "[") {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function looksLikeHtml(text: string): boolean {
  return /^<!doctype\s+html/i.test(text) || /^<html[\s>]/i.test(text) || /^<[a-z!/?]/i.test(text);
}

function isHtmlFilename(name: string): boolean {
  return /\.(html?|xhtml)$/i.test(name);
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
