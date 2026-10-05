import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  connections: [],
  updateProviderConnection: vi.fn(),
  refreshAndUpdateCredentials: vi.fn(),
  proxyAwareFetch: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(async () => mocks.connections),
  getProviderConnectionById: vi.fn(async (id) => mocks.connections.find((c) => c.id === id) || null),
  updateProviderConnection: mocks.updateProviderConnection,
}));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.proxyAwareFetch }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: vi.fn(async () => ({})) }));
vi.mock("@/app/api/usage/[connectionId]/route.js", () => ({
  refreshAndUpdateCredentials: mocks.refreshAndUpdateCredentials,
}));

const { listAuthFiles, apiCall, resetQuota } = await import("../../src/lib/cliproxyCompat.js");

const codex = {
  id: "codex-1",
  provider: "codex",
  authType: "oauth",
  email: "a@example.com",
  isActive: true,
  accessToken: "codex-token",
  refreshToken: "codex-refresh",
  providerSpecificData: { chatgptAccountId: "acct-1", chatgptPlanType: "pro" },
};
const claude = {
  id: "claude-1",
  provider: "claude",
  authType: "oauth",
  email: "b@example.com",
  isActive: false,
  accessToken: "claude-token",
};
const glmKey = { id: "glm-1", provider: "glm", authType: "apikey", isActive: true, apiKey: "k" };
const claudeKey = { id: "claude-key", provider: "claude", authType: "apikey", isActive: true, apiKey: "k" };

function upstream(status, body) {
  return { status, text: async () => JSON.stringify(body) };
}

describe("CLIProxyAPI compat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connections = [codex, claude, glmKey, claudeKey];
    mocks.refreshAndUpdateCredentials.mockImplementation(async (connection) => ({ connection, refreshed: false }));
  });

  it("lists only Codex and Claude OAuth accounts in auth-files shape", async () => {
    expect(await listAuthFiles()).toEqual({
      files: [
        {
          id: "codex-1",
          auth_index: "codex-1",
          provider: "codex",
          email: "a@example.com",
          disabled: false,
          id_token: { chatgpt_account_id: "acct-1", chatgpt_plan_type: "pro" },
        },
        { id: "claude-1", auth_index: "claude-1", provider: "claude", email: "b@example.com", disabled: true },
      ],
    });
  });

  it("forwards a quota read with the account token substituted", async () => {
    mocks.proxyAwareFetch.mockResolvedValue(upstream(200, { plan_type: "pro" }));

    const result = await apiCall({
      auth_index: "codex-1",
      method: "GET",
      url: "https://chatgpt.com/backend-api/wham/usage",
      header: { Authorization: "Bearer $TOKEN$", "Chatgpt-Account-Id": "acct-1" },
    });

    expect(result).toEqual({ status_code: 200, body: '{"plan_type":"pro"}' });
    expect(mocks.proxyAwareFetch).toHaveBeenCalledWith(
      "https://chatgpt.com/backend-api/wham/usage",
      { method: "GET", headers: { Authorization: "Bearer codex-token", "Chatgpt-Account-Id": "acct-1" } },
      expect.any(Object),
    );
  });

  it("sends POST data verbatim for reset-credit consumption", async () => {
    mocks.proxyAwareFetch.mockResolvedValue(upstream(200, { code: "reset" }));

    await apiCall({
      auth_index: "codex-1",
      method: "POST",
      url: "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
      header: { Authorization: "Bearer $TOKEN$" },
      data: '{"credit_id":"c1"}',
    });

    expect(mocks.proxyAwareFetch.mock.calls[0][1].body).toBe('{"credit_id":"c1"}');
  });

  it("allows the Claude OAuth usage URL with query parameters", async () => {
    mocks.proxyAwareFetch.mockResolvedValue(upstream(200, {}));

    const result = await apiCall({
      auth_index: "claude-1",
      url: "https://api.anthropic.com/api/oauth/usage?cedar_ember=1",
      header: { Authorization: "Bearer $TOKEN$" },
    });

    expect(result.status_code).toBe(200);
  });

  it("refuses URLs outside the account's quota endpoints", async () => {
    await expect(apiCall({ auth_index: "codex-1", url: "https://api.anthropic.com/api/oauth/usage" }))
      .rejects.toMatchObject({ status: 403 });
    await expect(apiCall({ auth_index: "claude-1", url: "https://evil.example/api/oauth/usage" }))
      .rejects.toMatchObject({ status: 403 });
    expect(mocks.proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("refuses accounts that are not exported", async () => {
    await expect(apiCall({ auth_index: "claude-key", url: "https://api.anthropic.com/api/oauth/usage" }))
      .rejects.toMatchObject({ status: 404 });
    await expect(resetQuota({ auth_index: "missing" })).rejects.toMatchObject({ status: 404 });
  });

  it("force-refreshes and retries once when the provider answers 401", async () => {
    mocks.refreshAndUpdateCredentials.mockImplementation(async (connection, force) => ({
      connection: force ? { ...connection, accessToken: "fresh-token" } : connection,
      refreshed: force,
    }));
    mocks.proxyAwareFetch
      .mockResolvedValueOnce(upstream(401, {}))
      .mockResolvedValueOnce(upstream(200, { ok: true }));

    const result = await apiCall({
      auth_index: "codex-1",
      url: "https://chatgpt.com/backend-api/wham/usage",
      header: { Authorization: "Bearer $TOKEN$" },
    });

    expect(result).toEqual({ status_code: 200, body: '{"ok":true}' });
    expect(mocks.proxyAwareFetch.mock.calls[1][1].headers.Authorization).toBe("Bearer fresh-token");
  });

  it("reset-quota clears the account's routing cooldowns", async () => {
    expect(await resetQuota({ auth_index: "codex-1" })).toEqual({ status: "ok" });
    expect(mocks.updateProviderConnection).toHaveBeenCalledWith("codex-1", { testStatus: "active" });
  });
});
