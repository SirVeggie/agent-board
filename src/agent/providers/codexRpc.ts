import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { isPlainRecord } from "../types.js";

export type RpcRecord = Record<string, unknown>;
export type RpcMessage = { id?: string | number; method?: string; params?: RpcRecord; result?: unknown; error?: { message?: string } };

/** Bidirectional JSONL transport. Server requests must not block response/notification reading. */
export class CodexRpc {
  private nextId = 1;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private buffer = "";
  private decoder = new StringDecoder("utf8");
  private closed = false;
  private stderr = "";

  constructor(
    private child: ChildProcess,
    private onMessage: (message: RpcMessage) => void,
    private onClose: (error: Error) => void,
  ) {
    child.stdout?.on("data", (chunk: Buffer) => this.read(this.decoder.write(chunk)));
    child.stderr?.on("data", (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString("utf8")).slice(-4000); });
    child.once("error", (error) => this.fail(error));
    child.once("exit", (code) => this.fail(new Error(`Codex app-server exited (${code ?? "signal"})${this.stderr.trim() ? `: ${this.stderr.trim()}` : ""}`)));
    child.stdin?.on("error", (error) => this.fail(error));
  }

  static launch(cli: string, env: Record<string, string>, onMessage: (message: RpcMessage) => void, onClose: (error: Error) => void): CodexRpc {
    return new CodexRpc(spawn(process.execPath, [cli, "app-server", "--stdio"], {
      env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    }), onMessage, onClose);
  }

  get alive(): boolean { return !this.closed; }

  private read(text: string): void {
    this.buffer += text;
    let end: number;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      let value: unknown;
      try { value = JSON.parse(line); } catch { this.fail(new Error("Invalid JSON from Codex app-server")); return; }
      if (!isPlainRecord(value)) continue;
      const message = value as RpcMessage;
      if (message.method) {
        this.onMessage(message);
      } else if (typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message || "Codex RPC failed"));
        else pending.resolve(message.result);
      }
    }
  }

  private write(message: unknown): void {
    if (this.closed || !this.child.stdin?.writable) throw new Error("Codex app-server is closed");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  call(method: string, params: unknown = {}, timeoutMs = 30_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Codex app-server is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A timed-out mutation may already have happened. Close instead of silently retrying it.
        this.fail(new Error(`Codex ${method} timed out`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (error) { this.fail(error as Error); }
    });
  }

  notify(method: string, params?: unknown): void { this.write({ method, ...(params === undefined ? {} : { params }) }); }
  reply(id: string | number, result: unknown): void { if (!this.closed) this.write({ id, result }); }
  reject(id: string | number, message: string): void { if (!this.closed) this.write({ id, error: { code: -32601, message } }); }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    if (process.platform === "win32" && this.child.pid && this.child.exitCode == null) {
      spawnSync("taskkill", ["/pid", String(this.child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else this.child.kill();
    this.onClose(error);
  }

  close(): void { this.fail(new Error("Codex app-server closed")); }
}
