// "quota-aware" account selection for providers whose usage API reports quota windows
// (Claude, Codex). Three rules, in order:
//  1. An account with an exhausted window that applies to the model (5h session, weekly,
//     weekly per model) is skipped until that window resets, not just until a 429 lock
//     (at most 30 minutes) expires.
//  2. A conversation stays on the account it started on while that account has quota: the
//     provider's prompt cache is per account, so switching accounts re-sends the whole prompt.
//  3. Otherwise the account whose weekly window resets first wins. Quota left at a reset is
//     lost, quota on an account that resets later is still there afterwards.
// Quota comes from two sources, kept in memory: the usage API (same reader as GET /v0/quota,
// refreshed in the background, so the request path never waits for it) and, for Claude, the
// 5h and 7d windows every response reports in its headers, so an account that runs out is
// skipped from the next request on.
import * as log from "../utils/logger.js";
import { anthropicQuotaWindows } from "open-sse/utils/anthropicQuota.js";

export const QUOTA_AWARE = "quota-aware";

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const SOON_REFRESH_MS = 60 * 1000;
const SESSION_TTL_MS = 60 * 60 * 1000;
const MAX_SESSIONS = 5000;
const GENERIC_WINDOW_WORDS = new Set(["session", "weekly"]);

// Shared across Next.js bundles and hot reloads.
const state = (globalThis.__quotaRouting ??= {
  windows: new Map(), // connectionId -> Map(label -> { label, usedPercent, resetsAt, seenAt })
  readAt: new Map(), // connectionId -> when its usage API read was last started
  inflight: new Map(), // connectionId -> Promise
  sessions: new Map(), // `${provider}:${sessionId}` -> { connectionId, usedAt }
});

// A window applies to a model when every word of its label other than session/weekly
// names the model: "session (5h)" and "weekly (7d)" apply to all, "weekly fable (7d)" to
// claude-fable-*, Codex "spark_weekly" to *-spark, and "review_weekly" to no chat model.
export function windowApplies(label, model) {
  const words = String(label || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .split(/[\s_]+/)
    .filter((word) => word && !GENERIC_WINDOW_WORDS.has(word));
  const id = String(model || "").toLowerCase();
  return words.every((word) => id.includes(word));
}

function accountState(windows, model, now) {
  let exhaustedUntil = 0;
  let weeklyResetMs = Infinity;
  for (const window of windows || []) {
    if (!windowApplies(window.label, model)) continue;
    const resetMs = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
    if (Number.isFinite(resetMs) && resetMs <= now) continue; // reset since it was read
    if (window.usedPercent >= 100) {
      exhaustedUntil = Math.max(exhaustedUntil, Number.isFinite(resetMs) ? resetMs : now + REFRESH_INTERVAL_MS);
    }
    if (/weekly/i.test(window.label) && Number.isFinite(resetMs)) {
      weeklyResetMs = Math.min(weeklyResetMs, resetMs);
    }
  }
  return { exhaustedUntil, weeklyResetMs };
}

// The latest reading of each window wins, whichever source it came from. Usage only grows
// within a window except when a reset grant is redeemed, so "newest", not "highest". A
// usage read is dated when it starts: one that started before a response is older than it.
function recordWindows(connectionId, windows, seenAt) {
  const known = state.windows.get(connectionId) || new Map();
  for (const window of windows) {
    if (!(known.get(window.label)?.seenAt > seenAt)) known.set(window.label, { ...window, seenAt });
  }
  state.windows.set(connectionId, known);
}

function stickyConnectionId(sessionKey, now) {
  const entry = sessionKey ? state.sessions.get(sessionKey) : null;
  return entry && now - entry.usedAt <= SESSION_TTL_MS ? entry.connectionId : null;
}

function rememberSession(sessionKey, connectionId, now) {
  if (!sessionKey) return;
  state.sessions.delete(sessionKey);
  if (state.sessions.size >= MAX_SESSIONS) state.sessions.delete(state.sessions.keys().next().value);
  state.sessions.set(sessionKey, { connectionId, usedAt: now });
}

function inHours(ms, now) {
  return Number.isFinite(ms) ? `${Math.max(0, Math.round((ms - now) / 360000) / 10)}h` : "unknown";
}

/**
 * Pick an account from `connections` (already filtered for locks and exclusions, in
 * priority order). Returns { connection, reason }, or null when the list is empty.
 */
export function pickQuotaAware(connections, { model = null, sessionKey = null, now = Date.now() } = {}) {
  if (!connections.length) return null;
  const candidates = connections.map((connection, index) => ({
    connection,
    index,
    ...accountState(state.windows.get(connection.id)?.values(), model, now),
  }));
  const open = candidates.filter((candidate) => !candidate.exhaustedUntil);

  let choice;
  let reason;
  const stickyId = stickyConnectionId(sessionKey, now);
  const sticky = stickyId && open.find((candidate) => candidate.connection.id === stickyId);
  if (sticky) {
    choice = sticky;
    reason = "same session";
  } else if (open.length) {
    choice = open.toSorted((a, b) => (a.weeklyResetMs - b.weeklyResetMs) || (a.index - b.index))[0];
    reason = `weekly resets in ${inHours(choice.weeklyResetMs, now)}`;
  } else {
    // Every account looks exhausted. The usage read may be stale (e.g. a reset credit was
    // just redeemed), so try the one that frees up first instead of refusing outright.
    choice = candidates.toSorted((a, b) => (a.exhaustedUntil - b.exhaustedUntil) || (a.index - b.index))[0];
    reason = `all exhausted, first frees in ${inHours(choice.exhaustedUntil, now)}`;
  }
  rememberSession(sessionKey, choice.connection.id, now);
  return { connection: choice.connection, reason };
}

// Always a fresh read (the usage reader's cache would otherwise hand back a reading of
// unknown age); this module throttles reads itself.
async function readWindows(connection) {
  const { readAccount } = await import("@/lib/quotaSnapshot");
  const account = await readAccount(connection, { force: true });
  return account.windows;
}

/**
 * Refresh one account's usage in the background. No-op while a read is in flight or the
 * last one started recently (5 min, or 1 min when `soon`, after a 429). Never rejects.
 */
export function refreshAccountUsage(connection, { soon = false } = {}) {
  const id = connection?.id;
  if (!id) return Promise.resolve();
  if (state.inflight.has(id)) return state.inflight.get(id);
  const now = Date.now();
  const last = state.readAt.get(id);
  if (last !== undefined && now - last < (soon ? SOON_REFRESH_MS : REFRESH_INTERVAL_MS)) {
    return Promise.resolve();
  }
  state.readAt.set(id, now);

  // An empty read (usage API rate-limited or down) leaves what is known unchanged.
  const promise = readWindows(connection)
    .then((windows) => recordWindows(id, windows || [], now))
    .catch((error) => log.warn("QUOTA", `${connection.name || id.slice(0, 8)} | usage read failed: ${error.message}`))
    .finally(() => state.inflight.delete(id));
  state.inflight.set(id, promise);
  return promise;
}

/**
 * Record what an upstream response (success or error) says about its account's quota.
 * Claude responses carry the account's 5h and 7d windows. A 429 also re-reads the usage
 * API early (accounts this strategy routes): the limit hit may be one headers do not
 * report, like a weekly limit for one model.
 */
export function noteResponse(connection, response) {
  const id = connection?.id;
  if (!id) return;
  const windows = anthropicQuotaWindows(response?.headers);
  if (windows.length) {
    const known = state.windows.get(id);
    for (const window of windows) {
      if (window.usedPercent >= 100 && !(known?.get(window.label)?.usedPercent >= 100)) {
        log.info("QUOTA", `${connection.name || id.slice(0, 8)} | ${window.label} exhausted until ${window.resetsAt}`);
      }
    }
    recordWindows(id, windows, Date.now());
  }
  if (response?.status === 429 && state.readAt.has(id)) {
    void refreshAccountUsage(connection, { soon: true });
  }
}

export const __test__ = { state, recordWindows };
