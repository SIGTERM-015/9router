import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { gunzipSync } from "node:zlib";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

let server;
let received;
let failNext;
let tempDir;
const originalDataDir = process.env.DATA_DIR;

function startFakeClickHouse() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        let body = Buffer.concat(chunks);
        if (req.headers["content-encoding"] === "gzip") body = gunzipSync(body);
        const query = new URL(req.url, "http://x").searchParams.get("query");
        if (failNext) { failNext = false; res.writeHead(500); res.end("boom"); return; }
        received.push({ query, rows: query.includes("INSERT") ? body.toString().split("\n").map((l) => JSON.parse(l)) : [], user: req.headers["x-clickhouse-user"] });
        res.writeHead(200); res.end("");
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

const rowsFor = (table) => received.filter((r) => r.query === `INSERT INTO ${table} FORMAT JSONEachRow`).flatMap((r) => r.rows);

beforeEach(async () => {
  received = [];
  failNext = false;
  const port = await startFakeClickHouse();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-analytics-"));
  process.env.DATA_DIR = tempDir;
  process.env.CLICKHOUSE_URL = `http://127.0.0.1:${port}`;
  process.env.CLICKHOUSE_USER = "router";
  delete global._dbAdapter;
  delete global._recentRing;
  vi.resetModules();
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
  delete process.env.CLICKHOUSE_URL;
  delete process.env.CLICKHOUSE_USER;
  if (originalDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = originalDataDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function seededDb() {
  const db = await import("@/lib/db/index.js");
  await db.initDb();
  const key = await (await import("@/lib/db/repos/apiKeysRepo.js")).createApiKey("ci-bot", "machine1");
  await db.saveRequestUsage({
    timestamp: "2026-11-01T10:00:00.000Z", provider: "claude", model: "claude-opus-5-5", connectionId: "conn-1",
    apiKey: key.key, endpoint: "/v1/messages", status: "ok",
    tokens: { prompt_tokens: 1000, completion_tokens: 50, cached_tokens: 800, cache_creation_input_tokens: 100 },
  });
  await db.saveRequestUsage({
    timestamp: "2026-11-01T10:05:00.000Z", provider: "codex", model: "gpt-6.1-sol", connectionId: "conn-2",
    endpoint: "/v1/chat/completions", status: "ok", tokens: { prompt_tokens: 10, completion_tokens: 5 },
  });
  return key;
}

describe("usage replication", () => {
  it("ships usageHistory with the key name instead of the raw key, and only ships each row once", async () => {
    const key = await seededDb();
    const { shipUsage } = await import("@/lib/analytics/usageShipper.js");
    expect(await shipUsage()).toBe(2);
    const events = rowsFor("usage_events");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      ts: "2026-11-01T10:00:00.000Z", provider: "claude", model: "claude-opus-5-5",
      api_key_id: key.id, api_key_name: "ci-bot", endpoint: "/v1/messages",
      prompt_tokens: 1000, completion_tokens: 50, cached_tokens: 800, cache_write_tokens: 100,
    });
    expect(events[1]).toMatchObject({ api_key_name: "no-key", api_key_id: "" });
    expect(JSON.stringify(events)).not.toContain(key.key);
    expect(received[0].user).toBe("router");

    expect(await shipUsage()).toBe(0);
    expect(rowsFor("usage_events")).toHaveLength(2);
  });

  it("keeps the cursor when ClickHouse is down and ships everything once it is back", async () => {
    await seededDb();
    const { shipUsage } = await import("@/lib/analytics/usageShipper.js");
    failNext = true;
    await expect(shipUsage()).rejects.toThrow(/ClickHouse 500/);
    expect(rowsFor("usage_events")).toHaveLength(0);
    expect(await shipUsage()).toBe(2);
    expect(rowsFor("usage_events")).toHaveLength(2);
  });
});

describe("trace sink", () => {
  const detail = (messages, extra = {}) => ({
    id: "t1", provider: "claude", model: "claude-opus-5-5", connectionId: "conn-1",
    timestamp: "2026-11-01T10:00:00.000Z", status: "success",
    latency: { ttft: 120, total: 900 },
    tokens: { prompt_tokens: 12, completion_tokens: 3, cache_read_input_tokens: 5 },
    trace: { apiKey: null, endpoint: "/v1/messages", client: "claude" },
    request: { model: "m", stream: true, temperature: 0.2, system: "be brief", tools: [{ name: "bash" }], messages },
    response: { content: "hi", thinking: "hmm", type: "streaming" },
    ...extra,
  });

  it("stores each message once and a conversation's next turn only adds the new messages", async () => {
    const { recordTrace, __test__ } = await import("@/lib/analytics/traceSink.js");
    const m1 = { role: "user", content: "hello" };
    const m2 = { role: "assistant", content: "hi" };
    const m3 = { role: "user", content: "again" };
    await recordTrace(detail([m1]));
    await recordTrace(detail([m1, m2, m3], { id: "t2" }));
    await __test__.flush();

    const blobs = rowsFor("blobs");
    const traces = rowsFor("traces");
    expect(traces).toHaveLength(2);
    expect(blobs.filter((b) => b.kind === "message")).toHaveLength(3);
    expect(blobs.filter((b) => b.kind === "system")).toHaveLength(1);
    expect(blobs.filter((b) => b.kind === "tools")).toHaveLength(1);
    expect(traces[1].message_hashes.slice(0, 1)).toEqual(traces[0].message_hashes);
    expect(traces[1].message_hashes).toHaveLength(3);
    expect(traces[0]).toMatchObject({
      client: "claude", endpoint: "/v1/messages", stream: 1, ttft_ms: 120, total_ms: 900,
      prompt_tokens: 12 + 5, cached_tokens: 5, completion_tokens: 3, response: "hi", thinking: "hmm",
      api_key_name: "no-key",
    });
    expect(JSON.parse(traces[0].params)).toEqual({ temperature: 0.2 });
    const msg = blobs.find((b) => b.hash === traces[0].message_hashes[0]);
    expect(JSON.parse(msg.content)).toEqual(m1);
  });

  it("stores traces only for the API keys in TRACE_KEYS, but still ships their usage", async () => {
    const db = await import("@/lib/db/index.js");
    await db.initDb();
    const { createApiKey } = await import("@/lib/db/repos/apiKeysRepo.js");
    const mine = await createApiKey("mine", "m1");
    const other = await createApiKey("someone-else", "m1");
    process.env.TRACE_KEYS = "mine";
    const { recordTrace, __test__ } = await import("@/lib/analytics/traceSink.js");
    for (const [k, id] of [[mine, "a"], [other, "b"]]) {
      await recordTrace(detail([{ role: "user", content: `from ${id}` }], { id, trace: { apiKey: k.key, endpoint: "/v1/messages", client: "claude" } }));
    }
    delete process.env.TRACE_KEYS;
    await __test__.flush();
    expect(rowsFor("traces").map((t) => [t.trace_id, t.api_key_name])).toEqual([["a", "mine"]]);
    expect(rowsFor("blobs").filter((b) => b.kind === "message").map((b) => JSON.parse(b.content).content)).toEqual(["from a"]);
  });

  it("skips the streaming placeholder and omits inline base64 data", async () => {
    const { recordTrace, __test__ } = await import("@/lib/analytics/traceSink.js");
    await recordTrace(detail([{ role: "user", content: "x" }], { response: { content: "[Streaming in progress...]", type: "streaming" } }));
    const big = "A".repeat(10000);
    await recordTrace(detail([{ role: "user", content: [{ type: "image", source: { type: "base64", data: big } }] }]));
    await __test__.flush();
    expect(rowsFor("traces")).toHaveLength(1);
    const content = rowsFor("blobs").find((b) => b.kind === "message").content;
    expect(content).not.toContain("AAAA");
    expect(content).toContain("omitted 10000 chars");
  });

  it("retries a failed batch without losing traces", async () => {
    const { recordTrace, __test__ } = await import("@/lib/analytics/traceSink.js");
    await recordTrace(detail([{ role: "user", content: "x" }]));
    failNext = true;
    await __test__.flush();
    expect(rowsFor("traces")).toHaveLength(0);
    await __test__.flush();
    expect(rowsFor("traces")).toHaveLength(1);
    expect(rowsFor("blobs").filter((b) => b.kind === "message")).toHaveLength(1);
  });
});

describe("schema", () => {
  it("creates the tables; the three that hold history recompress in place after 100 days", async () => {
    const { ensureSchema } = await import("@/lib/analytics/schema.js");
    await ensureSchema();
    const ddl = received.map((r) => r.query);
    expect(ddl.map((q) => q.match(/CREATE TABLE IF NOT EXISTS (\w+)/)[1])).toEqual(["usage_events", "traces", "blobs", "prices"]);
    for (const q of ddl.slice(0, 3)) expect(q).toContain("INTERVAL 100 DAY RECOMPRESS CODEC(ZSTD(17))");
    expect(ddl[3]).not.toContain("TTL");
  });
});
