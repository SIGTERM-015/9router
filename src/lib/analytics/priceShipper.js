import fs from "node:fs";
import { PRICES_FILE } from "open-sse/providers/catalogOverride.js";
import { chInsert } from "./clickhouse.js";

// Ships the price table the router bills with (models.dev, synced daily) so ClickHouse can price any
// window of history with today's list prices. Runs on the same tick as the usage replication and only
// does work when the sync wrote a new file. Rows go in with the sync time; readers take the newest set.
let shippedMtime = -1;

const sameRates = (a, b) => a && b && JSON.stringify([a.input, a.output, a.cached, a.cache_creation, a.tiers]) === JSON.stringify([b.input, b.output, b.cached, b.cache_creation, b.tiers]);

function row(provider, modelKey, p, syncedAt) {
  const tiers = p.tiers || [];
  return {
    provider, model_key: modelKey,
    input: p.input, output: p.output, cache_read: p.cached, cache_write: p.cache_creation, reasoning: p.reasoning,
    tier_sizes: tiers.map((t) => t.size), tier_input: tiers.map((t) => t.input), tier_output: tiers.map((t) => t.output),
    tier_cache_read: tiers.map((t) => t.cached), tier_cache_write: tiers.map((t) => t.cache_creation),
    synced_at: syncedAt,
  };
}

export async function shipPrices() {
  let mtime;
  try { mtime = fs.statSync(PRICES_FILE).mtimeMs; } catch { return 0; }
  if (mtime === shippedMtime) return 0;
  const file = JSON.parse(fs.readFileSync(PRICES_FILE, "utf8"));
  const syncedAt = Math.floor(mtime / 1000);
  // provider '' is the model's own price; a provider row exists only where its gateway differs.
  const rows = Object.entries(file.byModel || {}).map(([key, p]) => row("", key, p, syncedAt));
  for (const [k, p] of Object.entries(file.byProvider || {})) {
    const i = k.indexOf(":");
    const provider = k.slice(0, i), key = k.slice(i + 1);
    if (!sameRates(p, file.byModel?.[key])) rows.push(row(provider, key, p, syncedAt));
  }
  await chInsert("prices", rows);
  shippedMtime = mtime;
  return rows.length;
}

export const __test__ = { reset: () => { shippedMtime = -1; } };
