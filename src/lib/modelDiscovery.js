// Live model discovery: asks each connected account which models it can use today
// and registers the ones 9router's built-in tables do not know yet as custom models.
//
// The static tables only change with a release, so a model an upstream launches
// between releases was unroutable until someone added it by hand. Nothing is ever
// removed here: a model missing from a listing may just be hidden for that account.

import { getProviderConnections, getCustomModels, addCustomModel } from "@/lib/localDb";
import { getProviderAlias } from "@/shared/constants/providers";
import { getModelsByProviderId } from "open-sse/config/providerModels.js";
import { refreshAndUpdateCredentials } from "@/app/api/usage/[connectionId]/route.js";
import codexProvider from "open-sse/providers/registry/codex.js";

const FETCH_TIMEOUT_MS = 20000;
export const DISCOVERY_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 2 * 60 * 1000;
const RETRY_DELAY_MS = 30 * 60 * 1000;

// Listings mix chat models with embeddings, speech, image/video generation and
// robotics models. Only chat-capable ids belong in the routing table.
const NON_CHAT = /embed|tts|image|imagen|imagine|banana|veo|lyria|transcribe|voice|speech|live|native-audio|robotics|aqa|computer-use|deep-research|^sam-/i;

const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const ids = (list, pick) => (Array.isArray(list) ? list : []).map(pick).filter((id) => typeof id === "string" && id);

// provider id -> how to list its models. `oauth` accounts get their token refreshed first.
const DISCOVERERS = {
  claude: {
    oauth: true,
    url: () => "https://api.anthropic.com/v1/models?limit=100",
    headers: (c) => ({ ...bearer(c.accessToken), "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20" }),
    parse: (json) => ids(json?.data, (m) => m.id),
  },
  codex: {
    oauth: true,
    url: () => `https://chatgpt.com/backend-api/codex/models?client_version=${codexProvider.transport.cliVersion}`,
    headers: (c) => ({ ...bearer(c.accessToken), originator: "codex_cli_rs", Accept: "application/json" }),
    parse: (json) => ids(json?.models, (m) => m.slug || m.id),
  },
  xai: {
    oauth: true,
    url: () => "https://api.x.ai/v1/models",
    headers: (c) => bearer(c.accessToken),
    parse: (json) => ids(json?.data, (m) => m.id),
  },
  gemini: {
    url: () => "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
    headers: (c) => ({ "x-goog-api-key": c.apiKey }),
    parse: (json) => ids(
      (json?.models || []).filter((m) => (m.supportedGenerationMethods || []).includes("generateContent")),
      (m) => m.name?.replace(/^models\//, ""),
    ),
  },
  "opencode-go": {
    url: () => "https://opencode.ai/zen/go/v1/models",
    headers: (c) => bearer(c.apiKey),
    parse: (json) => ids(json?.data, (m) => m.id),
  },
  muse: {
    url: () => "https://api.meta.ai/v1/models",
    headers: (c) => ({ ...bearer(c.apiKey), "x-api-version": "1.0.0" }),
    parse: (json) => ids(json?.data, (m) => m.id),
  },
};

let state = { running: false, lastRun: null, lastResult: null };
let timer = null;

export function getDiscoveryState() {
  return { ...state, intervalMs: DISCOVERY_INTERVAL_MS, providers: Object.keys(DISCOVERERS) };
}

async function listLive(connection) {
  const spec = DISCOVERERS[connection.provider];
  let conn = connection;
  if (spec.oauth) {
    // A failed refresh still leaves the stored token worth one try.
    try { conn = (await refreshAndUpdateCredentials(connection)).connection; } catch { /* use stored token */ }
  }
  const response = await fetch(spec.url(conn), { headers: spec.headers(conn), signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return spec.parse(await response.json());
}

// Compare every connected account's live listing with what is already routable and,
// unless dryRun, register the difference. Returns one entry per provider.
export async function discoverModels({ dryRun = false } = {}) {
  const connections = (await getProviderConnections({ isActive: true })).filter((c) => DISCOVERERS[c.provider]);
  const custom = await getCustomModels();

  const byProvider = new Map();
  for (const connection of connections) {
    (byProvider.get(connection.provider) || byProvider.set(connection.provider, []).get(connection.provider)).push(connection);
  }

  const results = [];
  for (const [provider, accounts] of byProvider) {
    const alias = getProviderAlias(provider);
    const known = new Set([
      ...getModelsByProviderId(provider).map((m) => m.id),
      ...custom.filter((m) => m.providerAlias === alias || m.providerAlias === provider).map((m) => m.id),
    ]);

    const live = new Set();
    const errors = [];
    for (const account of accounts) {
      try {
        for (const id of await listLive(account)) live.add(id);
      } catch (error) {
        errors.push(`${account.name || account.id}: ${error.message}`);
      }
    }

    const added = [...live].filter((id) => !known.has(id) && !NON_CHAT.test(id)).sort();
    if (!dryRun) for (const id of added) await addCustomModel({ providerAlias: alias, id, type: "llm" });
    results.push({ provider, alias, accounts: accounts.length, live: live.size, added, ...(errors.length ? { errors } : {}) });
  }
  return results;
}

export async function runDiscovery(options) {
  if (state.running) return null;
  state.running = true;
  try {
    const results = await discoverModels(options);
    if (!options?.dryRun) {
      state.lastRun = Date.now();
      state.lastResult = results;
      const total = results.reduce((n, r) => n + r.added.length, 0);
      if (total) console.log(`[modelDiscovery] added ${total} models: ${results.filter((r) => r.added.length).map((r) => `${r.alias}(${r.added.length})`).join(" ")}`);
    }
    return results;
  } finally {
    state.running = false;
  }
}

// Schedule the recurring run. Disable entirely with MODEL_DISCOVERY=off.
export function startModelDiscovery() {
  if (timer) return;
  if (String(process.env.MODEL_DISCOVERY || "").toLowerCase() === "off") return;
  const schedule = (delay) => {
    timer = setTimeout(async () => {
      let ok = true;
      try { await runDiscovery(); } catch (error) { ok = false; console.log(`[modelDiscovery] failed: ${error?.message || error}`); }
      schedule(ok ? DISCOVERY_INTERVAL_MS : RETRY_DELAY_MS);
    }, delay);
    timer.unref?.();
  };
  schedule(STARTUP_DELAY_MS);
}
