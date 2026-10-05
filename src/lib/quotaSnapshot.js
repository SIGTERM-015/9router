// Quota snapshot for every active connection whose provider reports usage, in one call.
// Each provider's usage handler returns its own `quotas` map; this flattens it into
// `windows` with a single meaning (percent used, 0–100) so external widgets can draw
// meters without knowing any provider's quirks. Served at GET /v0/quota (API key gated).
import { getProviderConnections } from "@/lib/localDb";
import { AI_PROVIDERS, USAGE_SUPPORTED_PROVIDERS } from "@/shared/constants/providers";
import { readConnectionUsage } from "@/app/api/usage/[connectionId]/route.js";

const CONCURRENCY = 4;

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// Percent used, or null for unlimited / unmeasurable rows.
function usedPercent(quota) {
  if (!quota || typeof quota !== "object" || quota.unlimited) return null;
  const remainingPct = finite(quota.remainingPercentage);
  if (remainingPct !== null) return 100 - remainingPct;
  const total = finite(quota.total);
  const used = finite(quota.used);
  if (total && total > 0 && used !== null) return (used / total) * 100;
  return null;
}

export function toWindows(quotas) {
  return Object.entries(quotas || {}).flatMap(([label, quota]) => {
    const percent = usedPercent(quota);
    if (percent === null) return [];
    const total = finite(quota.total);
    return [{
      label,
      usedPercent: Math.round(Math.max(0, Math.min(100, percent)) * 10) / 10,
      resetsAt: quota.resetAt || null,
      // Absolute counts only when they are real units, not a 0–100 scale.
      ...(total && total !== 100 ? { used: finite(quota.used), total } : {}),
    }];
  });
}

function toAccount(connection, result) {
  const usage = result.usage || {};
  const base = {
    id: connection.id,
    provider: connection.provider,
    providerName: AI_PROVIDERS[connection.provider]?.name || connection.provider,
    label: connection.name || connection.displayName || null,
    email: connection.email || null,
  };
  if (result.error) return { ...base, plan: null, windows: [], error: result.error };
  const windows = toWindows(usage.quotas);
  return {
    ...base,
    plan: typeof usage.plan === "string" ? usage.plan : null,
    windows,
    // Providers soft-fail by returning only a message (expired auth, API down).
    error: windows.length === 0 && usage.message ? String(usage.message) : null,
  };
}

async function readAccount(connection) {
  try {
    return toAccount(connection, await readConnectionUsage(connection));
  } catch (error) {
    return toAccount(connection, { error: error.message });
  }
}

export async function getQuotaSnapshot() {
  const connections = (await getProviderConnections({ isActive: true }))
    .filter((connection) => USAGE_SUPPORTED_PROVIDERS.includes(connection.provider));
  const accounts = new Array(connections.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, connections.length) }, async () => {
    while (next < connections.length) {
      const index = next++;
      accounts[index] = await readAccount(connections[index]);
    }
  }));
  // Connections whose auth type has no usage API (e.g. plain API keys) carry nothing to show.
  return {
    checkedAt: new Date().toISOString(),
    accounts: accounts.filter((account) => account.windows.length > 0 || account.error),
  };
}
