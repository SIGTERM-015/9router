// Claude subscription (OAuth) responses report the account's quota on every response,
// success or 429:
//   anthropic-ratelimit-unified-5h-utilization: 0.1          fraction of the window used
//   anthropic-ratelimit-unified-5h-reset: 1794671400         epoch seconds
//   anthropic-ratelimit-unified-5h-status: allowed | allowed_warning | rejected
// the same for 7d, and anthropic-ratelimit-unified-{status,reset} for the limit that
// decided the request (a rejected one also sends retry-after). Window labels match the
// usage API's (open-sse/services/usage/claude.js).
const PREFIX = "anthropic-ratelimit-unified-";
const WINDOW_LABELS = { "5h": "session (5h)", "7d": "weekly (7d)" };

function epochMs(value) {
  const seconds = Number(value);
  return value && seconds > 0 ? seconds * 1000 : null;
}

/** Quota windows in a Claude response, as { label, usedPercent (0–100), resetsAt (ISO) }. */
export function anthropicQuotaWindows(headers) {
  if (typeof headers?.get !== "function") return [];
  return Object.entries(WINDOW_LABELS).flatMap(([claim, label]) => {
    const utilization = headers.get(`${PREFIX}${claim}-utilization`);
    if (utilization === null || !Number.isFinite(Number(utilization))) return [];
    // The window's own status decides whether it is spent: with extra usage enabled an
    // account keeps being served past 100%.
    const status = headers.get(`${PREFIX}${claim}-status`);
    const percent = Math.max(0, Math.min(100, Number(utilization) * 100));
    const used = status === "rejected" ? 100 : status ? Math.min(percent, 99.9) : percent;
    const resetMs = epochMs(headers.get(`${PREFIX}${claim}-reset`));
    return [{
      label,
      usedPercent: Math.round(used * 10) / 10,
      resetsAt: resetMs ? new Date(resetMs).toISOString() : null,
    }];
  });
}

/** For a request rejected by a subscription limit: when that limit resets (ms epoch). */
export function anthropicRejectedUntil(headers) {
  if (typeof headers?.get !== "function" || headers.get(`${PREFIX}status`) !== "rejected") return null;
  return epochMs(headers.get(`${PREFIX}reset`));
}
