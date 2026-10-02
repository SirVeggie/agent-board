import { kanbanActions } from "./kanban.js";
import { todoActions } from "./todo.js";
import type { ActionSet } from "./types.js";

/** Actions shipped with built-in templates, by the built-in's key. Pages made from a copy get them too. */
export const BUILTIN_ACTIONS: Record<string, ActionSet> = {
  kanban: kanbanActions,
  "todo-list": todoActions,
};

/** The action list as a guide section, so agents see names and arguments next to the state shape. */
export function describeActions(set: ActionSet): string {
  return Object.entries(set.actions)
    .map(([name, def]) => `- \`${name}\` ${def.args}: ${def.description}`)
    .join("\n");
}

export * from "./types.js";
