import { embedUrlFromHtml } from "./embed.js";

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
};

export type TemplateMeta = Omit<Template, "html" | "initialState"> & {
  htmlBytes: number;
  instanceCount: number;
};

export type TemplateBinding = {
  tabId: string;
  templateId: string;
  values: TemplateValues;
  stateVersion: number;
  compatible: boolean;
  reason?: string;
};

export type Tab = {
  id: string;
  key: string;
  title: string;
  html: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  /** Set while the tab is in the archive; omitted when open. */
  archivedAt?: number;
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

export type DeletedEntry = {
  tab: Tab;
  deletedAt: number;
};

export const DELETE_LIMIT = 5;

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
      tabs: TabMeta[];
      archive: TabMeta[];
      activeId: string | null;
      templates: TemplateMeta[];
      persistError: string | null;
    }
  | { type: "tab_upserted"; tab: TabMeta; index?: number }
  | { type: "tab_closed"; id: string }
  | { type: "tab_archived"; id: string }
  | { type: "tab_focused"; id: string | null }
  | { type: "tab_focus_request"; id: string }
  | { type: "tab_state"; id: string; state: BoardState; stateRevision: number; client?: string }
  | { type: "tab_signal"; id: string; signal: TabSignal }
  | { type: "archive_cleared" }
  | { type: "template_upserted"; template: TemplateMeta }
  | { type: "template_deleted"; id: string }
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
  /** An agent writing a key owned by a hidden tab gets a new tab instead. */
  viewer?: Viewer;
};

export type SetStateInput = {
  state: BoardState;
  replace?: boolean;
  expectedRevision?: number;
  client?: string;
  resolveIncompatibility?: boolean;
};

export type SignalInput = {
  name: string;
  state?: BoardState;
  client?: string;
};

export type RestorePlacement = "append" | "index";

/** Where imported pages land. `meta` follows each page's archivedAt (missing → open). */
export type ImportDestination = "meta" | "archive";

/** A stale expectedRevision resolves to ok:false carrying the current state so the caller can merge and retry. */
export type SetStateResult =
  | { ok: true; tab: Tab }
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
    ...(tab.archivedAt ? { archivedAt: tab.archivedAt } : {}),
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

export function toTemplateMeta(template: Template, instanceCount = 0): TemplateMeta {
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
  };
}

export function isTemplateBound(tab: { templateId?: string }): boolean {
  return Boolean(tab.templateId);
}

export function isPlainObject(value: unknown): value is BoardState {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
