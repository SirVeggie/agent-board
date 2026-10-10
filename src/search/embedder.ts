import { fork, type ChildProcess, type ForkOptions } from "node:child_process";
import { dataDir } from "../config.js";
import { detectSearchPack, searchEnabled } from "./pack.js";

export type EmbedDocument = { title?: string; text: string };
export interface Embedder {
  embedQuery(text: string): Promise<Float32Array>;
  embedDocuments(items: EmbedDocument[]): Promise<Float32Array[]>;
  embedImage(bytes: Uint8Array): Promise<Float32Array>;
}
type Pending = { resolve: (vectors: Float32Array[]) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
export class SearchEmbedder implements Embedder {
  private child: ChildProcess | null = null;
  private pending = new Map<number, Pending>();
  private idle: NodeJS.Timeout | null = null;
  private nextId = 0;
  private disposed = false;
  constructor(private options: { root?: string; idleMs?: number; requestMs?: number; childUrl?: URL } = {}) {}
  get running(): boolean { return this.child !== null; }
  embedQuery(text: string): Promise<Float32Array> { return this.request("embedQuery", text).then(v => v[0]); }
  embedDocuments(items: EmbedDocument[]): Promise<Float32Array[]> {
    return items.length ? this.request("embedDocuments", items) : Promise.resolve([]);
  }
  embedImage(bytes: Uint8Array): Promise<Float32Array> { return this.request("embedImage", bytes).then(v => v[0]); }
  private request(method: string, input: unknown): Promise<Float32Array[]> {
    if (this.disposed) return Promise.reject(new Error("Search embedder is disposed"));
    const root = this.options.root ?? dataDir();
    if (!searchEnabled(root)) return Promise.reject(new Error("Semantic search is off"));
    if (!this.child) {
      const status = detectSearchPack(root);
      if (status.status !== "ready") return Promise.reject(new Error(status.message));
      try {
        // In development use the TS source and inherited tsx loader; builds fork the compiled JS.
        const childUrl = this.options.childUrl ?? new URL(import.meta.url.endsWith(".ts") ? "./embedderChild.ts" : "./embedderChild.js", import.meta.url);
        const options: ForkOptions & { windowsHide: boolean } = {
          serialization: "advanced", windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
        };
        const child = fork(childUrl, [status.folder], options);
        this.child = child;
        child.on("message", (raw: unknown) => {
          const msg = raw as { id: number; vectors?: Float32Array[]; error?: string };
          const pending = this.pending.get(msg.id);
          if (!pending || this.child !== child) return;
          this.pending.delete(msg.id); clearTimeout(pending.timer);
          if (msg.error) pending.reject(new Error(msg.error));
          else if (!Array.isArray(msg.vectors) || msg.vectors.some(v => !(v instanceof Float32Array))) pending.reject(new Error("Invalid embedder response"));
          else pending.resolve(msg.vectors);
          this.armIdle();
        });
        child.on("error", err => { if (this.child === child) this.stop(err); });
        child.on("exit", (code, signal) => { if (this.child === child) this.stop(new Error(`Search embedder exited (${signal ?? code})`)); });
      } catch (err) { return Promise.reject(err); }
    }
    if (this.idle) clearTimeout(this.idle);
    const child = this.child;
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.stop(new Error("Search embedding timed out")), this.options.requestMs ?? 10 * 60_000);
      this.pending.set(id, { resolve, reject, timer });
      child.send({ id, method, input }, err => { if (err && this.child === child) this.stop(err); });
    });
  }
  private armIdle(): void {
    if (this.idle) clearTimeout(this.idle);
    if (!this.pending.size && this.child) {
      this.idle = setTimeout(() => this.stop(), this.options.idleMs ?? 10 * 60_000);
      this.idle.unref();
    }
  }
  /** Stops immediately on disable/shutdown, and can restart on the next enabled request. */
  stop(error = new Error("Search embedder stopped")): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const child = this.child; this.child = null;
    child?.kill();
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
  }
  dispose(): void { this.disposed = true; this.stop(); }
}
export const searchEmbedder = new SearchEmbedder();
