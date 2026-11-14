// "quota-aware" account selection for providers whose usage API reports quota windows
// (Claude, Codex). Three rules, in order:
//  1. An account with an exhausted window that applies to the model is skipped until that
//     window resets. Subscription 429s carry no reset time, so the usage API is the only
//     source for it; without this rule the account is retried every few minutes.
//  2. A conversation stays on the account it started on while that account has quota: the
//     provider's prompt cache is per account, so switching accounts re-sends the whole prompt.
//  3. Otherwise the account whose weekly window resets first wins. Quota left at a reset is
//     lost, quota on an account that resets later is still there afterwards.
// Usage is read with the same reader as GET /v0/quota, kept in memory and refreshed in the
// background: the request path never waits for it.
import * as log from "../utils/logger.js";

export const QUOTA_AWARE = "quota-aware";

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const FORCED_REFRESH_MIN_MS = 60 * 1000;
const SESSION_TTL_MS = 60 * 60 * 1000;
const MAX_SESSIONS = 5000;
const GENERIC_WINDOW_WORDS = new Set(["session", "weekly"]);

// Shared across Next.js bundles and hot reloads.
const state = (globalThis.__quotaRouting ??= {
  usage: new Map(), // connectionId -> { windows, attemptedAt }
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
    ...accountState(state.usage.get(connection.id)?.windows, model, now),
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

async function readWindows(connection, force) {
  const { readAccount } = await import("@/lib/quotaSnapshot");
  const account = await readAccount(connection, { force });
  return account.windows;
}

/**
 * Refresh one account's usage in the background. No-op while a read is in flight or the
 * last attempt is recent (5 min, or 1 min when forced after a 429). Never rejects.
 */
export function refreshAccountUsage(connection, { force = false } = {}) {
  const id = connection?.id;
  if (!id) return Promise.resolve();
  if (state.inflight.has(id)) return state.inflight.get(id);
  const now = Date.now();
  const previous = state.usage.get(id);
  if (previous && now - previous.attemptedAt < (force ? FORCED_REFRESH_MIN_MS : REFRESH_INTERVAL_MS)) {
    return Promise.resolve();
  }

  const promise = readWindows(connection, force)
    .then((windows) => {
      // An empty read (usage API rate-limited or down) keeps the last known windows.
      const known = windows?.length ? windows : previous?.windows || [];
      state.usage.set(id, { windows: known, attemptedAt: now });
    })
    .catch((error) => {
      state.usage.set(id, { windows: previous?.windows || [], attemptedAt: now });
      log.warn("QUOTA", `${connection.name || id.slice(0, 8)} | usage read failed: ${error.message}`);
    })
    .finally(() => state.inflight.delete(id));
  state.inflight.set(id, promise);
  return promise;
}

// After a 429 on an account this strategy routes, re-read its usage soon so an exhausted
// window (and its reset time) is known before the next request.
export function noteRateLimited(connection) {
  if (connection?.id && state.usage.has(connection.id)) {
    void refreshAccountUsage(connection, { force: true });
  }
}

export const __test__ = { state };
