/**
 * How big Scribe's MCP tool list is, per tool: what a client that loads every schema pays on each
 * model call. Starts the MCP server from src over stdio as a Scribe chat would (SCRIBE_THREAD set).
 *
 *   npx tsx tools/measure-mcp-tools.ts [provider] [--pages-off] [--json]
 *
 * Tokens are estimated at 2.8 characters each (close to Claude's /context count for these schemas).
 * The server only checks the daemon's health when its version matches; a different version would
 * replace the running daemon, so this refuses to start then.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PORT, VERSION } from "../src/config.js";

const args = process.argv.slice(2);
const provider = args.find((a) => !a.startsWith("--")) ?? "claude";
const CHARS_PER_TOKEN = 2.8;

const health = await fetch(`http://127.0.0.1:${PORT}/api/health`).then((r) => r.json() as Promise<{ version?: string }>).catch(() => null);
if (!health || health.version !== VERSION) {
  console.error(`Daemon ${health?.version ?? "not running"} != source ${VERSION}: starting the MCP server would replace or start a daemon.`);
  process.exit(1);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", "src/index.ts"],
  env: {
    ...(process.env as Record<string, string>),
    SCRIBE_THREAD: "measure-mcp-tools",
    SCRIBE_PROVIDER: provider,
    ...(args.includes("--pages-off") ? { SCRIBE_PAGES: "off" } : {}),
  },
  stderr: "ignore",
});
const client = new Client({ name: "measure-mcp-tools", version: "1" });
await client.connect(transport);
const { tools } = await client.listTools();
const instructions = client.getInstructions() ?? "";
await client.close();

const rows = tools
  .map((t) => {
    const chars = JSON.stringify({ name: t.name, description: t.description, input_schema: t.inputSchema }).length;
    return { name: t.name, chars, tokens: Math.round(chars / CHARS_PER_TOKEN) };
  })
  .sort((a, b) => b.chars - a.chars);
const total = rows.reduce((sum, r) => sum + r.chars, 0);

if (args.includes("--json")) {
  console.log(JSON.stringify({ provider, tools: rows, totalChars: total, instructionChars: instructions.length }, null, 2));
} else {
  for (const r of rows) console.log(`${r.name.padEnd(22)} ${String(r.chars).padStart(6)}  ~${r.tokens}`);
  console.log(`${tools.length} tools: ${total} chars, ~${Math.round(total / CHARS_PER_TOKEN)} tokens; instructions ${instructions.length} chars, ~${Math.round(instructions.length / CHARS_PER_TOKEN)} tokens`);
}
