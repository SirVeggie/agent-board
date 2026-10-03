import assert from "node:assert/strict";
import { test } from "node:test";
import { RpcError } from "./providers/acp.js";
import { isRetriable } from "./providers/cursor.js";

test("isRetriable spots Cursor's transient stream errors", () => {
  assert.equal(isRetriable(new RpcError("RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)", -32603)), true);
  assert.equal(isRetriable(new RpcError("Internal error", -32603, { message: "RetriableError: [unavailable] ..." })), true);
  assert.equal(isRetriable(new RpcError("Invalid params", -32602)), false);
  assert.equal(isRetriable(new Error("RetriableError: not from the server")), false);
});
