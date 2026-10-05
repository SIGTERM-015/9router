// CLIProxyAPI management API compatibility (/v0/management/*).
// Lets usage dashboards built for CLIProxyAPI hubs (e.g. T3 Code "Usage → Limits")
// read 9router's Codex/Claude OAuth accounts. Callers authenticate with a 9router
// API key (enforced in dashboardGuard). api-call only reaches the provider quota
// endpoints below — it is not a general-purpose authenticated proxy.
import "open-sse/index.js";

import { getProviderConnections, getProviderConnectionById, updateProviderConnection } from "@/lib/localDb";
import { proxyAwareFetch } from "open-sse/utils/proxyFetch.js";
import { U } from "open-sse/services/usage/shared.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { refreshAndUpdateCredentials } from "@/app/api/usage/[connectionId]/route.js";

const TOKEN_PLACEHOLDER = "$TOKEN$";

// provider → quota endpoints api-call may reach with that account's token
const ALLOWED_URLS = {
  codex: [U("codex").url, U("codex").resetCreditsUrl, U("codex").resetCreditsConsumeUrl],
  claude: [U("claude").oauthUrl],
};

export class CompatError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function isExportable(connection) {
  return connection.authType === "oauth" && Object.hasOwn(ALLOWED_URLS, connection.provider);
}

function stripQuery(url) {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

function isAllowedUrl(provider, url) {
  let target;
  try {
    target = stripQuery(url);
  } catch {
    return false;
  }
  return ALLOWED_URLS[provider].some((allowed) => stripQuery(allowed) === target);
}

async function proxyOptionsFor(connection) {
  const config = await resolveConnectionProxyConfig(connection.providerSpecificData);
  return {
    connectionProxyEnabled: config.connectionProxyEnabled === true,
    connectionProxyUrl: config.connectionProxyUrl || "",
    connectionNoProxy: config.connectionNoProxy || "",
    vercelRelayUrl: config.vercelRelayUrl || "",
    strictProxy: false,
  };
}

async function getExportableConnection(authIndex) {
  const connection = authIndex ? await getProviderConnectionById(String(authIndex)) : null;
  if (!connection || !isExportable(connection)) {
    throw new CompatError(404, "Unknown auth_index");
  }
  return connection;
}

function toAuthFile(connection) {
  const data = connection.providerSpecificData || {};
  const accountId = data.chatgptAccountId || data.workspaceId || data.accountId;
  return {
    id: connection.id,
    auth_index: connection.id,
    provider: connection.provider,
    ...(connection.email ? { email: connection.email } : {}),
    ...(connection.name ? { label: connection.name } : {}),
    disabled: !connection.isActive,
    ...(connection.provider === "codex"
      ? {
          id_token: {
            ...(accountId ? { chatgpt_account_id: accountId } : {}),
            ...(data.chatgptPlanType ? { chatgpt_plan_type: data.chatgptPlanType } : {}),
          },
        }
      : {}),
  };
}

export async function listAuthFiles() {
  const connections = await getProviderConnections();
  return { files: connections.filter(isExportable).map(toAuthFile) };
}

function substituteToken(headers, token) {
  return Object.fromEntries(
    Object.entries(headers || {}).map(([name, value]) => [name, String(value).split(TOKEN_PLACEHOLDER).join(token)]),
  );
}

async function send(connection, { method, url, header, data }, proxyOptions) {
  const response = await proxyAwareFetch(url, {
    method,
    headers: substituteToken(header, connection.accessToken || ""),
    ...(data === undefined || method === "GET" ? {} : { body: typeof data === "string" ? data : JSON.stringify(data) }),
  }, proxyOptions);
  return { status_code: response.status, body: await response.text() };
}

export async function apiCall(input) {
  const method = String(input?.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "POST") throw new CompatError(400, "Unsupported method");
  let connection = await getExportableConnection(input?.auth_index);
  if (typeof input?.url !== "string" || !isAllowedUrl(connection.provider, input.url)) {
    throw new CompatError(403, "URL not allowed for this account");
  }

  const proxyOptions = await proxyOptionsFor(connection);
  const request = { method, url: input.url, header: input.header, data: input.data };
  try {
    connection = (await refreshAndUpdateCredentials(connection, false, proxyOptions)).connection;
  } catch (error) {
    throw new CompatError(502, `Credential refresh failed: ${error.message}`);
  }
  const first = await send(connection, request, proxyOptions);
  if (first.status_code !== 401 || !connection.refreshToken) return first;

  // Token revoked or expired early: force one refresh, then retry once.
  try {
    connection = (await refreshAndUpdateCredentials(connection, true, proxyOptions)).connection;
  } catch {
    return first;
  }
  return send(connection, request, proxyOptions);
}

// Clears 9router's routing cooldowns for the account, e.g. after a Codex reset credit
// was redeemed. testStatus "active" resets rateLimitedUntil and every modelLock_* key.
export async function resetQuota(input) {
  const connection = await getExportableConnection(input?.auth_index);
  await updateProviderConnection(connection.id, { testStatus: "active" });
  return { status: "ok" };
}
