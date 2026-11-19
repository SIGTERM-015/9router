import { createHash } from "node:crypto";
import { canonicalizeUsage } from "open-sse/utils/usageTracking.js";
import { chInsert } from "./clickhouse.js";
import { resolveIdentity } from "./identity.js";

// Buffers request traces and ships them in batches. Messages, system prompts and tool
// definitions are stored once, by content hash; a trace only lists the hashes. Without
// that, every turn of a conversation would store the whole history again.
const FLUSH_MS = 5000;
const FLUSH_ROWS = 200;
const MAX_BUFFER_BYTES = 128 * 1024 * 1024;
const INLINE_DATA_LIMIT = 4096;
const SEEN_CAP = 200_000;
const PLACEHOLDER = "[Streaming in progress...]";

let traces = [];
let blobs = new Map();
let bytes = 0;
let dropped = 0;
let timer = null;
let flushing = false;
const seen = new Set();

const sha = (s) => createHash("sha256").update(s).digest("hex");

// Inline base64 payloads (images, documents) would dominate storage; keep a marker instead.
function stripInlineData(value) {
  if (Array.isArray(value)) return value.map(stripInlineData);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string" && v.length > INLINE_DATA_LIMIT && (k === "data" || k === "image_url" || k === "file_data" || v.startsWith("data:"))) {
      out[k] = `[omitted ${v.length} chars of inline data]`;
    } else {
      out[k] = stripInlineData(v);
    }
  }
  return out;
}

function addBlob(kind, value) {
  if (value === undefined || value === null || value === "") return "";
  const content = JSON.stringify(stripInlineData(value));
  const hash = sha(`${kind}:${content}`);
  if (!seen.has(hash) && !blobs.has(hash)) blobs.set(hash, { hash, kind, content });
  return hash;
}

export async function buildTrace(detail) {
  const req = detail.request || {};
  const ctx = detail.trace || {};
  const items = Array.isArray(req.messages) && req.messages.length ? req.messages
    : Array.isArray(req.input) ? req.input
    : req.input ? [req.input] : [];
  const usage = canonicalizeUsage(detail.tokens) || {};
  const res = detail.response || {};
  const { messages, input, system, instructions, tools, model, stream, ...params } = req;
  const identity = await resolveIdentity(ctx.apiKey, detail.connectionId);
  return {
    trace_id: String(detail.id || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`),
    ts: detail.timestamp || new Date().toISOString(),
    provider: detail.provider || "",
    model: detail.model || "",
    ...identity,
    endpoint: ctx.endpoint || "",
    status: detail.status || "",
    client: ctx.client || "",
    stream: req.stream || res.type === "streaming" ? 1 : 0,
    error: res.error ? String(res.error) : "",
    finish_reason: res.finish_reason || "",
    ttft_ms: Math.max(0, Math.round(detail.latency?.ttft || 0)),
    total_ms: Math.max(0, Math.round(detail.latency?.total || 0)),
    prompt_tokens: usage.prompt_tokens || 0,
    completion_tokens: usage.completion_tokens || 0,
    cached_tokens: usage.cached_tokens || 0,
    cache_write_tokens: usage.cache_creation_input_tokens || 0,
    reasoning_tokens: usage.reasoning_tokens || 0,
    system_hash: addBlob("system", system ?? instructions),
    tools_hash: addBlob("tools", tools),
    message_hashes: items.map((m) => addBlob("message", m)),
    params: JSON.stringify(params),
    response: typeof res.content === "string" ? res.content : res.content ? JSON.stringify(res.content) : "",
    thinking: res.thinking || "",
  };
}

async function flush() {
  if (flushing || !traces.length) return;
  flushing = true;
  const batchTraces = traces;
  const batchBlobs = [...blobs.values()];
  traces = [];
  blobs = new Map();
  bytes = 0;
  try {
    if (batchBlobs.length) await chInsert("blobs", batchBlobs);
    await chInsert("traces", batchTraces);
    for (const b of batchBlobs) seen.add(b.hash);
    if (seen.size > SEEN_CAP) seen.clear();
  } catch (e) {
    // Put the batch back, oldest first, unless the buffer is already at its cap.
    for (const b of batchBlobs) if (!blobs.has(b.hash)) blobs.set(b.hash, b);
    traces = batchTraces.concat(traces);
    bytes = traces.reduce((s, t) => s + t.response.length + t.params.length, 0);
    while (bytes > MAX_BUFFER_BYTES && traces.length) {
      const d = traces.shift();
      bytes -= d.response.length + d.params.length;
      dropped++;
    }
    console.error(`[analytics] trace flush failed (${traces.length} buffered, ${dropped} dropped): ${e.message}`);
  } finally {
    flushing = false;
  }
}

// Called for every finished request. Streaming placeholders are skipped: the final
// record of the same request follows once the stream completes.
// TRACE_KEYS (comma-separated API key names or ids) limits which keys get their prompts and
// responses stored; unset means every key. Usage replication is unaffected.
async function keyAllowed(detail) {
  const allow = (process.env.TRACE_KEYS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!allow.length) return true;
  const id = await resolveIdentity(detail.trace?.apiKey, detail.connectionId);
  return allow.includes(id.api_key_name) || allow.includes(id.api_key_id);
}

export async function recordTrace(detail) {
  if (process.env.TRACE_CAPTURE === "off") return;
  if (detail.response?.content === PLACEHOLDER) return;
  if (!(await keyAllowed(detail))) return;
  const trace = await buildTrace(detail);
  traces.push(trace);
  bytes += trace.response.length + trace.params.length;
  if (traces.length >= FLUSH_ROWS) {
    if (timer) { clearTimeout(timer); timer = null; }
    await flush();
  } else if (!timer) {
    timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, FLUSH_MS);
    timer.unref?.();
  }
}

export const __test__ = { flush, reset: () => { traces = []; blobs = new Map(); bytes = 0; dropped = 0; seen.clear(); }, state: () => ({ traces, blobs, dropped }) };
