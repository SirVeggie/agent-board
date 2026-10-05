import type { Prefs } from "./prefs.js";
import { sourceProviderId } from "./providers/pi.js";
import type { Thread } from "./types.js";

/**
 * The OpenAI-compatible provider ("openai") was removed in #192: its model sources run through Pi.
 * See docs/migrations.md. Remove this file once no install has "openai" threads or prefs left.
 */

/** "<source id>/<model>" (the old provider's ids) → Pi's "src-<source id>/<model>". */
function piModelId(model: string): string {
  const at = model.indexOf("/");
  return at > 0 ? `${sourceProviderId(model.slice(0, at))}${model.slice(at)}` : model;
}

/** Moves an "openai" thread to Pi, in a new session (Pi cannot read the old provider's history). Returns whether it changed. */
export function migrateOpenaiThread(thread: Thread): boolean {
  if ((thread.provider as string) !== "openai") return false;
  thread.provider = "pi";
  thread.model = piModelId(thread.model);
  thread.nativeId = null;
  return true;
}

/** Saved prefs with every "openai" provider and model moved to Pi. */
export function migrateOpenaiPrefs(saved: Partial<Prefs>): Partial<Prefs> {
  const out = { ...saved };
  if ((out.provider as string) === "openai") out.provider = "pi";
  const models = out.models as Record<string, string> | undefined;
  if (models && "openai" in models) {
    const { openai, ...rest } = models;
    out.models = { ...rest, pi: rest.pi ?? piModelId(openai) };
  }
  if (out.summarizer && (out.summarizer.provider as string) === "openai") out.summarizer = { provider: "pi", model: piModelId(out.summarizer.model) };
  if (Array.isArray(out.favoriteModels)) out.favoriteModels = out.favoriteModels.map((f) => (f.startsWith("openai:") ? `pi:${piModelId(f.slice(7))}` : f));
  return out;
}
