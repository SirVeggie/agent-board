/** Configuration-only probe: never sends turn/start or runs model tools. */
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexRpc } from "../src/agent/providers/codexRpc.js";

const require = createRequire(import.meta.url);
const cli = require.resolve("@openai/codex/bin/codex.js");
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
// Keep durable control threads out of the user's real Codex history.
if (process.argv.includes("--scratch-home")) env.CODEX_HOME = mkdtempSync(join(tmpdir(), "scribe-sandbox-probe-"));
const cases = [
  { name: "baseline-user", config: {}, reviewer: "user", ephemeral: true },
  { name: "baseline-auto", config: {}, reviewer: "auto_review", ephemeral: true },
  ...(process.argv.includes("--scratch-home") ? [{ name: "baseline-durable", config: {}, reviewer: "user", ephemeral: false }] : []),
  { name: "unelevated-user", config: { "windows.sandbox": "unelevated" }, reviewer: "user", ephemeral: true },
  { name: "unelevated-auto", config: { "windows.sandbox": "unelevated" }, reviewer: "auto_review", ephemeral: true },
  { name: "elevated", config: { "windows.sandbox": "elevated" }, reviewer: "user", ephemeral: true },
  { name: "legacy-feature", config: { "features.experimental_windows_sandbox": true }, reviewer: "user", ephemeral: true },
  { name: "full-control", config: {}, reviewer: "user", ephemeral: true, sandbox: "danger-full-access" },
];

const rpc = CodexRpc.launch(cli, env, () => {}, () => {});
try {
  await rpc.call("initialize", { clientInfo: { name: "scribe-sandbox-probe", version: "1" }, capabilities: { experimentalApi: true } });
  rpc.notify("initialized");
  for (const test of cases) {
    try {
      const result = await rpc.call("thread/start", {
        cwd: process.cwd(), sandbox: test.sandbox ?? "workspace-write", approvalPolicy: "on-request",
        approvalsReviewer: test.reviewer, ephemeral: test.ephemeral,
        config: { web_search: "disabled", ...test.config },
      }) as Record<string, unknown>;
      console.log(JSON.stringify({ name: test.name, sandbox: result.sandbox, approvalPolicy: result.approvalPolicy, approvalsReviewer: result.approvalsReviewer }));
    } catch (error) {
      console.log(JSON.stringify({ name: test.name, error: (error as Error).message }));
    }
  }
} finally {
  rpc.close();
}
