import type { BoardState } from "../types.js";
import { ActionError, arr, newId, str, type ActionContext, type ActionSet } from "./types.js";

type Todo = { id: string; text: string; done?: boolean; description?: string; images?: unknown[]; col?: number };

const todos = (state: BoardState) => arr<Todo>(state.todos);
const itemPath = (item: Todo) => `todos/id=${item.id}`;

function columnCount(ctx: ActionContext): number {
  const count = Math.floor(Number(ctx.values.columns) || 1);
  return Math.max(1, Math.min(6, count));
}

function columnTitles(state: BoardState, ctx: ActionContext): string[] {
  const titles = arr<string>(state.columnTitles);
  return Array.from({ length: columnCount(ctx) }, (_, i) => str(titles[i]) || `Column ${i + 1}`);
}

/** A column by index (0-based) or title. */
function findColumn(state: BoardState, ctx: ActionContext, ref: unknown): number {
  const titles = columnTitles(state, ctx);
  if (typeof ref === "number" && Number.isInteger(ref) && ref >= 0 && ref < titles.length) return ref;
  const text = str(ref).trim().toLowerCase();
  const index = titles.findIndex((title) => title.toLowerCase() === text);
  if (index === -1) throw new ActionError(`no column "${str(ref)}". Columns: ${titles.join(", ")}`);
  return index;
}

/** An item by id, or by its text when exactly one item has it. */
function findItem(state: BoardState, ref: unknown): Todo {
  const text = str(ref).trim();
  if (!text) throw new ActionError("item is required: its id or exact text");
  const list = todos(state);
  const byId = list.find((t) => t.id === text);
  if (byId) return byId;
  const byText = list.filter((t) => str(t.text).trim().toLowerCase() === text.toLowerCase());
  if (byText.length === 1) return byText[0];
  throw new ActionError(byText.length ? `${byText.length} items read "${text}"; use the id` : `no item "${text}"`);
}

function row(state: BoardState, ctx: ActionContext, item: Todo) {
  return {
    id: item.id,
    text: item.text,
    done: Boolean(item.done),
    column: columnTitles(state, ctx)[item.col ?? 0] ?? `Column ${(item.col ?? 0) + 1}`,
    ...(item.description ? { hasDescription: true } : {}),
  };
}

export const todoActions: ActionSet = {
  actions: {
    list: {
      description: "Every item (id, text, done, column), optionally only one column or only open/done items.",
      args: "{ column?, done? }",
      run(state, args, ctx) {
        let list = todos(state);
        if (args.column !== undefined) {
          const col = findColumn(state, ctx, args.column);
          list = list.filter((t) => (t.col ?? 0) === col);
        }
        if (typeof args.done === "boolean") list = list.filter((t) => Boolean(t.done) === args.done);
        return { ops: [], result: { columns: columnTitles(state, ctx), items: list.map((t) => row(state, ctx, t)) } };
      },
    },
    get: {
      description: "One item in full, with its description and images (attached so you can see them).",
      args: "{ item }",
      run(state, args, ctx) {
        const item = findItem(state, args.item);
        return {
          ops: [],
          result: { ...row(state, ctx, item), description: str(item.description), images: arr(item.images) },
        };
      },
    },
    add: {
      description: "Add an item at the end of a column (default the first).",
      args: "{ text, description?, column? }",
      run(state, args, ctx) {
        const text = str(args.text).trim();
        if (!text) throw new ActionError("text is required");
        const col = args.column !== undefined ? findColumn(state, ctx, args.column) : 0;
        const item: Todo = { id: newId("t"), text, done: false, description: str(args.description), images: [], col };
        return { ops: [{ op: "insert", path: "todos", value: item }], result: { id: item.id } };
      },
    },
    update: {
      description: "Change an item's text, description, done, or column.",
      args: "{ item, text?, description?, done?, column? }",
      run(state, args, ctx) {
        const item = findItem(state, args.item);
        const fields: Record<string, unknown> = {};
        if (args.text !== undefined) fields.text = str(args.text);
        if (args.description !== undefined) fields.description = str(args.description);
        if (args.done !== undefined) fields.done = Boolean(args.done);
        if (args.column !== undefined) fields.col = findColumn(state, ctx, args.column);
        if (!Object.keys(fields).length) throw new ActionError("nothing to change");
        return { ops: [{ op: "merge", path: itemPath(item), value: fields }], result: row(state, ctx, { ...item, ...(fields as Partial<Todo>) }) };
      },
    },
    remove: {
      description: "Delete an item.",
      args: "{ item }",
      run(state, args) {
        const item = findItem(state, args.item);
        return { ops: [{ op: "remove", path: itemPath(item) }], result: { removed: item.id } };
      },
    },
  },
};
