import type { BoardState } from "../types.js";
import {
  ActionError,
  arr,
  newId,
  str,
  type ActionContext,
  type ActionOutcome,
  type ActionSet,
  type SweepContext,
  type ThreadRunInfo,
} from "./types.js";

/** Rules the Kanban page follows too: done time, column order, card numbers, claims. Keep them in step. */

type Column = { id: string; title: string; role?: string; wip?: number; paused?: boolean };
type Label = { id: string; name: string; color?: string };
/** `by` is `"user"` for the person, the assignee/worker name for an agent, or `"agent"` on older comments. */
type Comment = { id: string; by: string; at: number; text: string };
type Status = { kind: string; text: string };
/** waiting: set while the holder's turn waits on the user; keeps the status to put back after. */
type Claim = { holder: string; session?: string; thread?: string; at: number; seenAt?: number; stale?: boolean; from?: string; waiting?: { status: Status | null } };
type Card = {
  id: string;
  num: number;
  col: string;
  title: string;
  description?: string;
  labels?: string[];
  priority?: number;
  due?: string;
  assignee?: string;
  checklist?: Array<{ id: string; text: string; done: boolean }>;
  comments?: Comment[];
  images?: unknown[];
  blockedBy?: string[];
  status?: Status;
  claim?: Claim;
  /** Last in-app agent thread that claimed the card; kept after the claim ends. */
  thread?: string;
  /** Last agent column this card entered; sweep/release/changes return it there. */
  from?: string;
  archived?: boolean;
  createdAt?: number;
  movedAt?: number;
  doneAt?: number;
};

/** A thread that ended this long ago, or an MCP session quiet this long, no longer holds its card. */
const THREAD_STALE_MS = 30 * 60 * 1000;
const SESSION_STALE_MS = 60 * 60 * 1000;
const STATUS_KINDS = ["working", "blocked", "info"];

const columns = (state: BoardState) => arr<Column>(state.columns);
const labels = (state: BoardState) => arr<Label>(state.labels);
const cards = (state: BoardState) => arr<Card>(state.cards);
const cardPath = (card: Card) => `cards/id=${card.id}`;

/** Legacy placeholder before workers named the assignee; not a real person or worker. */
function isLegacyAssignee(name: unknown): boolean {
  return str(name).trim().toLowerCase() === "agent";
}

/** The blocked status a card shows while its agent waits on the user. */
function waitingText(asking: NonNullable<Extract<ThreadRunInfo, { exists: true }>["asking"]>): string {
  if (asking.kind === "approval") return `Waiting for your approval: ${asking.title}`;
  if (asking.kind === "plan") return "Waiting for you to review the plan";
  const what = asking.page ? asking.page.title || asking.page.key : asking.title;
  return `Waiting for your answer: ${what}`.slice(0, 300);
}

/** A one-card run from the card menu (`settings.workers[id].solo[threadId]`). */
type SoloRun = {
  card?: number;
  at?: number;
  wait?: { until?: number; count?: number; tries?: number };
  step?: { token: string; at: number };
};

/** An agent worker, set up on the page in settings.workers by its id. It takes the ready cards assigned to its name. */
type Worker = {
  name?: string;
  threadId?: string;
  stop?: boolean;
  run?: unknown;
  step?: { token: string; at: number };
  solo?: Record<string, SoloRun | null | undefined>;
};

/** How long a page holds a worker's step before another window may take over: covers a permission prompt. */
const STEP_LEASE_MS = 15 * 60 * 1000;
/** Newest lines kept in `settings.workerLog` (the page trims; this caps a read). */
const MAX_WORKER_LOG = 200;
const DEFAULT_LOG_LIMIT = 80;

/** One line in the board's worker log: starts, pauses, merges, usage-limit waits. */
type WorkerLogEntry = {
  id?: string;
  at?: number;
  kind?: string;
  text?: string;
  worker?: string;
  workerId?: string;
  card?: number;
  thread?: string;
};

function workerLogEntries(state: BoardState): WorkerLogEntry[] {
  const settings = state.settings as { workerLog?: unknown } | undefined;
  return arr<WorkerLogEntry>(settings?.workerLog).filter((e) => Boolean(e) && typeof e === "object");
}

function compactLog(e: WorkerLogEntry): Record<string, unknown> {
  const card = Number(e.card);
  return {
    at: Number(e.at) || 0,
    kind: str(e.kind) || "info",
    text: str(e.text),
    ...(str(e.worker) ? { worker: str(e.worker) } : {}),
    ...(str(e.workerId) ? { workerId: str(e.workerId) } : {}),
    ...(Number.isFinite(card) && card > 0 ? { card } : {}),
    ...(str(e.thread) ? { thread: str(e.thread) } : {}),
  };
}

function workerMap(state: BoardState): Record<string, Worker> {
  const settings = state.settings as { workers?: Record<string, Worker> } | undefined;
  const all = settings?.workers;
  return all && typeof all === "object" ? all : {};
}

/** The workers as [id, worker] pairs, skipping broken entries. */
function workerList(state: BoardState): Array<[string, Worker]> {
  return Object.entries(workerMap(state)).filter((e): e is [string, Worker] => Boolean(e[1]) && typeof e[1] === "object");
}

/** A worker by id, else by name. */
function findWorker(state: BoardState, ref: unknown): [string, Worker] {
  const text = str(ref).trim();
  const list = workerList(state);
  const found = list.find(([id]) => id === text) ?? list.find(([, w]) => str(w.name).trim().toLowerCase() === text.toLowerCase());
  if (!found) throw new ActionError(`no agent worker "${text}"`);
  return found;
}

/** Title, description, comments, checklist, status, assignee, and card number for `list` q. */
function searchHay(c: Card): string {
  const comments = arr<Comment>(c.comments)
    .map((cm) => str(cm.text))
    .join("\n");
  const checks = arr<unknown>(c.checklist)
    .map((it) => (typeof it === "string" ? it : str((it as { text?: string } | null)?.text)))
    .join("\n");
  const status = c.status ? str(c.status.text) : "";
  return `#${c.num} ${c.num} ${str(c.title)}\n${str(c.description)}\n${comments}\n${checks}\n${status}\n${str(c.assignee)}`.toLowerCase();
}

function matchesQuery(c: Card, q: unknown): boolean {
  const words = str(q)
    .toLowerCase()
    .replace(/^#/, "")
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return true;
  const hay = searchHay(c);
  return words.every((w) => hay.includes(w));
}

function findCard(state: BoardState, ref: unknown): Card {
  const text = str(ref).trim().replace(/^#/, "");
  if (!text) {
    throw new ActionError("card is required: its number (12 or \"#12\") or id");
  }
  const list = cards(state);
  const found = /^\d+$/.test(text) ? list.find((c) => c.num === Number(text)) : list.find((c) => c.id === text);
  if (!found) {
    throw new ActionError(`no card ${/^\d+$/.test(text) ? "#" + text : text}`);
  }
  return found;
}

/** Columns matching a role (all of them), else one by id or title. */
function matchColumns(state: BoardState, ref: unknown): Column[] {
  const text = str(ref).trim();
  const cols = columns(state);
  const lower = text.toLowerCase();
  const byRole = cols.filter((c) => c.role === lower);
  if (byRole.length) return byRole;
  const one = cols.find((c) => c.id === text) ?? cols.find((c) => c.title.trim().toLowerCase() === lower);
  if (one) return [one];
  const known = cols.map((c) => (c.role ? `${c.title} (${c.role})` : c.title)).join(", ");
  throw new ActionError(`no column "${text}". Columns: ${known}`);
}

/** One column by role, id, or title. A shared role (two agent inboxes) is not a destination. */
function findColumn(state: BoardState, ref: unknown): Column {
  const found = matchColumns(state, ref);
  if (found.length > 1) {
    const names = found.map((c) => c.title).join(", ");
    throw new ActionError(`column "${str(ref).trim()}" matches more than one column: ${names}. Use a column id or title.`);
  }
  return found[0];
}

function roleColumn(state: BoardState, role: string): Column | undefined {
  return columns(state).find((c) => c.role === role);
}

function columnById(state: BoardState, id: string | undefined): Column | undefined {
  return id ? columns(state).find((c) => c.id === id) : undefined;
}

function inDoneColumn(state: BoardState, card: Card): boolean {
  return columnById(state, card.col)?.role === "done";
}

/** Left-to-right on the board; cards in the same column keep their current order. */
function byBoardOrder(state: BoardState, list: Card[]): Card[] {
  const index = new Map(columns(state).map((c, i) => [c.id, i]));
  return [...list].sort((a, b) => (index.get(a.col) ?? 9999) - (index.get(b.col) ?? 9999));
}

/** Agent column the card was in (or last came from) when this claim started. */
function claimFrom(state: BoardState, card: Card): string | undefined {
  const current = columnById(state, card.col);
  if (current?.role === "agent") return current.id;
  return columnById(state, card.from)?.id ?? columnById(state, card.claim?.from)?.id;
}

function soloRunOf(w: Worker, threadId: string): SoloRun | undefined {
  const run = w.solo?.[threadId];
  return run && typeof run === "object" ? run : undefined;
}

/** Last turn of an idle thread, or null if it is gone. Throws while the agent is still working. */
function workerLastTurn(info: ThreadRunInfo | undefined): Extract<ThreadRunInfo, { exists: true }>["lastTurn"] | null {
  if (!info?.exists) return null;
  if (info.running || !info.lastTurn || info.lastTurn.status === "running") throw new ActionError("the agent is still working");
  const { status, endedAt, error, limitResetsAt, usageRecoveryAllowed } = info.lastTurn;
  return { status, ...(endedAt ? { endedAt } : {}), ...(error ? { error } : {}), ...(limitResetsAt ? { limitResetsAt } : {}), ...(usageRecoveryAllowed !== undefined ? { usageRecoveryAllowed } : {}) };
}

/**
 * The thread is a worker chat the board will send on after a plan limit resets: its own run, or a
 * one-card run from the card menu (`solo`).
 */
function workerWaits(state: BoardState, threadId: string): boolean {
  return workerList(state).some(([, w]) => (w.threadId === threadId && Boolean(w.run)) || Boolean(soloRunOf(w, threadId)));
}

function resetTime(at: number): string {
  return new Date(at).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

/** Where a stopped or released card goes: the inbox it came from, else the first agent column. */
function returnColumn(state: BoardState, card: Card): Column | undefined {
  return columnById(state, card.claim?.from) ?? columnById(state, card.from) ?? roleColumn(state, "agent");
}

function labelIds(state: BoardState, refs: unknown): string[] {
  return arr(refs).map((ref) => {
    const text = str(ref).trim();
    const found = labels(state).find((l) => l.id === text || l.name.toLowerCase() === text.toLowerCase());
    if (!found) {
      throw new ActionError(`no label "${text}". Labels: ${labels(state).map((l) => l.name).join(", ") || "none"}`);
    }
    return found.id;
  });
}

/** Where a card lands in `cards` when it enters a column: on top, or after the column's last card. */
function placement(state: BoardState, colId: string, top: boolean, except?: string): Record<string, unknown> {
  const inCol = cards(state).filter((c) => c.col === colId && c.id !== except);
  if (!inCol.length) {
    return { at: "end" };
  }
  return top ? { before: `id=${inCol[0].id}` } : { after: `id=${inCol[inCol.length - 1].id}` };
}

/** Ops that move a card into a column, with the page's timestamp rules. Done columns put it on top. */
function moveOps(state: BoardState, card: Card, col: Column, now: number, position?: unknown): unknown[] {
  const done = col.role === "done";
  const top = position === "top" || (position === undefined && done);
  const fields: Record<string, unknown> = {};
  if (card.col !== col.id) {
    fields.col = col.id;
    fields.movedAt = now;
  }
  if (col.role === "agent") fields.from = col.id;
  if (done && !card.doneAt) fields.doneAt = now;
  if (!done && card.doneAt) fields.doneAt = null;
  const ops: unknown[] = [];
  if (Object.keys(fields).length) ops.push({ op: "merge", path: cardPath(card), value: fields });
  if (card.col !== col.id || position !== undefined) {
    ops.push({ op: "move", path: cardPath(card), ...placement(state, col.id, top, card.id) });
  }
  return ops;
}

function summary(state: BoardState, card: Card) {
  const col = columns(state).find((c) => c.id === card.col);
  const comments = arr<Comment>(card.comments);
  const last = comments.at(-1);
  return {
    num: card.num,
    id: card.id,
    title: card.title,
    column: col?.title ?? card.col,
    ...(col?.role ? { role: col.role } : {}),
    labels: arr<string>(card.labels).map((id) => labels(state).find((l) => l.id === id)?.name ?? id),
    ...(card.priority ? { priority: card.priority } : {}),
    ...(card.due ? { due: card.due } : {}),
    ...(card.assignee ? { assignee: card.assignee } : {}),
    ...(card.status ? { status: card.status } : {}),
    ...(card.claim ? { claim: { holder: card.claim.holder, at: card.claim.at, ...(card.claim.stale ? { stale: true } : {}) } } : {}),
    ...(arr(card.blockedBy).length
      ? { blockedBy: arr<string>(card.blockedBy).map((id) => cards(state).find((c) => c.id === id)?.num ?? id) }
      : {}),
    comments: comments.length,
    ...(last ? { lastComment: { by: last.by, at: last.at } } : {}),
    ...(card.archived ? { archived: true } : {}),
  };
}

/** The same text, give or take spacing and case: a summary that only repeats a comment. */
function sameText(a: string, b: string): boolean {
  const norm = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();
  return norm(a) === norm(b);
}

function isUserComment(by: string): boolean {
  return !str(by).trim() || str(by).trim().toLowerCase() === "user";
}

function commentOp(card: Card, by: string, text: string, now: number): unknown {
  return { op: "insert", path: `${cardPath(card)}/comments`, value: { id: newId("cm"), by, at: now, text } };
}

function checkStatus(value: unknown): { kind: string; text: string } | null {
  if (value === null) return null;
  const status = value as { kind?: unknown; text?: unknown };
  const kind = str(status?.kind || "working");
  if (!STATUS_KINDS.includes(kind)) {
    throw new ActionError(`status.kind must be one of ${STATUS_KINDS.join(", ")}`);
  }
  return { kind, text: str(status?.text) };
}

function claimFor(ctx: ActionContext, now: number, from?: string): Claim {
  const caller = ctx.caller;
  return {
    holder: caller.label || (caller.by === "agent" ? "agent" : "user"),
    ...(caller.session ? { session: caller.session } : {}),
    ...(caller.thread ? { thread: caller.thread } : {}),
    at: now,
    seenAt: now,
    ...(from ? { from } : {}),
  };
}

function sameHolder(claim: Claim, ctx: ActionContext): boolean {
  const caller = ctx.caller;
  if (claim.thread && caller.thread) return claim.thread === caller.thread;
  return Boolean(claim.session && claim.session === caller.session);
}

const PROVIDER_ASSIGNEE: Record<string, string> = { claude: "Claude", cursor: "Cursor", codex: "Codex" };

/** Who shows on the card: an explicit arg, else the MCP client name, else Claude/Cursor from the in-app thread. */
function claimAssignee(args: Record<string, unknown>, ctx: ActionContext): string {
  if (args.assignee !== undefined) {
    const name = str(args.assignee).trim().slice(0, 60);
    if (!name) throw new ActionError("assignee is empty");
    return name;
  }
  const label = ctx.caller.label?.trim() ?? "";
  if (label && label !== "agent" && !label.startsWith("Scribe chat:")) return label.slice(0, 60);
  return PROVIDER_ASSIGNEE[ctx.caller.provider ?? ""] || "agent";
}

/** Name stored on an agent's comment: the worker on this thread, else the card's assignee. */
function commentAuthor(state: BoardState, card: Card, ctx: ActionContext): string {
  if (ctx.caller.by !== "agent") return "user";
  const thread = str(ctx.caller.thread);
  if (thread) {
    for (const [, w] of workerList(state)) {
      const name = str(w.name).trim().slice(0, 60);
      if (!name) continue;
      if (str(w.threadId) === thread || soloRunOf(w, thread)) return name;
    }
  }
  const assignee = str(card.assignee).trim().slice(0, 60);
  if (assignee && assignee.toLowerCase() !== "agent") return assignee;
  return claimAssignee({}, ctx);
}

export const kanbanActions: ActionSet = {
  actions: {
    list: {
      description:
        "Compact rows for the board's cards (no descriptions or comment text), plus the columns and the agent workers (stopRequested: true on one the user asked to stop). Filter by column (role for every column with that role, or id or title), label, assignee, or q (words in title, description, comments, or checklist). Rows follow board column order. With no column, done-role cards are omitted unless done: true (only that role) or q (search still finds them). Archived cards only with archived: true.",
      args: "{ column?, label?, assignee?, q?, archived?, done?, limit? }",
      run(state, args) {
        let list = cards(state).filter((c) => (args.archived ? c.archived : !c.archived));
        if (args.column !== undefined) {
          const ids = new Set(matchColumns(state, args.column).map((c) => c.id));
          list = list.filter((c) => ids.has(c.col));
        } else if (!args.archived) {
          if (args.done) {
            list = list.filter((c) => inDoneColumn(state, c));
          } else if (args.q === undefined) {
            list = list.filter((c) => !inDoneColumn(state, c));
          }
        }
        if (args.label !== undefined) {
          const [id] = labelIds(state, [args.label]);
          list = list.filter((c) => arr(c.labels).includes(id));
        }
        if (args.assignee !== undefined) {
          const who = str(args.assignee).trim().toLowerCase();
          list = list.filter((c) => str(c.assignee).trim().toLowerCase() === who);
        }
        if (args.q !== undefined) {
          list = list.filter((c) => matchesQuery(c, args.q));
        }
        list = byBoardOrder(state, list);
        const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 200;
        return {
          ops: [],
          result: {
            columns: columns(state).map((c) => ({
              id: c.id,
              title: c.title,
              ...(c.role ? { role: c.role } : {}),
              ...(c.paused ? { paused: true } : {}),
              cards: cards(state).filter((x) => x.col === c.id && !x.archived).length,
            })),
            ...(workerList(state).length
              ? {
                  workers: workerList(state).map(([id, w]) => ({
                    id,
                    name: str(w.name) || id,
                    ...(w.run ? { running: true } : {}),
                    ...(w.stop === true ? { stopRequested: true } : {}),
                  })),
                }
              : {}),
            cards: list.slice(0, limit).map((c) => summary(state, c)),
            ...(list.length > limit ? { more: list.length - limit } : {}),
          },
        };
      },
    },
    get: {
      description:
        "One card in full: description, checklist, comments, images (attached so you can see them), with column and label names resolved.",
      args: "{ card }",
      run(state, args) {
        const card = findCard(state, args.card);
        // The summary's comment count and last-comment stamp are for list rows; get keeps the comments themselves.
        const { comments: _count, lastComment: _last, ...brief } = summary(state, card);
        return { ops: [], result: { ...card, ...brief, comments: arr<Comment>(card.comments), labelIds: arr(card.labels) } };
      },
    },
    logs: {
      description:
        "Recent worker log lines (starts, pauses, merges, usage-limit waits) so you can debug the board's run without Keeper process logs. Oldest first among the last `limit` (default 80, max 200). worker is a name or id; kind is start, stop, pause, launch, merge, merge_fix, blocked, limit, resume, wait, or solo; q matches text, worker, kind, or #card.",
      args: "{ worker?, kind?, q?, limit? }",
      run(state, args) {
        let list = workerLogEntries(state);
        if (args.worker !== undefined && str(args.worker).trim()) {
          const [workerId] = findWorker(state, args.worker);
          list = list.filter((e) => str(e.workerId) === workerId || str(e.worker).trim().toLowerCase() === str(args.worker).trim().toLowerCase());
        }
        if (args.kind !== undefined && str(args.kind).trim()) {
          const kind = str(args.kind).trim().toLowerCase();
          list = list.filter((e) => str(e.kind).toLowerCase() === kind);
        }
        if (args.q !== undefined && str(args.q).trim()) {
          const words = str(args.q)
            .toLowerCase()
            .split(/\s+/)
            .filter(Boolean);
          list = list.filter((e) => {
            const hay = `${str(e.text)} ${str(e.worker)} ${str(e.kind)} ${e.card ? "#" + e.card : ""}`.toLowerCase();
            return words.every((w) => hay.includes(w));
          });
        }
        list = [...list].sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0) || str(a.id).localeCompare(str(b.id)));
        const limit =
          typeof args.limit === "number" && args.limit > 0
            ? Math.min(Math.floor(args.limit), MAX_WORKER_LOG)
            : DEFAULT_LOG_LIMIT;
        const slice = list.slice(-limit);
        return {
          ops: [],
          result: {
            logs: slice.map(compactLog),
            total: list.length,
            ...(list.length > slice.length ? { more: list.length - slice.length } : {}),
          },
        };
      },
    },
    create: {
      description:
        "Add a card. column defaults to the first column. labels are names or ids. The card gets the next number; position top or bottom (default bottom, top in a done column).",
      args: "{ title, description?, column?, labels?, priority?, due?, checklist?: string[], position? }",
      run(state, args, ctx) {
        const title = str(args.title).trim();
        if (!title) throw new ActionError("title is required");
        const col = args.column !== undefined ? findColumn(state, args.column) : columns(state)[0];
        if (!col) throw new ActionError("the board has no columns yet; open it once so it can set them up");
        const now = ctx.now;
        const num = Math.max(1, Math.floor(Number(state.nextNum) || 1), ...cards(state).map((c) => c.num + 1));
        const card: Card = {
          id: newId("c"),
          num,
          col: col.id,
          title,
          description: str(args.description),
          labels: labelIds(state, args.labels),
          priority: Math.max(0, Math.min(4, Math.floor(Number(args.priority) || 0))),
          ...(args.due ? { due: str(args.due) } : {}),
          checklist: arr(args.checklist).map((text) => ({ id: newId("ck"), text: str(text), done: false })),
          comments: [],
          images: [],
          blockedBy: [],
          createdAt: now,
          movedAt: now,
          ...(col.role === "agent" ? { from: col.id } : {}),
          ...(col.role === "done" ? { doneAt: now } : {}),
        };
        const top = args.position === "top" || (args.position === undefined && col.role === "done");
        return {
          ops: [
            { op: "insert", path: "cards", value: card, ...placement(state, col.id, top) },
            { op: "set", path: "nextNum", value: num + 1 },
          ],
          result: { num, id: card.id },
        };
      },
    },
    update: {
      description:
        "Change a card's fields. labels (names or ids) and checklist replace the whole list; a checklist item is a string or { text, done }. status: { kind: working | blocked | info, text }, or null to clear it.",
      args: "{ card, title?, description?, labels?, priority?, due?, assignee?, checklist?, status?, blockedBy? }",
      run(state, args) {
        const card = findCard(state, args.card);
        const fields: Record<string, unknown> = {};
        if (args.title !== undefined) fields.title = str(args.title);
        if (args.description !== undefined) fields.description = str(args.description);
        if (args.labels !== undefined) fields.labels = labelIds(state, args.labels);
        if (args.priority !== undefined) fields.priority = Math.max(0, Math.min(4, Math.floor(Number(args.priority) || 0)));
        if (args.due !== undefined) fields.due = args.due === null ? null : str(args.due);
        if (args.assignee !== undefined) fields.assignee = args.assignee === null ? null : str(args.assignee);
        if (args.status !== undefined) fields.status = checkStatus(args.status);
        if (args.blockedBy !== undefined) fields.blockedBy = arr(args.blockedBy).map((ref) => findCard(state, ref).id);
        if (args.checklist !== undefined) {
          fields.checklist = arr(args.checklist).map((item) => {
            const entry = typeof item === "object" && item ? (item as { text?: unknown; done?: unknown }) : { text: item };
            return { id: newId("ck"), text: str(entry.text), done: Boolean(entry.done) };
          });
        }
        if (!Object.keys(fields).length) throw new ActionError("nothing to change");
        return { ops: [{ op: "merge", path: cardPath(card), value: fields }], result: summary(state, { ...card, ...(fields as Partial<Card>) }) };
      },
    },
    comment: {
      description: "Add a comment to a card (markdown). Agent comments show as the assignee that posted them.",
      args: "{ card, text }",
      run(state, args, ctx) {
        const card = findCard(state, args.card);
        const text = str(args.text).trim();
        if (!text) throw new ActionError("text is required");
        return { ops: [commentOp(card, commentAuthor(state, card, ctx), text, ctx.now)], result: { num: card.num, comments: arr(card.comments).length + 1 } };
      },
    },
    move: {
      description:
        "Move a card to a column (unique role agent | working | review | done, a column id, or its title). Sets the move and done times. position top or bottom; a done column puts it on top.",
      args: "{ card, to, position? }",
      run(state, args, ctx) {
        const card = findCard(state, args.card);
        const col = findColumn(state, args.to);
        if (args.position !== undefined && args.position !== "top" && args.position !== "bottom") {
          throw new ActionError('position is "top" or "bottom"');
        }
        return { ops: moveOps(state, card, col, ctx.now, args.position), result: { num: card.num, column: col.title } };
      },
    },
    claim: {
      description:
        "Start work on a card: moves it to the working column, sets assignee (your name, or assignee if you pass one) and a working status, and records you as its holder. Refused while another live agent holds it, and for an agent worker's chat once the user asked that worker to stop. If your thread or session stops, Scribe releases the card for you.",
      args: "{ card, text?, assignee? }",
      run(state, args, ctx) {
        const card = findCard(state, args.card);
        if (card.claim && !card.claim.stale && !sameHolder(card.claim, ctx)) {
          throw new ActionError(`#${card.num} is held by ${card.claim.holder} since ${new Date(card.claim.at).toISOString()}`);
        }
        // A worker the user asked to stop takes no further card, so its agent needs no list to check.
        const thread = str(ctx.caller.thread);
        const stopping = thread && !(card.claim && card.claim.thread === thread) && workerList(state).find(([, w]) => w.stop === true && str(w.threadId) === thread);
        if (stopping) throw new ActionError(`The user asked the worker "${str(stopping[1].name)}" to stop after its card. Take no more cards; end your turn.`);
        const working = roleColumn(state, "working");
        const from = claimFrom(state, card);
        const ops: unknown[] = [
          // Another claim landing first makes this write fail as a whole.
          { op: "test", path: `${cardPath(card)}/claim`, value: card.claim ?? null },
          {
            op: "merge",
            path: cardPath(card),
            value: {
              assignee: claimAssignee(args, ctx),
              status: { kind: "working", text: str(args.text) || "Working on it" },
              claim: claimFor(ctx, ctx.now, from),
              ...(ctx.caller.thread ? { thread: ctx.caller.thread } : {}),
              ...(from ? { from } : {}),
            },
          },
        ];
        if (working) ops.push(...moveOps(state, card, working, ctx.now));
        return { ops, result: { num: card.num, column: working?.title ?? null } };
      },
    },
    worker_claim: {
      description:
        "The board's own bookkeeping when it starts an agent chat on a card (a worker's run, a one-card run, or Continue); only the page calls it. Claims the card for that chat under the worker's name and moves it to the working column, so the agent doesn't spend a call on it.",
      args: "{ card, thread, assignee, text? }",
      run(state, args, ctx) {
        if (ctx.caller.by !== "user") throw new ActionError("worker_claim is for the board page itself");
        const card = findCard(state, args.card);
        const thread = str(args.thread).trim();
        if (!thread) throw new ActionError("thread is required");
        const name = str(args.assignee).trim().slice(0, 60);
        if (!name) throw new ActionError("assignee is required");
        if (card.claim && !card.claim.stale && card.claim.thread !== thread) {
          throw new ActionError(`#${card.num} is held by ${card.claim.holder} since ${new Date(card.claim.at).toISOString()}`);
        }
        const working = roleColumn(state, "working");
        const from = claimFrom(state, card);
        const ops: unknown[] = [
          { op: "test", path: `${cardPath(card)}/claim`, value: card.claim ?? null },
          {
            op: "merge",
            path: cardPath(card),
            value: {
              assignee: name,
              status: { kind: "working", text: str(args.text) || "Agent starting" },
              claim: { holder: name, thread, at: ctx.now, seenAt: ctx.now, ...(from ? { from } : {}) },
              thread,
              ...(from ? { from } : {}),
            },
          },
        ];
        if (working) ops.push(...moveOps(state, card, working, ctx.now));
        return { ops, result: { num: card.num, column: working?.title ?? null } };
      },
    },
    release: {
      description:
        "Give a card back without finishing it: clears your claim and status and moves it (default: the column it was claimed from). note adds a comment; status (e.g. { kind: \"blocked\", text }) stays on the card.",
      args: "{ card, to?, note?, status? }",
      run(state, args, ctx) {
        const card = findCard(state, args.card);
        const col = args.to !== undefined ? findColumn(state, args.to) : returnColumn(state, card);
        const ops: unknown[] = [{ op: "merge", path: cardPath(card), value: { claim: null, status: args.status !== undefined ? checkStatus(args.status) : null } }];
        if (str(args.note).trim()) ops.push(commentOp(card, commentAuthor(state, card, ctx), str(args.note).trim(), ctx.now));
        if (col) ops.push(...moveOps(state, card, col, ctx.now));
        return { ops, result: { num: card.num, column: col?.title ?? null } };
      },
    },
    finish: {
      description:
        "Hand in finished work: posts summary as the card's hand-in comment (so do not also comment the same wrap-up), clears status and claim, and moves the card to review (or done when the board has no review column). Leave summary out to make the comment you already posted since claiming the card the hand-in.",
      args: "{ card, summary?, to? }",
      run(state, args, ctx) {
        const card = findCard(state, args.card);
        const text = str(args.summary).trim();
        // The caller's own comment from this claim, if it wrote its wrap-up as a comment already.
        const since = card.claim && sameHolder(card.claim, ctx) ? card.claim.at : Infinity;
        const own = arr<Comment>(card.comments).filter((c) => !isUserComment(c.by) && c.at >= since).at(-1);
        if (!text && !own) {
          throw new ActionError(
            "summary is required: it is posted as the card's hand-in comment (what changed, what to check). If you already posted that as a comment since claiming the card, call finish without summary and that comment is the hand-in."
          );
        }
        const repeat = Boolean(text && own && sameText(text, own.text));
        const ops: unknown[] = [...(text && !repeat ? [commentOp(card, commentAuthor(state, card, ctx), text, ctx.now)] : []), { op: "merge", path: cardPath(card), value: { claim: null, status: null } }];
        const col = args.to !== undefined ? findColumn(state, args.to) : (roleColumn(state, "review") ?? roleColumn(state, "done"));
        if (col) ops.push(...moveOps(state, card, col, ctx.now));
        return { ops, result: { num: card.num, column: col?.title ?? null, ...(text && !repeat ? {} : { handIn: "your earlier comment" }) } };
      },
    },
    worker_step: {
      description:
        "The board's own bookkeeping for its agent workers; only the page calls it. Takes a worker for one step (start, or move on from its thread once that thread is done), so two windows don't both start the next agent.",
      args: "{ worker, from, token, start? }",
      run(state, args, ctx) {
        if (ctx.caller.by !== "user") throw new ActionError("worker_step is for the board page itself");
        const [workerId, w] = findWorker(state, args.worker);
        const token = str(args.token).trim();
        if (!token) throw new ActionError("token is required");
        if ((str(args.from) || null) !== (str(w.threadId) || null)) throw new ActionError("the worker has moved on");
        if (args.start) {
          // The page only starts a worker that isn't running, so a lease left behind is a window that went away mid-step.
          if (w.run) throw new ActionError("the worker is already running");
        } else {
          if (!w.run) throw new ActionError("the worker is not running");
          if (w.step && w.step.token !== token && w.step.at > ctx.now - STEP_LEASE_MS) throw new ActionError("another window is on it");
        }
        const lastTurn = w.threadId && ctx.thread ? workerLastTurn(ctx.thread(w.threadId)) : null;
        const value: Record<string, unknown> = { step: { token, at: ctx.now } };
        if (args.start) Object.assign(value, { run: { since: ctx.now }, stop: null, error: null });
        return { ops: [{ op: "merge", path: `settings/workers/${workerId}`, value }], result: { ok: true, lastTurn } };
      },
    },
    worker_solo_step: {
      description:
        "The board's own bookkeeping for a one-card worker run (right-click Run, or Continue); only the page calls it. Takes that chat for one step (wrap up, or send it on after a plan limit), so two windows don't both send it on.",
      args: "{ worker, thread, token }",
      run(state, args, ctx) {
        if (ctx.caller.by !== "user") throw new ActionError("worker_solo_step is for the board page itself");
        const [workerId, w] = findWorker(state, args.worker);
        const threadId = str(args.thread).trim();
        const token = str(args.token).trim();
        if (!threadId) throw new ActionError("thread is required");
        if (!token) throw new ActionError("token is required");
        const run = soloRunOf(w, threadId);
        if (!run) throw new ActionError("that chat is not a one-card run of this worker");
        if (run.step && run.step.token !== token && run.step.at > ctx.now - STEP_LEASE_MS) throw new ActionError("another window is on it");
        const lastTurn = ctx.thread ? workerLastTurn(ctx.thread(threadId)) : null;
        return {
          ops: [{ op: "merge", path: `settings/workers/${workerId}/solo/${threadId}`, value: { step: { token, at: ctx.now } } }],
          result: { ok: true, lastTurn },
        };
      },
    },
  },

  sweep(state: BoardState, ctx: SweepContext): ActionOutcome | null {
    const ops: unknown[] = [];
    const events: ActionOutcome["events"] = [];
    for (const card of cards(state)) {
      if (isLegacyAssignee(card.assignee)) {
        ops.push({ op: "merge", path: cardPath(card), value: { assignee: null } });
      }
    }
    for (const card of cards(state)) {
      const claim = card.claim;
      if (!claim || claim.stale) continue;
      let release: string | null = null;
      let stale: string | null = null;
      let waiting: string | null = null;
      let working = false;
      if (claim.thread) {
        const info = ctx.thread(claim.thread);
        working = info.exists && (info.running || info.lastTurn?.status === "done") && info.outputAt !== undefined && info.outputAt >= claim.at;
        if (info.exists && info.running && info.asking) {
          // A worker's turn asking the user (page_ask, a question, an approval) holds its column up: say so on the card.
          waiting = waitingText(info.asking);
        } else if (!info.exists) {
          // Prewarm starts MCP with a throwaway draft id; the real thread is created later.
          // That draft is not in AgentHost, so "missing thread" is not "agent gone" while the
          // MCP session is still calling.
          const seen = claim.session ? Math.max(ctx.sessionSeenAt(claim.session) ?? 0, claim.seenAt ?? claim.at) : 0;
          if (claim.session && seen >= ctx.now - SESSION_STALE_MS) {
            /* still live */
          } else {
            release = "The chat thread working on this card was deleted.";
          }
        } else if (!info.running && info.lastTurn?.limitResetsAt && workerWaits(state, claim.thread)) {
          // A plan limit stopped the turn; the worker goes on in the same chat once the limit resets.
          const resetsAt = info.lastTurn.limitResetsAt;
          if (resetsAt < ctx.now - THREAD_STALE_MS) {
            stale = "The agent ran out of plan usage, and its worker didn't pick it up again after the limit reset.";
          } else {
            const text = `Out of plan usage. The worker goes on after the limit resets (${resetTime(resetsAt)}).`;
            if (card.status?.text !== text) ops.push({ op: "merge", path: cardPath(card), value: { status: { kind: "info", text } } });
          }
        } else if (!info.running && info.lastTurn && (info.lastTurn.status === "error" || info.lastTurn.status === "cancelled")) {
          const how = info.lastTurn.status === "error" ? `failed${info.lastTurn.error ? `: ${info.lastTurn.error}` : ""}` : "was stopped";
          release = `The agent's turn ${how} before it finished this card.`;
        } else if (!info.running && (info.lastTurn?.endedAt ?? claim.at) < ctx.now - THREAD_STALE_MS) {
          stale = "The agent's thread stopped over 30 minutes ago without finishing this card.";
        }
      } else if (claim.session) {
        const seen = Math.max(ctx.sessionSeenAt(claim.session) ?? 0, claim.seenAt ?? claim.at);
        if (seen < ctx.now - SESSION_STALE_MS) {
          stale = "No word from the agent for over an hour. It may have stopped.";
        }
      }
      if (release) {
        ops.push({ op: "merge", path: cardPath(card), value: { claim: null, status: { kind: "blocked", text: release } } });
        const agentCol = returnColumn(state, card);
        if (agentCol) ops.push(...moveOps(state, card, agentCol, ctx.now));
        events.push({ name: "claim_lost", data: { card: card.id, num: card.num, reason: release } });
      } else if (stale) {
        ops.push({ op: "merge", path: cardPath(card), value: { claim: { ...claim, stale: true }, status: { kind: "blocked", text: stale } } });
        events.push({ name: "claim_stale", data: { card: card.id, num: card.num, reason: stale } });
      } else if (waiting) {
        if (card.status?.text !== waiting) {
          const before = claim.waiting ?? { status: card.status ?? null };
          ops.push({ op: "merge", path: cardPath(card), value: { status: { kind: "blocked", text: waiting }, claim: { ...claim, waiting: before } } });
        }
      } else if (claim.waiting) {
        // Answered: put back the status the card had, unless someone changed it meanwhile.
        const { waiting: was, ...rest } = claim;
        const ours = card.status?.kind === "blocked" && /^Waiting for (your|you to)/.test(card.status.text);
        const status = working && launchStatus(was.status) ? { kind: "working", text: "Agent working" } : was.status;
        ops.push({ op: "merge", path: cardPath(card), value: { claim: rest, ...(ours ? { status } : {}) } });
      } else if (working && launchStatus(card.status)) {
        ops.push({ op: "merge", path: cardPath(card), value: { status: { kind: "working", text: "Agent working" } } });
      }
    }
    return ops.length ? { ops, result: null, events } : null;
  },
};

/** Only replace statuses the board set for launch or a plan-limit wait. */
function launchStatus(status: Status | null | undefined): boolean {
  return status?.kind === "working" && status.text === "Agent starting"
    || status?.kind === "info" && /^Out of plan usage\. The worker goes on after the limit resets \(.+\)\.$/.test(status.text);
}
