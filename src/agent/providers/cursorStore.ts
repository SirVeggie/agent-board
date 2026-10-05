import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { DatabaseSync } from "node:sqlite";
import type {
  LocalAgentDocument,
  LocalAgentRunDocument,
  LocalAgentRunEventDocument,
  LocalAgentStore,
  LocalAgentStoreAgents,
  LocalAgentStoreCheckpoints,
  LocalAgentStoreRunEvents,
  LocalAgentStoreRuns,
} from "@cursor/sdk";
import { log } from "../../log.js";

/** The SDK's list paging, passed in so this module does not load the SDK itself. */
export type Paging = Pick<typeof import("@cursor/sdk"), "paginateAgentDocuments" | "paginateRunDocuments" | "paginateCheckpointBlobIds">;

const CREATE_SQL = `
CREATE TABLE IF NOT EXISTS agents (agent_id TEXT PRIMARY KEY, cwd TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs (
  agent_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (agent_id, run_id)
);
CREATE INDEX IF NOT EXISTS idx_runs_run ON runs(run_id);
CREATE TABLE IF NOT EXISTS run_events (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT,
  payload_ref TEXT,
  idempotency_key TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_run_events_key ON run_events(run_id, idempotency_key);
CREATE TABLE IF NOT EXISTS checkpoints (
  agent_id TEXT NOT NULL,
  blob_id TEXT NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (agent_id, blob_id)
);
`;

/** The files JsonlLocalAgentStore kept; imported once, then renamed out of the way. */
const JSONL = { agents: "agents.ndjson", runs: "runs.ndjson", runEvents: "run_events.ndjson", checkpoints: "checkpoints.ndjson" };

type Row = Record<string, unknown>;

/** `?, ?, ?` for an IN list. */
const marks = (n: number) => Array(n).fill("?").join(", ");

/**
 * Scribe's Cursor agent store, in SQLite. The SDK's JsonlLocalAgentStore reads, parses and
 * rewrites a whole file on every write, behind one queue for the process: with a few hundred MB
 * of checkpoints every streamed event and checkpoint waited on that, and turns sat silent for
 * minutes (#212). Here each write touches its own rows.
 */
export class SqliteCursorStore implements LocalAgentStore {
  readonly agents: LocalAgentStoreAgents;
  readonly runs: LocalAgentStoreRuns;
  readonly runEvents: LocalAgentStoreRunEvents;
  readonly checkpoints: LocalAgentStoreCheckpoints;
  private db: DatabaseSync;

  constructor(file: string, paging: Paging) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    this.db = db;
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    db.exec(CREATE_SQL);

    const agentRows = (agentIds: readonly string[] | undefined, cwd: string | undefined): Array<{ agent_id: string; data: string }> => {
      const where: string[] = [];
      const args: string[] = [];
      if (agentIds?.length) {
        where.push(`agent_id IN (${marks(agentIds.length)})`);
        args.push(...agentIds);
      }
      if (cwd !== undefined) {
        where.push("cwd = ?");
        args.push(cwd);
      }
      return db.prepare(`SELECT agent_id, data FROM agents${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`).all(...args) as Array<{ agent_id: string; data: string }>;
    };
    this.agents = {
      async get({ agentId }) {
        const row = db.prepare("SELECT data FROM agents WHERE agent_id = ?").get(agentId) as { data: string } | undefined;
        return row ? (JSON.parse(row.data) as LocalAgentDocument) : null;
      },
      async create({ agent }) {
        const done = db.prepare("INSERT OR IGNORE INTO agents (agent_id, cwd, data) VALUES (?, ?, ?)").run(agent.agentId, agent.cwd, JSON.stringify(agent));
        if (!done.changes) throw new Error(`Agent ${agent.agentId} already exists`);
        return JSON.parse(JSON.stringify(agent)) as LocalAgentDocument;
      },
      async update({ agent }) {
        const done = db.prepare("UPDATE agents SET cwd = ?, data = ? WHERE agent_id = ?").run(agent.cwd, JSON.stringify(agent), agent.agentId);
        if (!done.changes) throw new Error(`Agent ${agent.agentId} not found`);
        return JSON.parse(JSON.stringify(agent)) as LocalAgentDocument;
      },
      async delete({ filter }) {
        const ids = agentRows(filter.agentIds, filter.cwd).map((r) => r.agent_id);
        if (!ids.length) throw new Error("No agents matched delete filter");
        db.prepare(`DELETE FROM agents WHERE agent_id IN (${marks(ids.length)})`).run(...ids);
      },
      async list(input) {
        const filter = input?.filter;
        const items = agentRows(undefined, filter?.cwd).map((r) => JSON.parse(r.data) as LocalAgentDocument);
        return paging.paginateAgentDocuments(items, filter);
      },
    };

    const runRows = (agentIds: readonly string[] | undefined, runIds: readonly string[] | undefined): LocalAgentRunDocument[] => {
      const where: string[] = [];
      const args: string[] = [];
      if (agentIds?.length) {
        where.push(`agent_id IN (${marks(agentIds.length)})`);
        args.push(...agentIds);
      }
      if (runIds?.length) {
        where.push(`run_id IN (${marks(runIds.length)})`);
        args.push(...runIds);
      }
      const rows = db.prepare(`SELECT data FROM runs${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`).all(...args) as Array<{ data: string }>;
      return rows.map((r) => JSON.parse(r.data) as LocalAgentRunDocument);
    };
    const deleteEvents = (runIds: readonly string[] | undefined) => {
      if (runIds?.length) db.prepare(`DELETE FROM run_events WHERE run_id IN (${marks(runIds.length)})`).run(...runIds);
      else db.prepare("DELETE FROM run_events").run();
    };
    this.runs = {
      async get({ agentId, runId }) {
        const row = db.prepare("SELECT data FROM runs WHERE agent_id = ? AND run_id = ?").get(agentId, runId) as { data: string } | undefined;
        return row ? (JSON.parse(row.data) as LocalAgentRunDocument) : null;
      },
      async create({ run }) {
        const done = db.prepare("INSERT OR IGNORE INTO runs (agent_id, run_id, data) VALUES (?, ?, ?)").run(run.agentId, run.runId, JSON.stringify(run));
        if (!done.changes) throw new Error(`Run ${run.runId} already exists for agent ${run.agentId}`);
        return JSON.parse(JSON.stringify(run)) as LocalAgentRunDocument;
      },
      async update({ run }) {
        const done = db.prepare("UPDATE runs SET data = ? WHERE agent_id = ? AND run_id = ?").run(JSON.stringify(run), run.agentId, run.runId);
        if (!done.changes) throw new Error(`Run ${run.runId} not found for agent ${run.agentId}`);
        return JSON.parse(JSON.stringify(run)) as LocalAgentRunDocument;
      },
      async delete({ filter }) {
        const runs = runRows(filter.agentIds, filter.runIds);
        if (!runs.length) return;
        const del = db.prepare("DELETE FROM runs WHERE agent_id = ? AND run_id = ?");
        for (const run of runs) del.run(run.agentId, run.runId);
        deleteEvents(runs.map((r) => r.runId));
      },
      async list(input) {
        const filter = input?.filter;
        return paging.paginateRunDocuments(runRows(filter?.agentIds, filter?.runIds), filter);
      },
    };

    const toEvent = (row: Row): LocalAgentRunEventDocument => ({
      runId: row.run_id as string,
      seq: Number(row.seq),
      offset: String(row.seq),
      eventType: row.event_type as string,
      payload: row.payload == null ? null : JSON.parse(row.payload as string),
      payloadRef: (row.payload_ref as string | null) ?? null,
      idempotencyKey: (row.idempotency_key as string | null) ?? null,
      createdAt: Number(row.created_at),
    });
    this.runEvents = {
      async append({ runId, eventType, payload, payloadRef, idempotencyKey }) {
        if (idempotencyKey) {
          const seen = db.prepare("SELECT * FROM run_events WHERE run_id = ? AND idempotency_key = ?").get(runId, idempotencyKey) as Row | undefined;
          if (seen) return toEvent(seen);
        }
        const last = db.prepare("SELECT MAX(seq) AS seq FROM run_events WHERE run_id = ?").get(runId) as { seq: number | null };
        const row: Row = {
          run_id: runId,
          seq: (last.seq ?? 0) + 1,
          event_type: eventType,
          payload: payload === undefined || payload === null ? null : JSON.stringify(payload),
          payload_ref: payloadRef ?? null,
          idempotency_key: idempotencyKey ?? null,
          created_at: Date.now(),
        };
        db.prepare("INSERT INTO run_events (run_id, seq, event_type, payload, payload_ref, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
          row.run_id as string,
          row.seq as number,
          row.event_type as string,
          row.payload as string | null,
          row.payload_ref as string | null,
          row.idempotency_key as string | null,
          row.created_at as number
        );
        return toEvent(row);
      },
      async list({ runId, afterOffset, limit }) {
        const after = Number.parseInt(afterOffset ?? "0", 10) || 0;
        const max = limit ?? 100;
        const rows = db.prepare("SELECT * FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?").all(runId, after, max + 1) as Row[];
        const items = rows.slice(0, max).map(toEvent);
        return { items, ...(rows.length > items.length && items.length ? { nextOffset: items.at(-1)!.offset } : {}) };
      },
      async delete({ filter }) {
        deleteEvents(filter.runIds);
      },
    };

    const checkpointWhere = (agentIds: readonly string[] | undefined, blobIds: readonly string[] | undefined): [string, string[]] => {
      const where: string[] = [];
      const args: string[] = [];
      if (agentIds?.length) {
        where.push(`agent_id IN (${marks(agentIds.length)})`);
        args.push(...agentIds);
      }
      if (blobIds?.length) {
        where.push(`blob_id IN (${marks(blobIds.length)})`);
        args.push(...blobIds);
      }
      return [where.length ? ` WHERE ${where.join(" AND ")}` : "", args];
    };
    this.checkpoints = {
      async get({ agentId, blobId }) {
        const row = db.prepare("SELECT data FROM checkpoints WHERE agent_id = ? AND blob_id = ?").get(agentId, blobId) as { data: Uint8Array } | undefined;
        return row ? Buffer.from(row.data) : null;
      },
      async create({ agentId, blobId, data }) {
        const done = db.prepare("INSERT OR IGNORE INTO checkpoints (agent_id, blob_id, data) VALUES (?, ?, ?)").run(agentId, blobId, data);
        if (!done.changes) throw new Error(`Checkpoint blob ${blobId} already exists for agent ${agentId}`);
      },
      async update({ agentId, blobId, data }) {
        const done = db.prepare("UPDATE checkpoints SET data = ? WHERE agent_id = ? AND blob_id = ?").run(data, agentId, blobId);
        if (!done.changes) throw new Error(`Checkpoint blob ${blobId} not found for agent ${agentId}`);
      },
      async delete({ filter }) {
        const [where, args] = checkpointWhere(filter.agentIds, filter.blobIds);
        db.prepare(`DELETE FROM checkpoints${where}`).run(...args);
      },
      async list(input) {
        const filter = input?.filter;
        const [where, args] = checkpointWhere(filter?.agentIds, filter?.blobIds);
        const ids = (db.prepare(`SELECT blob_id FROM checkpoints${where}`).all(...args) as Array<{ blob_id: string }>).map((r) => r.blob_id);
        return paging.paginateCheckpointBlobIds(ids, filter);
      },
    };
  }

  /**
   * Bring in what an earlier JsonlLocalAgentStore left in dir, a line at a time (the checkpoints
   * file runs to hundreds of MB), then rename each file to *.imported so it is not read again.
   */
  async importJsonl(dir: string): Promise<void> {
    const db = this.db;
    const insert = {
      agents: db.prepare("INSERT OR IGNORE INTO agents (agent_id, cwd, data) VALUES (?, ?, ?)"),
      runs: db.prepare("INSERT OR IGNORE INTO runs (agent_id, run_id, data) VALUES (?, ?, ?)"),
      runEvents: db.prepare(
        "INSERT OR IGNORE INTO run_events (run_id, seq, event_type, payload, payload_ref, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ),
      checkpoints: db.prepare("INSERT OR IGNORE INTO checkpoints (agent_id, blob_id, data) VALUES (?, ?, ?)"),
    };
    const add: Record<keyof typeof JSONL, (r: Row) => void> = {
      agents: (r) => insert.agents.run(String(r.agentId), String(r.cwd ?? ""), JSON.stringify(r)),
      runs: (r) => insert.runs.run(String(r.agentId), String(r.runId), JSON.stringify(r)),
      runEvents: (r) =>
        insert.runEvents.run(
          String(r.runId),
          Number(r.seq),
          String(r.eventType),
          r.payload === undefined || r.payload === null ? null : JSON.stringify(r.payload),
          (r.payloadRef as string | null) ?? null,
          (r.idempotencyKey as string | null) ?? null,
          typeof r.createdAt === "number" ? r.createdAt : Date.parse(String(r.createdAt)) || Date.now()
        ),
      checkpoints: (r) => insert.checkpoints.run(String(r.agentId), String(r.blobId), Buffer.from(String(r.dataBase64), "base64")),
    };
    for (const kind of Object.keys(JSONL) as Array<keyof typeof JSONL>) {
      const file = path.join(dir, JSONL[kind]);
      if (!fs.existsSync(file)) continue;
      const started = Date.now();
      let count = 0;
      db.exec("BEGIN");
      try {
        const lines = readline.createInterface({ input: fs.createReadStream(file, "utf8"), crlfDelay: Infinity });
        for await (const line of lines) {
          if (!line.trim()) continue;
          let row: Row;
          try {
            row = JSON.parse(line) as Row;
          } catch {
            continue; // a torn last line from a crash mid-write
          }
          add[kind](row);
          count++;
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      fs.renameSync(file, `${file}.imported`);
      log(`Cursor store: imported ${count} ${kind} from ${JSONL[kind]} in ${Date.now() - started} ms`);
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }
}
