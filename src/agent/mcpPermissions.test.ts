import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { McpPermissions, mcpApprovalOptions } from "./mcpPermissions.js";
import { resolveServer } from "./mcpConfig.js";

test("MCP grants persist with the requested tool and thread scopes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-mcp-permissions-"));
  try {
    const file = path.join(dir, "permissions.json");
    const permissions = new McpPermissions(file);
    const server = resolveServer("echo", "global", { command: "node", args: ["echo.js"] })!;
    assert.deepEqual(mcpApprovalOptions.map((o) => o.label), ["Whitelist tool", "Allow MCP", "Allow", "Deny"]);
    assert.equal(permissions.grant(server, "read", "a", "allow"), true);
    assert.equal(permissions.allows(server, "read", "a"), false);
    assert.equal(permissions.grant(server, "read", "a", "reject"), false);
    assert.equal(permissions.grant(server, "read", "a", "mcp"), true);
    const reopened = new McpPermissions(file);
    assert.equal(reopened.allows(server, "write", "a"), true);
    assert.equal(reopened.allows(server, "read", "b"), false);
    assert.equal(reopened.grant(server, "read", "a", "whitelist"), true);
    assert.equal(new McpPermissions(file).allows(server, "read", "b"), true);
    assert.equal(reopened.allows(server, "write", "b"), false);
    assert.equal(reopened.allows({ ...server, args: ["different.js"] }, "read", "a"), false);
    assert.equal(reopened.allows({ ...server, name: "other" }, "read", "a"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
