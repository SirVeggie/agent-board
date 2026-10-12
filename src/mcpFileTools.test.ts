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

test("Scribe's own tools ask the hooks first on Codex and Cursor, and only there", async () => {
  const { gateTools } = await import("./mcp.js");
  const { z } = await import("zod");
  for (const provider of ["codex", "cursor", "claude", "pi"]) {
    const asked: Array<[string, unknown]> = [];
    let ran = 0;
    const server = new McpServer({ name: "scribe", version: "1" }, { capabilities: { tools: {} } });
    gateTools(server, { SCRIBE_PROVIDER: provider, SCRIBE_THREAD: "thread-one" }, async (tool, input) => {
      asked.push([tool, input]);
      return tool === "page_delete" ? "Blocked by a hook." : null;
    });
    for (const name of ["page_show", "page_delete"]) {
      server.tool(name, "A page tool", { key: z.string() }, async () => {
        ran++;
        return { content: [{ type: "text" as const, text: "ok" }] };
      });
    }
    server.tool("page_list", "No parameters", async () => ({ content: [{ type: "text" as const, text: "list" }] }));
    const client = new Client({ name: "test", version: "1" });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const held = provider === "codex" || provider === "cursor";
      const shown = await client.callTool({ name: "page_show", arguments: { key: "a" } });
      const deleted = await client.callTool({ name: "page_delete", arguments: { key: "a" } });
      const listed = await client.callTool({ name: "page_list", arguments: {} });
      assert.equal(shown.isError ?? false, false);
      assert.deepEqual(listed.content, [{ type: "text", text: "list" }]);
      assert.equal(deleted.isError ?? false, held);
      if (held) assert.deepEqual(deleted.content, [{ type: "text", text: "Blocked by a hook." }]);
      assert.equal(ran, held ? 1 : 2);
      assert.deepEqual(asked, held ? [["page_show", { key: "a" }], ["page_delete", { key: "a" }], ["page_list", undefined]] : []);
    } finally { await client.close(); await server.close(); }
  }
});
