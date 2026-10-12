import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { fakeAdapter } from "./adapters/fake.js";
import { mlRouter } from "./routes.js";
import { MlService } from "./service.js";
import { fileStore } from "./settings.js";

test("the /api/ml routes keep keys on the daemon, test a source and count its tokens", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scribe-ml-routes-"));
  const adapter = fakeAdapter();
  const service = new MlService({ store: fileStore(() => root), adapter, log: () => {} });
  const app = express();
  app.use(express.json());
  app.use("/api/ml", mlRouter(service));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/ml`;
  const call = async (method: string, route: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${url}${route}`, {
      method,
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    assert.ok(!text.includes("sk-secret"), `${method} ${route} leaked the key`);
    return { status: res.status, body: JSON.parse(text) };
  };
  try {
    const empty = await call("GET", "/settings");
    assert.deepEqual(empty.body.sources, []);
    assert.equal(empty.body.defaultSource, null);
    assert.deepEqual(empty.body.send, { messages: true, agentText: true, toolCalls: true, toolResults: true });

    const added = await call("POST", "/sources", { name: "Jev", baseUrl: "https://api.typesafe.ai/v1", apiKey: "sk-secret" });
    assert.deepEqual(added.body.source, { id: "jev", name: "Jev", baseUrl: "https://api.typesafe.ai", model: "jev-latest", hasKey: true });
    assert.equal(added.body.defaultSource, "jev");
    assert.equal((await call("POST", "/sources", { name: "Local", baseUrl: "http://localhost:8080", model: "tiny" })).body.sources.length, 2);
    assert.equal((await call("POST", "/sources", { name: "Bad", baseUrl: "nope" })).status, 400);
    assert.equal((await call("PUT", "/sources/missing", { name: "x" })).status, 400);

    // The key is on disk for the daemon, in the settings file only.
    assert.match(fs.readFileSync(path.join(root, "ml-settings.json"), "utf8"), /sk-secret/);

    assert.equal((await call("PUT", "/settings", { defaultSource: "local", send: { toolResults: false } })).body.defaultSource, "local");
    assert.equal((await call("GET", "/settings")).body.send.toolResults, false);
    assert.equal((await call("PUT", "/settings", { defaultSource: "missing" })).status, 400);

    const tested = await call("POST", "/sources/jev/test", {});
    assert.equal(tested.body.ok, true);
    assert.equal(tested.body.answers.sunny.type, "yesno");
    assert.equal(adapter.calls[0].source.apiKey, "sk-secret");
    const missing = await call("POST", "/sources/missing/test", {});
    assert.deepEqual([missing.status, missing.body.ok, missing.body.error], [200, false, "no_source"]);

    const usage = (await call("GET", "/usage")).body;
    assert.equal(usage.calls, 1);
    assert.ok(usage.inputTokens > 0);
    assert.equal(usage.latency.count, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, "ml-usage.json"), "utf8")).calls, 1);

    // Changes are refused from another origin and when they are not JSON.
    assert.equal((await call("PUT", "/settings", { send: { messages: false } }, { Origin: "http://evil.example" })).status, 403);
    const form = await fetch(`${url}/sources/jev`, { method: "DELETE" });
    assert.equal(form.status, 415);
    assert.equal((await call("GET", "/settings")).body.send.messages, true);

    const left = await call("DELETE", "/sources/local", {});
    assert.deepEqual(left.body.sources.map((s: { id: string }) => s.id), ["jev"]);
    assert.equal(left.body.defaultSource, "jev");

    // A second service on the same folder reads what the first one saved.
    const again = new MlService({ store: fileStore(() => root), adapter, log: () => {} });
    assert.equal(again.view().sources[0].hasKey, true);
    assert.equal(again.usage().calls, 1);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
