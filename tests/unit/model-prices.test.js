import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { gunzipSync } from "node:zlib";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { build, toPricing } from "../../src/lib/modelCatalog/prices.js";
import { calculateCostFromTokens, ratesForPrompt, getPricingForModel, setPriceSource } from "../../open-sse/providers/pricing.js";

const catalog = {
  anthropic: { models: { "claude-opus-5-5": { cost: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 } } } },
  google: { models: { "gemini-big": { cost: { input: 1, output: 8, cache_read: 0.1, tiers: [{ input: 2, output: 12, cache_read: 0.2, tier: { type: "context", size: 200000 } }] } } } },
  gatewayA: { models: { "vendorless-x": { cost: { input: 0.3, output: 1.2 } }, "lonely": { cost: { input: 9, output: 9 } }, "free-one": { cost: { input: 0, output: 0 } } } },
  gatewayB: { models: { "vendorless-x": { cost: { input: 0.3, output: 1.2 } }, "free-one": { cost: { input: 0, output: 0 } } } },
  gatewayC: { models: { "vendorless-x": { cost: { input: 0.9, output: 3 } }, "claude-opus-5-5": { cost: { input: 5, output: 25 } } } },
  "github-copilot": { models: { "gpt-copilot": { cost: { input: 1, output: 2 } } } },
};

describe("models.dev price table", () => {
  const t = build(catalog);

  it("uses the model vendor's price, not a reseller's, and the gateway's own when it lists the model", () => {
    expect(t.byModel["claude-opus-5-5"]).toMatchObject({ input: 4, output: 20, cached: 0.2, cache_creation: 5 });
    expect(t.byProvider["gatewayC:claude-opus-5-5"]).toMatchObject({ input: 5, output: 25 });
    expect(t.byProvider["claude:claude-opus-5-5"]).toMatchObject({ input: 4 });
  });

  it("needs two gateways to agree on a price when no vendor lists the model", () => {
    expect(t.byModel["vendorless-x"]).toMatchObject({ input: 0.3, output: 1.2 });
    expect(t.byModel["lonely"]).toBeUndefined();
  });

  it("records a model listed free everywhere as $0", () => {
    expect(t.byModel["free-one"]).toMatchObject({ input: 0, output: 0 });
  });

  it("files gateway aliases under the router's provider id", () => {
    expect(t.byProvider["github:gpt-copilot"]).toMatchObject({ input: 1, output: 2 });
  });

  it("keeps context tiers sorted and ignores a malformed cost", () => {
    expect(t.byModel["gemini-big"].tiers).toEqual([{ size: 200000, input: 2, output: 12, cached: 0.2, cache_creation: 0 }]);
    expect(toPricing({ output: 1 })).toBeNull();
    expect(toPricing(null)).toBeNull();
  });
});

describe("cost with models.dev prices", () => {
  const pricing = build(catalog).byModel["gemini-big"];

  it("bills a short prompt at the base rate", () => {
    const cost = calculateCostFromTokens({ prompt_tokens: 100000, completion_tokens: 1000 }, pricing);
    expect(cost).toBeCloseTo(0.1 + 0.008, 9);
  });

  it("bills the whole request at the long-context rate once the prompt passes the tier", () => {
    expect(ratesForPrompt(pricing, 200000)).toBe(pricing);
    const cost = calculateCostFromTokens({ prompt_tokens: 300000, cached_tokens: 100000, completion_tokens: 1000 }, pricing);
    expect(cost).toBeCloseTo(200000 * 2 / 1e6 + 100000 * 0.2 / 1e6 + 1000 * 12 / 1e6, 9);
  });

  it("charges the input rate for a cache price the catalog does not have", () => {
    const p = build(catalog).byModel["vendorless-x"];
    expect(calculateCostFromTokens({ prompt_tokens: 1000, cached_tokens: 1000 }, p)).toBeCloseTo(1000 * 0.3 / 1e6, 9);
  });
});

describe("resolver order", () => {
  afterEach(() => setPriceSource(null));

  it("prefers the catalog over the built-in tables and falls back to them without it", () => {
    expect(getPricingForModel("claude", "claude-opus-5-5")).toMatchObject({ input: 4 });
    setPriceSource({ getPricing: () => ({ input: 7, output: 8, cached: 1, cache_creation: 2 }) });
    expect(getPricingForModel("claude", "claude-opus-5-5")).toMatchObject({ input: 7 });
  });

  it("keeps free namespaces and provider overrides above the catalog", () => {
    setPriceSource({ getPricing: () => ({ input: 7, output: 8 }) });
    expect(getPricingForModel("gh", "gpt-5.3-codex")).toMatchObject({ input: 1.75 });
    expect(getPricingForModel("cline", "cline-free/deepseek-v4.1-flash")).toMatchObject({ input: 0, output: 0 });
  });
});

describe("price replication", () => {
  let server, received, tempDir;
  const dataDir = process.env.DATA_DIR;
  beforeEach(async () => {
    received = [];
    server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        let body = Buffer.concat(chunks);
        if (req.headers["content-encoding"] === "gzip") body = gunzipSync(body);
        received.push({ query: new URL(req.url, "http://x").searchParams.get("query"), body: body.toString() });
        res.writeHead(200); res.end("");
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-prices-"));
    process.env.DATA_DIR = tempDir;
    process.env.CLICKHOUSE_URL = `http://127.0.0.1:${server.address().port}`;
    vi.resetModules();
  });
  afterEach(async () => {
    await new Promise((r) => server.close(r));
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (dataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = dataDir;
    delete process.env.CLICKHOUSE_URL;
  });

  it("ships the table once per synced file, with provider rows only where a gateway differs", async () => {
    const file = path.join(tempDir, "model-prices.json");
    fs.writeFileSync(file, JSON.stringify(build(catalog)));
    const { shipPrices } = await import("../../src/lib/analytics/priceShipper.js");
    const n = await shipPrices();
    const rows = received.filter((r) => r.query === "INSERT INTO prices FORMAT JSONEachRow").flatMap((r) => r.body.split("\n").map((l) => JSON.parse(l)));
    expect(rows).toHaveLength(n);
    expect(rows.find((r) => r.provider === "" && r.model_key === "claude-opus-5-5")).toMatchObject({ input: 4, output: 20, cache_read: 0.2, cache_write: 5 });
    expect(rows.find((r) => r.provider === "gatewayC" && r.model_key === "claude-opus-5-5")).toMatchObject({ input: 5 });
    expect(rows.find((r) => r.provider === "claude" && r.model_key === "claude-opus-5-5")).toBeUndefined();
    expect(rows.find((r) => r.model_key === "gemini-big")).toMatchObject({ tier_sizes: [200000], tier_input: [2], tier_output: [12] });
    expect(await shipPrices()).toBe(0);
    expect(received.filter((r) => r.query.includes("INSERT"))).toHaveLength(1);
  });

  it("ships nothing before the first sync wrote a file", async () => {
    const { shipPrices } = await import("../../src/lib/analytics/priceShipper.js");
    expect(await shipPrices()).toBe(0);
    expect(received).toHaveLength(0);
  });
});
