import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerCodexFileTools } from "./mcp.js";

test("only Codex thread MCP servers register scoped read/list/grep tools", async () => {
  for (const provider of ["codex", "claude", "cursor", "pi", undefined]) {
    for (const thread of ["thread-one", undefined]) {
      const server = new McpServer({ name: "scribe", version: "1" }, { capabilities: { tools: {} } });
      server.tool("sentinel", "An unrelated Scribe tool", async () => ({ content: [] }));
      const client = new Client({ name: "test", version: "1" });
      registerCodexFileTools(server, { SCRIBE_PROVIDER: provider, SCRIBE_THREAD: thread, SCRIBE_PAGES: "off" });
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const tools = (await client.listTools()).tools.filter(t => t.name !== "sentinel");
        assert.deepEqual(tools.map(t => t.name).sort(), provider === "codex" && thread ? ["grep_files", "list_files", "read_file"] : []);
        for (const tool of tools) assert.equal(tool.annotations?.readOnlyHint, true);
      } finally { await client.close(); await server.close(); }
    }
  }
});
