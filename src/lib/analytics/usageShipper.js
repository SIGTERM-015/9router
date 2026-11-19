import { getAdapter } from "@/lib/db/driver.js";
import { getMeta, setMeta } from "@/lib/db/helpers/metaStore.js";
import { parseJson } from "@/lib/db/helpers/jsonCol.js";
import { chInsert } from "./clickhouse.js";
import { resolveIdentity } from "./identity.js";

// Replicates usageHistory to ClickHouse with a persisted cursor. The cursor only moves after a
// successful insert, so an outage delays rows instead of losing them, and the first run is the
// backfill of everything still in the router's database. ReplacingMergeTree absorbs any replay.
const CURSOR_KEY = "clickhouseUsageCursor";
const BATCH = 5000;

const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export async function toEvent(row) {
  const t = parseJson(row.tokens, {});
  return {
    event_id: row.id,
    ts: row.timestamp,
    provider: row.provider || "",
    model: row.model || "",
    ...(await resolveIdentity(row.apiKey, row.connectionId)),
    endpoint: row.endpoint || "",
    status: row.status || "",
    prompt_tokens: n(t.prompt_tokens ?? t.input_tokens ?? row.promptTokens),
    completion_tokens: n(t.completion_tokens ?? t.output_tokens ?? row.completionTokens),
    cached_tokens: n(t.cached_tokens ?? t.cache_read_input_tokens),
    cache_write_tokens: n(t.cache_creation_input_tokens),
    reasoning_tokens: n(t.reasoning_tokens),
    cost: n(row.cost),
  };
}

// Ships every pending batch. Returns the number of rows shipped.
export async function shipUsage() {
  const db = await getAdapter();
  let shipped = 0;
  for (;;) {
    const cursor = Number(await getMeta(CURSOR_KEY, "0"));
    const rows = db.all(
      `SELECT id, timestamp, provider, model, connectionId, apiKey, endpoint, promptTokens, completionTokens, cost, status, tokens
       FROM usageHistory WHERE id > ? ORDER BY id ASC LIMIT ?`,
      [cursor, BATCH]
    );
    if (!rows.length) return shipped;
    await chInsert("usage_events", await Promise.all(rows.map(toEvent)));
    await setMeta(CURSOR_KEY, rows[rows.length - 1].id);
    shipped += rows.length;
    if (rows.length < BATCH) return shipped;
  }
}
