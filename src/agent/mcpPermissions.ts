import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { dataDir } from "../config.js";
import { serversKey, type ResolvedMcpServer } from "./mcpConfig.js";
import type { ApprovalOption } from "./types.js";

export const mcpApprovalOptions: ApprovalOption[] = [
  { id: "whitelist", label: "Whitelist tool", description: "Always allow this tool for this MCP server, across threads.", kind: "allow_always" },
  { id: "mcp", label: "Allow MCP", description: "Allow every tool from this MCP server for this thread.", kind: "allow_always" },
  { id: "allow", label: "Allow", kind: "allow_once" },
  { id: "reject", label: "Deny", kind: "reject_once" },
];

type Grants = { tools: string[]; threads: Record<string, string[]> };
export class McpPermissions {
  constructor(private file = path.join(dataDir(), "agent", "mcp-permissions.json")) {}

  private read(): Grants {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (Array.isArray(value.tools) && value.tools.every((v: unknown) => typeof v === "string") && value.threads && typeof value.threads === "object" &&
        Object.values(value.threads).every((list) => Array.isArray(list) && list.every((v) => typeof v === "string"))) return value;
      throw new Error("Invalid MCP permissions file.");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return { tools: [], threads: {} };
  }

  private key(server: ResolvedMcpServer): string {
    return createHash("sha256").update(serversKey([{ ...server, approve: "ask" }])).digest("hex");
  }

  allows(server: ResolvedMcpServer, tool: string, thread?: string): boolean {
    const grants = this.read(), key = this.key(server);
    return grants.tools.includes(`${key}:${tool}`) || Boolean(thread && grants.threads[thread]?.includes(key));
  }

  grant(server: ResolvedMcpServer, tool: string, thread: string | undefined, option: string): boolean {
    if (option === "allow") return true;
    if (option !== "whitelist" && option !== "mcp") return false;
    if (option === "mcp" && !thread) return false;
    const grants = this.read(), key = this.key(server);
    const list = option === "whitelist" ? grants.tools : (grants.threads[thread!] ??= []);
    const entry = option === "whitelist" ? `${key}:${tool}` : key;
    if (!list.includes(entry)) list.push(entry);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(grants, null, 2) + "\n");
    fs.renameSync(`${this.file}.tmp`, this.file);
    return true;
  }
}
