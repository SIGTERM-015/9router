import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
const originalRetention = process.env.USAGE_RETENTION_DAYS;
let tempDir;
let db;

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

async function save(timestamp) {
  await db.saveRequestUsage({
    timestamp, provider: "openai", model: "gpt-4", connectionId: "c1",
    tokens: { prompt_tokens: 10, completion_tokens: 5 }, endpoint: "/v1/chat", status: "ok",
  });
}

// Seed one old and one fresh entry (the prune runs on the first write, so seed with it disabled),
// then force a prune with the retention under test.
async function seedAndPrune() {
  process.env.USAGE_RETENTION_DAYS = "0";
  await save(daysAgo(100));
  await save(daysAgo(1));
  delete global._lastUsagePrune;
}

const rows = async () => (await db.getUsageHistory()).map((r) => r.timestamp);
const dayCount = async () => (await db.getUsageStats("all")).totalRequests;

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-retention-"));
  process.env.DATA_DIR = tempDir;
  delete global._lastUsagePrune;
  delete global._dbAdapter;
  delete global._recentRing;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  for (const [k, v] of [["DATA_DIR", originalDataDir], ["USAGE_RETENTION_DAYS", originalRetention]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

describe("usage retention", () => {
  it("drops usage older than 90 days by default", async () => {
    await seedAndPrune();
    delete process.env.USAGE_RETENTION_DAYS;
    await save(daysAgo(0));
    expect((await rows()).length).toBe(2);
    expect(await dayCount()).toBe(2);
  });

  it("USAGE_RETENTION_DAYS overrides the default", async () => {
    await seedAndPrune();
    process.env.USAGE_RETENTION_DAYS = "200";
    await save(daysAgo(0));
    expect((await rows()).length).toBe(3);
  });

  it("the usageRetentionDays setting wins over the env", async () => {
    await seedAndPrune();
    process.env.USAGE_RETENTION_DAYS = "200";
    await db.updateSettings({ usageRetentionDays: 30 });
    await save(daysAgo(0));
    expect((await rows()).length).toBe(2);
  });

  it("0 keeps everything", async () => {
    await seedAndPrune();
    await save(daysAgo(0));
    expect((await rows()).length).toBe(3);
  });
});
