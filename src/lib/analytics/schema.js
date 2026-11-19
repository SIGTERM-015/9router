import { chExec } from "./clickhouse.js";

// Cold data is recompressed in place after ARCHIVE_AFTER_DAYS; nothing is deleted.
const ARCHIVE_AFTER_DAYS = 100;
const cold = (col) => `TTL toDateTime(${col}) + INTERVAL ${ARCHIVE_AFTER_DAYS} DAY RECOMPRESS CODEC(ZSTD(17))`;

const TOKENS = `
  prompt_tokens UInt64,          -- total input, cache read and write included
  completion_tokens UInt64,
  cached_tokens UInt64,          -- cache read, a subset of prompt_tokens
  cache_write_tokens UInt64,     -- cache creation, a subset of prompt_tokens
  reasoning_tokens UInt64,`;

const DIMENSIONS = `
  provider LowCardinality(String),
  model LowCardinality(String),
  connection_id String,
  connection_name LowCardinality(String),
  api_key_id String,
  api_key_name LowCardinality(String),
  endpoint LowCardinality(String),
  status LowCardinality(String),`;

export const SCHEMA = [
  // One row per request that consumed tokens, replicated from the router's usageHistory.
  `CREATE TABLE IF NOT EXISTS usage_events (
  event_id UInt64,
  ts DateTime64(3, 'UTC'),${DIMENSIONS}${TOKENS}
  cost Float64
) ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (toDate(ts), provider, model, event_id)
${cold("ts")}`,

  // One row per request with its full content; messages, system prompts and tool
  // definitions live once in blobs and are referenced by hash.
  `CREATE TABLE IF NOT EXISTS traces (
  trace_id String,
  ts DateTime64(3, 'UTC'),${DIMENSIONS}
  client LowCardinality(String),
  stream UInt8,
  error String,
  finish_reason LowCardinality(String),
  ttft_ms UInt32,
  total_ms UInt32,${TOKENS}
  system_hash String,
  tools_hash String,
  message_hashes Array(String),
  params String,
  response String,
  thinking String
) ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(ts)
ORDER BY (toDate(ts), trace_id)
${cold("ts")}`,

  `CREATE TABLE IF NOT EXISTS blobs (
  hash String,
  kind LowCardinality(String),
  content String,
  first_seen DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree
ORDER BY hash
${cold("first_seen")}`,
];

export async function ensureSchema() {
  for (const ddl of SCHEMA) await chExec(ddl);
}
