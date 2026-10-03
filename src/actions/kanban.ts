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
} from "./types.js";

/** Rules the Kanban page follows too: done time, column order, card numbers, claims. Keep them in step. */

type Column = { id: string; title: string; role?: string; wip?: number };
type Label = { id: string; name: string; color?: string };
type Comment = { id: string; by: "user" | "agent"; at: number; text: string };
type Claim = { holder: string; session?: string; thread?: string; at: number; seenAt?: number; stale?: boolean };
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
  status?: { kind: string; text: string };
  claim?: Claim;
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

/** A column by role (agent, working, review, done), id, or title. */
function findColumn(state: BoardState, ref: unknown): Column {
  const text = str(ref).trim();
  const cols = columns(state);
  const lower = text.toLowerCase();
  const found =
    cols.find((c) => c.role === lower) ??
    cols.find((c) => c.id === text) ??
    cols.find((c) => c.title.trim().toLowerCase() === lower);
  if (!found) {
    const known = cols.map((c) => (c.role ? `${c.title} (${c.role})` : c.title)).join(", ");
    throw new ActionError(`no column "${text}". Columns: ${known}`);
  }
  return found;
}

function roleColumn(state: BoardState, role: string): Column | undefined {
  return columns(state).find((c) => c.role === role);
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

function commentOp(card: Card, by: "user" | "agent", text: string, now: number): unknown {
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

function claimFor(ctx: ActionContext, now: number): Claim {
  const caller = ctx.caller;
  return {
    holder: caller.label || (caller.by === "agent" ? "agent" : "user"),
    ...(caller.session ? { session: caller.session } : {}),
    ...(caller.thread ? { thread: caller.thread } : {}),
    at: now,
    seenAt: now,
  };
}

function sameHolder(claim: Claim, ctx: ActionContext): boolean {
  const caller = ctx.caller;
  if (claim.thread && caller.thread) return claim.thread === caller.thread;
  return Boolean(claim.session && claim.session === caller.session);
}

export const kanbanActions: ActionSet = {
  actions: {
    list: {
      description:
        "Compact rows for the board's cards (no descriptions or comment text), plus the columns. Filter by column (role, id or title), label, assignee, or q (words in title or description). Archived cards only with archived: true.",
      args: "{ column?, label?, assignee?, q?, archived?, limit? }",
      run(state, args) {
        let list = cards(state).filter((c) => (args.archived ? c.archived : !c.archived));
        if (args.column !== undefined) {
          const col = findColumn(state, args.column);
          list = list.filter((c) => c.col === col.id);
        }
        if (args.label !== undefined) {
          const [id] = labelIds(state, [args.label]);
          list = list.filter((c) => arr(c.labels).includes(id));
        }
        if (args.assignee !== undefined) {
          list = list.filter((c) => str(c.assignee) === str(args.assignee));
        }
        if (args.q !== undefined) {
          const words = str(args.q).toLowerCase().split(/\s+/).filter(Boolean);
          list = list.filter((c) => {
            const hay = `${c.title}\n${str(c.description)}`.toLowerCase();
            return words.every((w) => hay.includes(w));
          });
        }
        const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 200;
        return {
          ops: [],
          result: {
            columns: columns(state).map((c) => ({
              id: c.id,
              title: c.title,
              ...(c.role ? { role: c.role } : {}),
              cards: cards(state).filter((x) => x.col === c.id && !x.archived).length,
            })),
            cards: list.slice(0, limit).map((c) => summary(state, c)),
            ...(list.length > limit ? { more: list.length - limit } : {}),
          },
        };
      },
    },
    get: {
      description: "One card in full: description, checklist, comments, images, with column and label names resolved.",
      args: "{ card }",
      run(state, args) {
        const card = findCard(state, args.card);
        // The summary's comment count and last-comment stamp are for list rows; get keeps the comments themselves.
        const { comments: _count, lastComment: _last, ...brief } = summary(state, card);
        return { ops: [], result: { ...card, ...brief, comments: arr<Comment>(card.comments), labelIds: arr(card.labels) } };
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
      description: "Add a comment to a card (markdown). Agents' comments show as the agent's.",
      args: "{ card, text }",
      run(state, args, ctx) {
        const card = findCard(state, args.card);
        const text = str(args.text).trim();
        if (!text) throw new ActionError("text is required");
        return { ops: [commentOp(card, ctx.caller.by, text, ctx.now)], result: { num: card.num, comments: arr(card.comments).length + 1 } };
      },
    },
    move: {
      description:
        "Move a card to a column (role agent | working | review | done, a column id, or its title). Sets the move and done times. position top or bottom; a done column puts it on top.",
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
        "Start work on a card: moves it to the working column, sets assignee \"agent\" and a working status, and records you as its holder. Refused while another live agent holds it. If your thread or session stops, Scribe releases the card for you.",
      args: "{ card, text? }",
      run(state, args, ctx) {
        const card = findCard(state, args.card);
        if (card.claim && !card.claim.stale && !sameHolder(card.claim, ctx)) {
          throw new ActionError(`#${card.num} is held by ${card.claim.holder} since ${new Date(card.claim.at).toISOString()}`);
        }
        const working = roleColumn(state, "working");
        const ops: unknown[] = [
          // Another claim landing first makes this write fail as a whole.
          { op: "test", path: `${cardPath(card)}/claim`, value: card.claim ?? null },
          {
            op: "merge",
            path: cardPath(card),
            value: {
              assignee: "agent",
              status: { kind: "working", text: str(args.text) || "Working on it" },
              claim: claimFor(ctx, ctx.now),
            },
          },
        ];
        if (working) ops.push(...moveOps(state, card, working, ctx.now));
        return { ops, result: { num: card.num, column: working?.title ?? null } };
      },
    },
    release: {
      description:
        "Give a card back without finishing it: clears your claim and status and moves it (default: the agent column). note adds a comment; status (e.g. { kind: \"blocked\", text }) stays on the card.",
      args: "{ card, to?, note?, status? }",
      run(state, args, ctx) {
        const card = findCard(state, args.card);
        const col = args.to !== undefined ? findColumn(state, args.to) : roleColumn(state, "agent");
        const ops: unknown[] = [{ op: "merge", path: cardPath(card), value: { claim: null, status: args.status !== undefined ? checkStatus(args.status) : null } }];
        if (str(args.note).trim()) ops.push(commentOp(card, ctx.caller.by, str(args.note).trim(), ctx.now));
        if (col) ops.push(...moveOps(state, card, col, ctx.now));
        return { ops, result: { num: card.num, column: col?.title ?? null } };
      },
    },
    finish: {
      description:
        "Hand in finished work: adds your summary as a comment, clears status and claim, and moves the card to review (or done when the board has no review column).",
      args: "{ card, summary, to? }",
      run(state, args, ctx) {
        const card = findCard(state, args.card);
        const text = str(args.summary).trim();
        if (!text) throw new ActionError("summary is required: what you did, what to check");
        const col = args.to !== undefined ? findColumn(state, args.to) : (roleColumn(state, "review") ?? roleColumn(state, "done"));
        const ops: unknown[] = [commentOp(card, ctx.caller.by, text, ctx.now), { op: "merge", path: cardPath(card), value: { claim: null, status: null } }];
        if (col) ops.push(...moveOps(state, card, col, ctx.now));
        return { ops, result: { num: card.num, column: col?.title ?? null } };
      },
    },
  },

  sweep(state: BoardState, ctx: SweepContext): ActionOutcome | null {
    const ops: unknown[] = [];
    const events: ActionOutcome["events"] = [];
    const agentCol = roleColumn(state, "agent");
    for (const card of cards(state)) {
      const claim = card.claim;
      if (!claim || claim.stale) continue;
      let release: string | null = null;
      let stale: string | null = null;
      if (claim.thread) {
        const info = ctx.thread(claim.thread);
        if (!info.exists) {
          // Prewarm starts MCP with a throwaway draft id; the real thread is created later.
          // That draft is not in AgentHost, so "missing thread" is not "agent gone" while the
          // MCP session is still calling.
          const seen = claim.session ? Math.max(ctx.sessionSeenAt(claim.session) ?? 0, claim.seenAt ?? claim.at) : 0;
          if (claim.session && seen >= ctx.now - SESSION_STALE_MS) {
            /* still live */
          } else {
            release = "The chat thread working on this card was deleted.";
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
        if (agentCol) ops.push(...moveOps(state, card, agentCol, ctx.now));
        events.push({ name: "claim_lost", data: { card: card.id, num: card.num, reason: release } });
      } else if (stale) {
        ops.push({ op: "merge", path: cardPath(card), value: { claim: { ...claim, stale: true }, status: { kind: "blocked", text: stale } } });
        events.push({ name: "claim_stale", data: { card: card.id, num: card.num, reason: stale } });
      }
    }
    return ops.length ? { ops, result: null, events } : null;
  },
};
