import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeTemplateInput } from "./templates.js";
import type { Template } from "./types.js";

/** Built-ins ship as <key>.json (metadata and fields), <key>.html, and optionally <key>.guide.md in templates/builtin. */
const builtinDir = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "templates", "builtin");

export const BUILTIN_ID_PREFIX = "builtin:";

export function isBuiltinId(id: string): boolean {
  return id.startsWith(BUILTIN_ID_PREFIX);
}

/** Read-only templates shipped with the app, sorted by title. Never written to the user's store. */
export function loadBuiltinTemplates(dir = builtinDir): Template[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const templates: Template[] = [];
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort()) {
    const key = file.slice(0, -".json".length);
    const htmlPath = path.join(dir, `${key}.html`);
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as Record<string, unknown>;
      const parsed = normalizeTemplateInput({
        title: String(meta.title ?? ""),
        description: typeof meta.description === "string" ? meta.description : undefined,
        html: fs.readFileSync(htmlPath, "utf8"),
        fields: meta.fields,
        titleTemplate: typeof meta.titleTemplate === "string" ? meta.titleTemplate : undefined,
        initialState: meta.initialState as Template["initialState"],
        stateVersion: typeof meta.stateVersion === "number" ? meta.stateVersion : undefined,
        agentActions: meta.agentActions,
      });
      const guidePath = path.join(dir, `${key}.guide.md`);
      const guide = fs.existsSync(guidePath) ? fs.readFileSync(guidePath, "utf8").trim() : "";
      const mtime = Math.floor(fs.statSync(htmlPath).mtimeMs);
      templates.push({
        id: BUILTIN_ID_PREFIX + key,
        key,
        title: parsed.title,
        description: parsed.description,
        html: parsed.html,
        fields: parsed.fields,
        ...(parsed.titleTemplate ? { titleTemplate: parsed.titleTemplate } : {}),
        ...(parsed.initialState ? { initialState: parsed.initialState } : {}),
        stateVersion: parsed.stateVersion ?? 1,
        ...(guide ? { guide } : {}),
        ...(parsed.agentActions?.length ? { agentActions: parsed.agentActions } : {}),
        createdAt: mtime,
        updatedAt: mtime,
      });
    } catch (err) {
      throw new Error(`built-in template ${key}: ${(err as Error).message}`);
    }
  }
  return templates.sort((a, b) => a.title.localeCompare(b.title));
}
