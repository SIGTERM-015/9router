import { getApiKeys } from "@/lib/db/repos/apiKeysRepo.js";
import { getProviderConnections } from "@/lib/db/repos/connectionsRepo.js";

// Resolves the raw API key and the connection id to stable ids and display names.
// The raw key never leaves the router.
const TTL_MS = 60_000;
let cache = { at: 0, keys: new Map(), connections: new Map() };

export function maskKey(key) {
  if (!key) return "";
  return key.length <= 12 ? `${key[0]}***` : `${key.slice(0, 8)}***${key.slice(-4)}`;
}

async function load() {
  if (Date.now() - cache.at < TTL_MS) return cache;
  const [keys, connections] = await Promise.all([getApiKeys(), getProviderConnections()]);
  cache = {
    at: Date.now(),
    keys: new Map(keys.map((k) => [k.key, { id: k.id, name: k.name || k.id }])),
    connections: new Map(connections.map((c) => [c.id, c.name || c.email || c.id])),
  };
  return cache;
}

export async function resolveIdentity(rawKey, connectionId) {
  const { keys, connections } = await load();
  const key = rawKey ? keys.get(rawKey) : null;
  return {
    api_key_id: key ? key.id : rawKey ? `masked:${maskKey(rawKey)}` : "",
    api_key_name: key ? key.name : rawKey ? maskKey(rawKey) : "no-key",
    connection_id: connectionId || "",
    connection_name: (connectionId && connections.get(connectionId)) || "",
  };
}

export const __test__ = { reset: () => { cache = { at: 0, keys: new Map(), connections: new Map() }; } };
