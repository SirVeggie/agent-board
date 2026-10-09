import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { cursorAccessToken, cursorStateDbPath, readCursorStateToken } from "./providers/cursorAuth.js";

function stateDb(rows: [string, string | Uint8Array][]): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cursor-auth-")), "state.vscdb");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)");
  for (const [key, value] of rows) db.prepare("INSERT INTO ItemTable VALUES (?, ?)").run(key, value);
  db.close();
  return file;
}

test("Cursor state db path follows each platform's app data folder", () => {
  assert.equal(cursorStateDbPath("win32", { APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "C:\\Users\\u"), path.join("C:\\Users\\u\\AppData\\Roaming", "Cursor", "User", "globalStorage", "state.vscdb"));
  assert.equal(cursorStateDbPath("darwin", {}, "/Users/u"), path.join("/Users/u", "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb"));
  assert.equal(cursorStateDbPath("linux", {}, "/home/u"), path.join("/home/u", ".config", "Cursor", "User", "globalStorage", "state.vscdb"));
});

test("Cursor token is read from the app's state db as text, blob or JSON string", () => {
  assert.equal(readCursorStateToken(stateDb([["cursorAuth/accessToken", "tok-a"]])), "tok-a");
  assert.equal(readCursorStateToken(stateDb([["cursorAuth/accessToken", new TextEncoder().encode("tok-b")]])), "tok-b");
  assert.equal(readCursorStateToken(stateDb([["cursorAuth/accessToken", '"tok-c"']])), "tok-c");
  assert.equal(readCursorStateToken(stateDb([["other", "x"]])), null);
  assert.equal(readCursorStateToken(path.join(os.tmpdir(), "no-such-cursor", "state.vscdb")), null);
});

test("CURSOR_ACCESS_TOKEN wins over the app's stored login", () => {
  const db = stateDb([["cursorAuth/accessToken", "from-app"]]);
  assert.deepEqual(cursorAccessToken({ CURSOR_ACCESS_TOKEN: " from-env " }, db), { token: "from-env", source: "env" });
  assert.deepEqual(cursorAccessToken({}, db), { token: "from-app", source: "app" });
  assert.equal(cursorAccessToken({}, path.join(os.tmpdir(), "no-such-cursor", "state.vscdb")), null);
});
