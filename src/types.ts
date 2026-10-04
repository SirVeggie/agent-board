import type { SpacesView } from "./spaces.js";
import { embedUrlFromHtml } from "./embed.js";
import type { SkippedOp, StateOp } from "./stateOps.js";
import type { PageAssetFile, PageAssetMeta, PageAssetUsage } from "./pageAssets.js";
import type { AgentEvent } from "./agent/types.js";

export type BoardState = Record<string, unknown>;

/** One entry in a page's event log: a signal from the page, or a note from Scribe itself. */
export type PageEvent = {
  /** Per-page sequence number, starting at 1. Waits resume after a seq. */
  seq: number;
  name: string;
  /** Small JSON payload, e.g. { card: "c_12" }. */
  data?: unknown;
  at: number;
  /** "user" for page code (the user clicked something), "agent" for an agent, "scribe" for the daemon. */
  by: "user" | "agent" | "scribe";
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
  /** Agent prompts the user can run on a page made from this template (page menu, palette, chat slash menu). */
  agentActions?: AgentAction[];
};

export const AGENT_ACTION_PLACES = ["menu", "palette", "slash"] as const;
export type AgentActionPlace = (typeof AGENT_ACTION_PLACES)[number];

/**
 * One template-declared agent action. The prompt's placeholders are filled in when it runs:
 * {{selection}} (text selected on the page), {{input}} (text after the slash command),
 * {{page.title}}, {{page.key}}, and the names in `context`; {{#name}}…{{/name}} keeps its text only when
 * name is not empty.
 */
export type AgentAction = {
  /** Slash command name, unique in the template. */
  id: string;
  label: string;
  description?: string;
  prompt: string;
  /** Where it is offered; all three when the template leaves it out. */
  where: AgentActionPlace[];
  /** required: only offered with text selected; none: only without. Default: either. */
  selection?: "required" | "none";
  /**
   * Placeholders the page supplies for what the user right-clicked, e.g. ["card"] for {{card}}: from the
   * data-scribe-context attributes under the cursor, or from scribe.agent.runAction. The action is
   * offered only where the page supplies all of them, so only in a right-click menu.
   */
  context?: string[];
  /** new (default): a new thread on the page with the thread settings; chat: sent in the chat at hand. */
  run?: "new" | "chat";
  /** Settings for a new thread; unset ones follow the user's defaults. */
  thread?: AgentActionThread;
};

export type AgentActionThread = {
  /** Only modes without a workspace folder: board (Pages) or ask. */
  mode?: "board" | "ask";
  provider?: string;
  model?: string;
  effort?: string;
  fast?: boolean;
  web?: "on" | "limited" | "off";
  /** Thread title; placeholders work here too. */
  title?: string;
};

/** Which built-in a local template was copied from, and that built-in's fingerprint at copy time. */
export type TemplateSource = {
  builtin: string;
  fingerprint: string;
};

export type TemplateMeta = Omit<Template, "html" | "initialState" | "source" | "guide" | "agentActions"> & {
  /** Its agent actions, or for a local copy of a built-in without its own, the built-in's. */
  agentActions?: AgentAction[];
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
  /** Seq of the newest event ever logged on this page. */
  eventSeq: number;
  /** The newest events, oldest first, at most MAX_PAGE_EVENTS. */
  events: PageEvent[];
  assets: TabAsset[];
  templateId?: string;
  templateValues?: TemplateValues;
  templateStateVersion?: number;
  templateCompatible?: boolean;
  templateIncompatibleReason?: string;
  /** Only the board UI can set this. Agent requests treat the tab as nonexistent. */
  agentHidden?: boolean;
  /** This page is the standing agent instructions for its Library folder. */
  folderInstructions?: boolean;
  /** Which in-app agent created the page and last changed it. Omitted until an agent writes. */
  provenance?: PageProvenance;
};

/** An in-app chat thread, or an external MCP client with no thread. */
export type PageActor = {
  /** Scribe chat thread id. Omitted for external MCP clients. */
  thread?: string;
  /** Thread title at write time, so Library still has a label if the thread is gone. */
  title?: string;
  at: number;
};

export type PageProvenance = {
  /** Set once, when an agent creates the page. User-created pages leave this unset. */
  created?: PageActor;
  /** Last agent write (HTML, title, template values, or state). */
  changed?: PageActor;
};

export type TabMeta = Omit<Tab, "html" | "state" | "events" | "eventSeq" | "stripSeq"> & {
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
export const PAGE_KEY_PREFIX = "scribe:";
export const WELCOME_KEY = "scribe:welcome";

export function normalizeKey(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const cleaned = trimmed.replace(/[^a-z0-9._:-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 80);
}

/**
 * Page keys read "scribe:<slug>" so a pasted key is recognizable on its own. Lookups accept
 * the slug with or without the prefix.
 */
export function pageKey(value: string): string {
  const slug = normalizeKey(value.trim().replace(/^(scribe:)+/i, ""));
  return slug ? `${PAGE_KEY_PREFIX}${slug}` : "";
}

export function isAppTab(tab: { key: string }): boolean {
  return tab.key === WELCOME_KEY;
}

/** A page titled "Instructions" is that folder's agent instructions unless another page is flagged. */
export function isFolderInstructionTitle(title: string): boolean {
  return title.trim().toLowerCase() === "instructions";
}

/** Who is asking: the board UI (and tab pages), or an agent through the MCP. */
export type Viewer = "user" | "agent";

/** A Library page used as standing agent instructions for a folder. */
export type FolderInstructionPage = {
  /** Library path, or null for the root. */
  folder: string | null;
  key: string;
  title: string;
  text: string;
};

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
      spaces: SpacesView;
      /** Sent to every viewer after a space switch replaced the strip. */
      reset?: boolean;
    }
  | { type: "spaces"; spaces: SpacesView }
  | { type: "tab_upserted"; tab: TabMeta; index?: number; structural: boolean }
  | { type: "tab_deleted"; id: string }
  | { type: "tab_focused"; id: string | null }
  | { type: "tab_focus_request"; id: string }
  /** A state change as the ops that made it. A viewer at fromRevision applies them; one behind refetches. */
  | { type: "tab_state"; id: string; fromRevision: number; stateRevision: number; ops: StateOp[]; client?: string; writeId?: string }
  | { type: "tab_event"; id: string; event: PageEvent }
  | { type: "folders"; folders: Folder[] }
  | { type: "trash" }
  | { type: "template_upserted"; template: TemplateMeta }
  | { type: "template_deleted"; id: string }
  | { type: "builtin_templates"; templates: BuiltinTemplateMeta[] }
  | { type: "page_asset_warning"; id: string; title: string; usage: PageAssetUsage }
  | { type: "persist_error"; error: string }
  | { type: "persist_ok" }
  | AgentEvent;

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
  /** In-app or external agent that made this write. User writes leave it unset. */
  actor?: PageActor;
  /** Refuse to replace an existing page whose revision is no longer this one. Ignored when the key is new. */
  expectedRevision?: number;
};

export type StateWriteInput = {
  /** See stateOps.ts. */
  ops: unknown[];
  /** Skip ops that fail instead of refusing the whole write. Pages write this way. */
  lenient?: boolean;
  expectedRevision?: number;
  /** The bridge instance that wrote, so it can recognize its own delta. */
  client?: string;
  writeId?: string;
  resolveIncompatibility?: boolean;
  /** Local files to store as page assets; op values `asset:<name>` become their URLs. */
  assets?: PageAssetFile[];
  /** In-app or external agent that made this write. User writes leave it unset. */
  actor?: PageActor;
};

export type EventInput = {
  name: string;
  data?: unknown;
  by: PageEvent["by"];
  /** State ops applied (leniently) just before the event is logged, so a wait sees them. */
  ops?: unknown[];
  client?: string;
  writeId?: string;
  actor?: PageActor;
};

export type RestorePlacement = "append" | "index";

/** Where imported pages land. `meta` follows each page's closedAt (missing → open). */
export type ImportDestination = "meta" | "closed";

/** A stale expectedRevision resolves to ok:false with the current revision. */
export type StateWriteResult =
  | { ok: true; tab: Tab; fromRevision: number; applied: StateOp[]; skipped: SkippedOp[]; assets?: PageAssetMeta[] }
  | { ok: false; stateRevision: number };

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
    ...(tab.folderInstructions ? { folderInstructions: true } : {}),
    ...(tab.provenance ? { provenance: tab.provenance } : {}),
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

export function toTemplateMeta(
  template: Template,
  instanceCount = 0,
  builtinUpdate = false,
  agentActions = template.agentActions
): TemplateMeta {
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
    ...(agentActions?.length ? { agentActions } : {}),
  };
}

export function isTemplateBound(tab: { templateId?: string }): boolean {
  return Boolean(tab.templateId);
}

export function isPlainObject(value: unknown): value is BoardState {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ACTOR_THREAD_MAX = 60;
const ACTOR_TITLE_MAX = 120;

export function normalizeActor(value: unknown): PageActor | undefined {
  if (!isPlainObject(value) || typeof value.at !== "number" || !Number.isFinite(value.at)) {
    return undefined;
  }
  const actor: PageActor = { at: value.at };
  if (typeof value.thread === "string" && value.thread.trim()) {
    actor.thread = value.thread.trim().slice(0, ACTOR_THREAD_MAX);
  }
  if (typeof value.title === "string" && value.title.trim()) {
    actor.title = value.title.trim().slice(0, ACTOR_TITLE_MAX);
  }
  return actor;
}

export function normalizeProvenance(value: unknown): PageProvenance | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const created = normalizeActor(value.created);
  const changed = normalizeActor(value.changed);
  if (!created && !changed) {
    return undefined;
  }
  return { ...(created ? { created } : {}), ...(changed ? { changed } : {}) };
}

/** Record an agent write on a page. `created` is only set when this call creates the page. */
export function noteAgentWrite(tab: Tab, actor: PageActor | undefined, created = false): void {
  const stamped = actor ? normalizeActor(actor) : undefined;
  if (!stamped) {
    return;
  }
  const provenance: PageProvenance = { ...(tab.provenance ?? {}), changed: stamped };
  if (created && !provenance.created) {
    provenance.created = stamped;
  }
  tab.provenance = provenance;
}
