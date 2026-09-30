import { embedUrlFromHtml } from "./embed.js";
import type { PageAssetFile, PageAssetMeta, PageAssetUsage } from "./pageAssets.js";

export type BoardState = Record<string, unknown>;

export type TabSignal = {
  name: string;
  revision: number;
  at: number;
};

export type TabAsset = {
  name: string;
  mimeType: string;
  bytes: number;
};

export type PreparedAsset = {
  name: string;
  mimeType: string;
  buffer: Buffer;
};

export type TemplateFieldType = "text" | "textarea" | "number" | "select" | "checkbox";

export type TemplateFieldOption = {
  value: string;
  label: string;
};

export type TemplateField = {
  key: string;
  label: string;
  type: TemplateFieldType;
  required?: boolean;
  placeholder?: string;
  help?: string;
  default?: string | number | boolean;
  options?: TemplateFieldOption[];
  min?: number;
  max?: number;
  /** Character limit for text and textarea values; defaults to 500 and 4000. */
  maxLength?: number;
};

export type TemplateValues = Record<string, string | number | boolean>;

export type Template = {
  id: string;
  key: string;
  title: string;
  description: string;
  html: string;
  fields: TemplateField[];
  titleTemplate?: string;
  initialState?: BoardState;
  stateVersion: number;
  createdAt: number;
  updatedAt: number;
  /** Set on a local copy of a built-in template. */
  source?: TemplateSource;
  /** Markdown for agents working with pages made from this template: state shape, signals, conventions. */
  guide?: string;
};

/** Which built-in a local template was copied from, and that built-in's fingerprint at copy time. */
export type TemplateSource = {
  builtin: string;
  fingerprint: string;
};

export type TemplateMeta = Omit<Template, "html" | "initialState" | "source" | "guide"> & {
  htmlBytes: number;
  /** The template carries an agent guide (tool results deliver it). */
  hasGuide?: boolean;
  instanceCount: number;
  /** Key of the built-in this template was copied from. */
  builtinSource?: string;
  /** The built-in changed since this copy was made, and the copy could not be updated automatically. */
  builtinUpdate?: boolean;
};

/** A read-only template shipped with the app. Opening one opens its local copy, creating it first if needed. */
export type BuiltinTemplateMeta = Omit<TemplateMeta, "instanceCount" | "builtinSource" | "builtinUpdate"> & {
  builtIn: true;
  /** Id of the local copy, when there is one. */
  localId?: string;
};

export type TemplateBinding = {
  tabId: string;
  templateId: string;
  values: TemplateValues;
  stateVersion: number;
  compatible: boolean;
  reason?: string;
};

export type Folder = {
  id: string;
  /** null is the Library root. */
  parentId: string | null;
  name: string;
  /** Order among sibling folders; sparse, compare only. */
  pos: number;
  createdAt: number;
  updatedAt: number;
};

export type Tab = {
  id: string;
  key: string;
  title: string;
  html: string;
  pinned: boolean;
  createdAt: number;
  /** Last content change: HTML, title, or template values. Not pins, signals, opening, or moving. */
  updatedAt: number;
  /** Set while the page has no tab in the strip; omitted when open. */
  closedAt?: number;
  /** Library folder; omitted for the root. */
  folderId?: string;
  /** Order among sibling pages in the folder; sparse, compare only. */
  libPos: number;
  /** When the user last renamed the page; agent titles are ignored for USER_TITLE_HOLD_MS after. */
  userTitleAt?: number;
  /** Strip coordinate. Owned by the tab; omitted from agent-facing meta. */
  stripSeq: number;
  revision: number;
  state: BoardState;
  stateRevision: number;
  stateUpdatedAt: number;
  /** Monotonic counter; survives board_show clearing `signal`. */
  signalRevision: number;
  /** Last signal, or null after board_show resets the wait handshake. */
  signal: TabSignal | null;
  assets: TabAsset[];
  templateId?: string;
  templateValues?: TemplateValues;
  templateStateVersion?: number;
  templateCompatible?: boolean;
  templateIncompatibleReason?: string;
  /** Only the board UI can set this. Agent requests treat the tab as nonexistent. */
  agentHidden?: boolean;
};

export type TabMeta = Omit<Tab, "html" | "state" | "signal" | "signalRevision" | "stripSeq"> & {
  htmlBytes: number;
  /** Set when the page asks to be shown as a direct iframe of this URL. */
  embedUrl?: string;
};

/** One delete operation. A folder delete is one batch however many pages it held. */
export type DeletedBatch = {
  id: string;
  deletedAt: number;
  tabs: Tab[];
  folders: Folder[];
};

/** Deleted pages and folders stay in the Trash this long, then go for good. */
export const TRASH_DAYS = 7;
export const TRASH_TTL_MS = TRASH_DAYS * 24 * 60 * 60 * 1000;

/** A delete batch as the Trash lists it. */
export type TrashBatch = {
  id: string;
  deletedAt: number;
  expiresAt: number;
  tabs: TabMeta[];
  folders: Folder[];
};

export const USER_TITLE_HOLD_MS = 24 * 60 * 60 * 1000;

/** Reserved for the in-app help page. Closing it discards the tab instead of archiving. */
export const WELCOME_KEY = "welcome";

export function isAppTab(tab: { key: string }): boolean {
  return tab.key === WELCOME_KEY;
}

/** Who is asking: the board UI (and tab pages), or an agent through the MCP. */
export type Viewer = "user" | "agent";

export function visibleTo(tab: { agentHidden?: boolean }, viewer: Viewer): boolean {
  switch (viewer) {
    case "user":
      return true;
    case "agent":
      return !tab.agentHidden;
    default: {
      const _never: never = viewer;
      return _never;
    }
  }
}

export type UpsertNotice = {
  activate: boolean;
  /** HTML, title, or an in-archive write; pin-only updates on open tabs are not structural. */
  structural: boolean;
};

export type BoardEvent =
  | {
      type: "snapshot";
      version: string;
      tabs: TabMeta[];
      closed: TabMeta[];
      folders: Folder[];
      activeId: string | null;
      templates: TemplateMeta[];
      builtinTemplates: BuiltinTemplateMeta[];
      persistError: string | null;
    }
  | { type: "tab_upserted"; tab: TabMeta; index?: number; structural: boolean }
  | { type: "tab_deleted"; id: string }
  | { type: "tab_focused"; id: string | null }
  | { type: "tab_focus_request"; id: string }
  | { type: "tab_state"; id: string; state: BoardState; stateRevision: number; client?: string }
  | { type: "tab_signal"; id: string; signal: TabSignal }
  | { type: "folders"; folders: Folder[] }
  | { type: "trash" }
  | { type: "template_upserted"; template: TemplateMeta }
  | { type: "template_deleted"; id: string }
  | { type: "builtin_templates"; templates: BuiltinTemplateMeta[] }
  | { type: "page_asset_warning"; id: string; title: string; usage: PageAssetUsage }
  | { type: "persist_error"; error: string }
  | { type: "persist_ok" };

export type UpsertInput = {
  key?: string;
  title: string;
  html: string;
  activate?: boolean;
  pin?: boolean;
  state?: BoardState;
  assets?: PreparedAsset[];
  /** Folder path like "CLIMS/Releases" for a newly created page. Ignored for existing keys. */
  folder?: string;
  /** An agent writing a key owned by a hidden tab gets a new tab instead. */
  viewer?: Viewer;
};

export type SetStateInput = {
  state: BoardState;
  replace?: boolean;
  expectedRevision?: number;
  client?: string;
  resolveIncompatibility?: boolean;
  /** Local files to store as page assets; state strings `asset:<name>` become their URLs. */
  assets?: PageAssetFile[];
};

export type SignalInput = {
  name: string;
  state?: BoardState;
  client?: string;
};

export type RestorePlacement = "append" | "index";

/** Where imported pages land. `meta` follows each page's closedAt (missing → open). */
export type ImportDestination = "meta" | "closed";

/** A stale expectedRevision resolves to ok:false carrying the current state so the caller can merge and retry. */
export type SetStateResult =
  | { ok: true; tab: Tab; assets?: PageAssetMeta[] }
  | { ok: false; state: BoardState; stateRevision: number };

export function toMeta(tab: Tab): TabMeta {
  const embedUrl = embedUrlFromHtml(tab.html);
  return {
    id: tab.id,
    key: tab.key,
    title: tab.title,
    pinned: tab.pinned,
    createdAt: tab.createdAt,
    updatedAt: tab.updatedAt,
    ...(tab.closedAt ? { closedAt: tab.closedAt } : {}),
    ...(tab.folderId ? { folderId: tab.folderId } : {}),
    libPos: tab.libPos,
    ...(tab.userTitleAt ? { userTitleAt: tab.userTitleAt } : {}),
    revision: tab.revision,
    stateRevision: tab.stateRevision,
    stateUpdatedAt: tab.stateUpdatedAt,
    htmlBytes: Buffer.byteLength(tab.html, "utf8"),
    assets: tab.assets,
    ...(tab.agentHidden ? { agentHidden: true } : {}),
    ...(embedUrl ? { embedUrl } : {}),
    ...(tab.templateId
      ? {
          templateId: tab.templateId,
          templateValues: tab.templateValues ?? {},
          templateStateVersion: tab.templateStateVersion ?? 0,
          templateCompatible: tab.templateCompatible !== false,
          ...(tab.templateIncompatibleReason
            ? { templateIncompatibleReason: tab.templateIncompatibleReason }
            : {}),
        }
      : {}),
  };
}

export function toTemplateMeta(template: Template, instanceCount = 0, builtinUpdate = false): TemplateMeta {
  return {
    id: template.id,
    key: template.key,
    title: template.title,
    description: template.description,
    fields: template.fields,
    ...(template.titleTemplate ? { titleTemplate: template.titleTemplate } : {}),
    stateVersion: template.stateVersion,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
    htmlBytes: Buffer.byteLength(template.html, "utf8"),
    instanceCount,
    ...(template.source ? { builtinSource: template.source.builtin } : {}),
    ...(builtinUpdate ? { builtinUpdate: true } : {}),
    ...(template.guide ? { hasGuide: true } : {}),
  };
}

export function isTemplateBound(tab: { templateId?: string }): boolean {
  return Boolean(tab.templateId);
}

export function isPlainObject(value: unknown): value is BoardState {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
