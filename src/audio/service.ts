import type { OpenAISource } from "../agent/openaiSources.js";
import { openAiEngine } from "./engine.js";
import { fileStore, normalizeSettings, type AudioStore } from "./settings.js";
import type { AudioResult, SttEngine } from "./types.js";

export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
export class AudioService {
  private store: AudioStore;
  private engine: SttEngine;
  private sources: () => OpenAISource[];
  private timeoutMs: number;
  constructor(options: { sources: () => OpenAISource[]; store?: AudioStore; engine?: SttEngine; timeoutMs?: number }) {
    this.store = options.store ?? fileStore(); this.engine = options.engine ?? openAiEngine;
    this.sources = options.sources; this.timeoutMs = options.timeoutMs ?? 60_000;
  }
  view() {
    const settings = this.store.read();
    const sources = this.sources().map(({ id, name }) => ({ id, name }));
    return { ...settings, sources, available: sources.some(s => s.id === settings.stt.source), usage: this.usage() };
  }
  update(value: unknown) {
    const body = value as { stt?: object; input?: object } | null;
    const old = this.store.read();
    const next = normalizeSettings({ stt: { ...old.stt, ...body?.stt }, input: { ...old.input, ...body?.input } });
    if (next.stt.source && !this.sources().some(s => s.id === next.stt.source)) throw new Error("Choose an existing OpenAI source.");
    this.store.write(next); return this.view();
  }
  usage() {
    const day = new Date().toISOString().slice(0, 10), saved = this.store.readUsage();
    return saved?.day === day ? saved : { day, calls: 0, failed: 0, bytes: 0 };
  }
  async transcribe(audio: Blob, options: { language?: string; prompt?: string } = {}): Promise<AudioResult> {
    try {
      if (!audio.size || !audio.type.startsWith("audio/")) return { ok: false, error: "invalid_audio", message: "Record or upload an audio clip." };
      if (audio.size > MAX_AUDIO_BYTES) return { ok: false, error: "too_large", message: "Audio must be under 25 MB." };
      const settings = this.store.read(), source = this.sources().find(s => s.id === settings.stt.source);
      if (!source) return { ok: false, error: "no_source", message: "Choose a speech-to-text source in Settings → Audio." };
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<AudioResult>(resolve => { timer = setTimeout(() => {
        controller.abort(); resolve({ ok: false, error: "timeout", message: "Speech-to-text timed out. Try a shorter recording." });
      }, this.timeoutMs); });
      const run = async (): Promise<AudioResult> => {
        for (let attempt = 0; ; attempt++) {
          const result = await this.engine.transcribe({ source, model: settings.stt.model, audio,
            language: options.language || settings.stt.language, prompt: options.prompt, signal: controller.signal });
          if (attempt || result.ok || controller.signal.aborted || !(result.error === "rate_limit" || result.retryable)) return result;
          await new Promise(resolve => setTimeout(resolve, 300));
          if (controller.signal.aborted) return { ok: false, error: "timeout", message: "Speech-to-text timed out." };
        }
      };
      let result: AudioResult;
      try { result = await Promise.race([run(), timeout]); }
      catch { result = { ok: false, error: controller.signal.aborted ? "timeout" : "network", message: controller.signal.aborted ? "Speech-to-text timed out." : "Cannot reach the speech-to-text source." }; }
      finally { clearTimeout(timer); }
      const usage = this.usage(); usage.calls++; usage.bytes += audio.size; if (!result.ok) usage.failed++;
      this.store.writeUsage(usage);
      return result;
    } catch { return { ok: false, error: "engine", message: "Speech-to-text is unavailable." }; }
  }
}
