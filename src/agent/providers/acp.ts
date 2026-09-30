import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { log } from "../../log.js";

/** Minimal JSON-RPC 2.0 over newline-delimited stdio, as the Agent Client Protocol uses. */

type Pending = { resolve: (value: unknown) => void; reject: (err: Error) => void; method: string };

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown
  ) {
    super(message);
  }
}

export type RequestHandler = (method: string, params: unknown) => Promise<unknown>;
export type NotificationHandler = (method: string, params: unknown) => void;

export class AcpConnection {
  private child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private stderrTail: string[] = [];
  private exited = false;
  onRequest: RequestHandler = async (method) => {
    throw new RpcError(`Method not found: ${method}`, -32601);
  };
  onNotification: NotificationHandler = () => {};
  onExit: (code: number | null) => void = () => {};

  constructor(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }) {
    this.child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrTail.push(chunk);
      if (this.stderrTail.length > 40) {
        this.stderrTail.shift();
      }
    });
    this.child.on("error", (err) => {
      log(`ACP process error: ${err.message}`);
      this.fail(err);
    });
    this.child.on("exit", (code) => {
      this.exited = true;
      this.fail(new Error(`Agent process exited (${code ?? "signal"}). ${this.stderr().slice(-600)}`));
      this.onExit(code);
    });
  }

  get alive(): boolean {
    return !this.exited;
  }

  stderr(): string {
    return this.stderrTail.join("");
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = 0): Promise<T> {
    if (this.exited) {
      return Promise.reject(new Error("Agent process is not running"));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`${method} timed out`));
        }, timeoutMs);
      }
      this.pending.set(id, {
        method,
        resolve: (value) => {
          if (timer) clearTimeout(timer);
          resolve(value as T);
        },
        reject: (err) => {
          if (timer) clearTimeout(timer);
          reject(err);
        },
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  kill(): void {
    if (!this.exited) {
      try {
        this.child.stdin.end();
      } catch {
        /* ignore */
      }
      this.child.kill();
    }
  }

  private write(message: unknown): void {
    if (this.exited) {
      return;
    }
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  private fail(err: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(err);
    }
    this.pending.clear();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let msg: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.method && msg.id !== undefined) {
        void this.handleRequest(msg.id, msg.method, msg.params);
      } else if (msg.method) {
        try {
          this.onNotification(msg.method, msg.params);
        } catch (err) {
          log(`ACP notification handler failed: ${(err as Error).stack || err}`);
        }
      } else if (msg.id !== undefined) {
        const pending = this.pending.get(Number(msg.id));
        if (!pending) continue;
        this.pending.delete(Number(msg.id));
        if (msg.error) {
          const detail = (msg.error.data as { message?: string } | undefined)?.message;
          pending.reject(new RpcError(detail ? `${msg.error.message}: ${detail}` : msg.error.message, msg.error.code, msg.error.data));
        } else {
          pending.resolve(msg.result);
        }
      }
    }
  }

  private async handleRequest(id: number | string, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.onRequest(method, params);
      this.write({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (err) {
      const code = err instanceof RpcError ? err.code : -32603;
      this.write({ jsonrpc: "2.0", id, error: { code, message: (err as Error).message } });
    }
  }
}
