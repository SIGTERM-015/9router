import { gzipSync } from "node:zlib";

// Minimal ClickHouse HTTP client. Analytics is off unless CLICKHOUSE_URL is set.
// Credentials come from env only: CLICKHOUSE_USER, CLICKHOUSE_PASSWORD, CLICKHOUSE_DATABASE.

const TIMEOUT_MS = 30_000;

export function analyticsEnabled() {
  return Boolean(process.env.CLICKHOUSE_URL);
}

export const database = () => process.env.CLICKHOUSE_DATABASE || "router";

async function request(query, body, { gzip = false } = {}) {
  const url = new URL(process.env.CLICKHOUSE_URL);
  url.searchParams.set("database", database());
  url.searchParams.set("query", query);
  url.searchParams.set("date_time_input_format", "best_effort");
  url.searchParams.set("input_format_skip_unknown_fields", "1");
  const headers = {
    "X-ClickHouse-User": process.env.CLICKHOUSE_USER || "default",
    "X-ClickHouse-Key": process.env.CLICKHOUSE_PASSWORD || "",
  };
  let payload = body;
  if (gzip && body) {
    payload = gzipSync(body);
    headers["Content-Encoding"] = "gzip";
  }
  const res = await fetch(url, { method: "POST", headers, body: payload, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${text.slice(0, 300).trim()}`);
  return text;
}

export function chExec(sql) {
  return request(sql);
}

export function chInsert(table, rows) {
  if (!rows.length) return Promise.resolve();
  const body = rows.map((r) => JSON.stringify(r)).join("\n");
  return request(`INSERT INTO ${table} FORMAT JSONEachRow`, body, { gzip: true });
}
