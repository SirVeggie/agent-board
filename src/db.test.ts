import assert from "node:assert/strict";
import { test } from "node:test";
import { isTransientOpenError } from "./db.js";

test("isTransientOpenError retries busy, locked and I/O errors only", () => {
  const sqliteError = (errcode: number, message: string) => Object.assign(new Error(message), { errcode });
  assert.equal(isTransientOpenError(sqliteError(10, "disk I/O error")), true);
  assert.equal(isTransientOpenError(sqliteError(5, "database is locked")), true);
  assert.equal(isTransientOpenError(sqliteError(6, "database table is locked")), true);
  assert.equal(isTransientOpenError(sqliteError(10 | (13 << 8), "disk I/O error")), true);
  assert.equal(isTransientOpenError(sqliteError(1, "near \"bogus\": syntax error")), false);
  assert.equal(isTransientOpenError(sqliteError(11, "database disk image is malformed")), false);
  assert.equal(isTransientOpenError(new Error("disk I/O error")), true);
  assert.equal(isTransientOpenError(new Error("scribe.sqlite is missing a schema version")), false);
});
