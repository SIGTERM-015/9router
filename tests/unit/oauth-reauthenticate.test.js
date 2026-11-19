import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getStatusVariant,
  shouldShowReauthenticate,
} from "@/shared/utils/connectionStatus";

const originalDataDir = process.env.DATA_DIR;

async function setupOAuthTestContext() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-oauth-reauth-"));
  global._dbAdapter?.instance?.close?.();
  delete global._dbAdapter;
  process.env.DATA_DIR = tempDir;
  vi.resetModules();

  const exchangeTokens = vi.fn();
  const pollForToken = vi.fn();
  const startCodexProxy = vi.fn(async () => ({ success: true }));
  const registerCodexSession = vi.fn(() => true);
  const registerTraeSession = vi.fn(() => true);

  vi.doMock("next/server", () => ({
    NextResponse: {
      json(body, init = {}) {
        return new Response(JSON.stringify(body), {
          status: init.status || 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  }));

  vi.doMock("@/lib/oauth/providers", () => ({
    getProvider: vi.fn(),
    generateAuthData: vi.fn(),
    exchangeTokens,
    requestDeviceCode: vi.fn(),
    pollForToken,
    extractCodexAccountInfo: vi.fn(() => ({})),
  }));

  vi.doMock("@/lib/oauth/utils/server", async (importOriginal) => {
    const actual = await importOriginal();
    return {
      ...actual,
      startCodexProxy,
      registerCodexSession,
      registerTraeSession,
    };
  });

  const { GET, POST } = await import("@/app/api/oauth/[provider]/[action]/route.js");
  const {
    createProviderConnection,
    updateProviderConnection,
    getProviderConnectionById,
    getProviderConnections,
  } = await import("@/models/index.js");

  return {
    GET,
    POST,
    exchangeTokens,
    pollForToken,
    startCodexProxy,
    registerCodexSession,
    registerTraeSession,
    createProviderConnection,
    updateProviderConnection,
    getProviderConnectionById,
    getProviderConnections,
    cleanup() {
      global._dbAdapter?.instance?.close?.();
      delete global._dbAdapter;
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function makePostRequest(provider, action, body) {
  return new Request(`http://localhost/api/oauth/${provider}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeGetRequest(provider, action, query = "") {
  const qs = query ? `?${query}` : "";
  return new Request(`http://localhost/api/oauth/${provider}/${action}${qs}`, {
    method: "GET",
  });
}

describe("connectionStatus reauthentication visibility", () => {
  it("shows Reauthenticate only for active OAuth connections in error, expired, or unavailable state", () => {
    expect(shouldShowReauthenticate({ isOAuth: true, isActive: true, effectiveStatus: "error" })).toBe(true);
    expect(shouldShowReauthenticate({ isOAuth: true, isActive: true, effectiveStatus: "expired" })).toBe(true);
    expect(shouldShowReauthenticate({ isOAuth: true, isActive: true, effectiveStatus: "unavailable" })).toBe(true);
    expect(shouldShowReauthenticate({ isOAuth: true, isActive: undefined, effectiveStatus: "error" })).toBe(true);

    // Non-error statuses stay hidden
    expect(shouldShowReauthenticate({ isOAuth: true, isActive: true, effectiveStatus: "active" })).toBe(false);
    expect(shouldShowReauthenticate({ isOAuth: true, isActive: true, effectiveStatus: "success" })).toBe(false);
    expect(shouldShowReauthenticate({ isOAuth: true, isActive: true, effectiveStatus: "unknown" })).toBe(false);
    expect(shouldShowReauthenticate({ isOAuth: true, isActive: true, effectiveStatus: null })).toBe(false);

    // Non-OAuth and disabled connections stay hidden (matches status badge)
    expect(shouldShowReauthenticate({ isOAuth: false, isActive: true, effectiveStatus: "error" })).toBe(false);
    expect(shouldShowReauthenticate({ isOAuth: false, isActive: true, effectiveStatus: "expired" })).toBe(false);
    expect(shouldShowReauthenticate({ isOAuth: false, isActive: true, effectiveStatus: "unavailable" })).toBe(false);
    expect(shouldShowReauthenticate({ isOAuth: true, isActive: false, effectiveStatus: "error" })).toBe(false);
    expect(getStatusVariant(false, "error")).toBe("default");
    expect(getStatusVariant(true, "expired")).toBe("error");
  });
});

describe("OAuth reauthentication flow", () => {
  let ctx;

  beforeEach(async () => {
    ctx = await setupOAuthTestContext();
  });

  afterEach(() => {
    vi.doUnmock("next/server");
    vi.doUnmock("@/lib/oauth/providers");
    vi.doUnmock("@/lib/oauth/utils/server");
    vi.resetModules();
    vi.clearAllMocks();
    ctx?.cleanup();
    if (originalDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = originalDataDir;
    }
  });

  it("same-email exchange updates the existing connection with new tokens and clears error state", async () => {
    const existing = await ctx.createProviderConnection({
      provider: "claude",
      authType: "oauth",
      email: "alice@example.com",
      name: "Alice Work",
      accessToken: "stale-access-token",
      refreshToken: "stale-refresh-token",
    });

    await ctx.updateProviderConnection(existing.id, {
      testStatus: "error",
      lastError: "Token expired and refresh failed",
      errorCode: 401,
      lastErrorAt: "2026-01-01T00:00:00.000Z",
      backoffLevel: 3,
      rateLimitedUntil: "2099-01-01T00:00:00.000Z",
      modelLock_claude: "2099-01-01T00:00:00.000Z",
    });

    ctx.exchangeTokens.mockResolvedValueOnce({
      accessToken: "fresh-access-token",
      refreshToken: "fresh-refresh-token",
      expiresIn: 3600,
      email: "alice@example.com",
    });

    const res = await ctx.POST(
      makePostRequest("claude", "exchange", {
        code: "auth-code-1",
        redirectUri: "http://localhost:20128/callback",
        codeVerifier: "verifier-1",
        state: "state-1",
      }),
      { params: Promise.resolve({ provider: "claude", action: "exchange" }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.connection.id).toBe(existing.id);

    const all = await ctx.getProviderConnections({ provider: "claude" });
    expect(all).toHaveLength(1);

    const updated = await ctx.getProviderConnectionById(existing.id);
    expect(updated).toMatchObject({
      id: existing.id,
      provider: "claude",
      email: "alice@example.com",
      name: "Alice Work",
      accessToken: "fresh-access-token",
      refreshToken: "fresh-refresh-token",
      testStatus: "active",
      lastError: null,
      errorCode: null,
      lastErrorAt: null,
      backoffLevel: 0,
      rateLimitedUntil: null,
      modelLock_claude: null,
    });
  });

  it("reauthConnectionId updates the target row in place even when email is missing or differs", async () => {
    const existing = await ctx.createProviderConnection({
      provider: "codex",
      authType: "oauth",
      name: "Codex Account A",
      email: null,
      accessToken: "expired-codex-token",
      refreshToken: "expired-codex-refresh",
      providerSpecificData: {
        proxyPoolId: "pool-42",
        chatgptAccountId: "acct-old",
      },
    });

    await ctx.updateProviderConnection(existing.id, {
      testStatus: "unavailable",
      lastError: "invalid_grant",
      errorCode: 401,
      lastErrorAt: "2026-02-01T00:00:00.000Z",
      backoffLevel: 2,
      modelLock_gpt: "2099-01-01T00:00:00.000Z",
    });

    ctx.exchangeTokens.mockResolvedValueOnce({
      accessToken: "new-codex-token",
      refreshToken: "new-codex-refresh",
      expiresIn: 7200,
      email: "new-address@example.com",
      providerSpecificData: {
        chatgptAccountId: "acct-new",
        chatgptPlanType: "pro",
      },
    });

    const res = await ctx.POST(
      makePostRequest("codex", "exchange", {
        code: "codex-code",
        redirectUri: "http://localhost:1455/auth/callback",
        codeVerifier: "codex-verifier",
        state: "codex-state",
        reauthConnectionId: existing.id,
      }),
      { params: Promise.resolve({ provider: "codex", action: "exchange" }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.connection.id).toBe(existing.id);

    const all = await ctx.getProviderConnections({ provider: "codex" });
    expect(all).toHaveLength(1);

    const updated = await ctx.getProviderConnectionById(existing.id);
    expect(updated).toMatchObject({
      id: existing.id,
      provider: "codex",
      name: "Codex Account A",
      email: "new-address@example.com",
      accessToken: "new-codex-token",
      refreshToken: "new-codex-refresh",
      testStatus: "active",
      lastError: null,
      errorCode: null,
      lastErrorAt: null,
      backoffLevel: 0,
      rateLimitedUntil: null,
      modelLock_gpt: null,
      providerSpecificData: {
        proxyPoolId: "pool-42",
        chatgptAccountId: "acct-new",
        chatgptPlanType: "pro",
      },
    });
  });

  it("reauthConnectionId updates the target row during device-code poll", async () => {
    const existing = await ctx.createProviderConnection({
      provider: "github",
      authType: "oauth",
      email: "old-gh@example.com",
      accessToken: "old-gh-token",
    });

    await ctx.updateProviderConnection(existing.id, {
      testStatus: "expired",
      lastError: "Bad credentials",
      errorCode: 401,
      lastErrorAt: "2026-03-01T00:00:00.000Z",
      backoffLevel: 1,
    });

    ctx.pollForToken.mockResolvedValueOnce({
      success: true,
      tokens: {
        accessToken: "new-gh-token",
        refreshToken: "new-gh-refresh",
        expiresIn: 3600,
        email: "renamed-gh@example.com",
      },
    });

    const res = await ctx.POST(
      makePostRequest("github", "poll", {
        deviceCode: "dev-code-123",
        reauthConnectionId: existing.id,
      }),
      { params: Promise.resolve({ provider: "github", action: "poll" }) },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.connection.id).toBe(existing.id);

    const all = await ctx.getProviderConnections({ provider: "github" });
    expect(all).toHaveLength(1);

    const updated = await ctx.getProviderConnectionById(existing.id);
    expect(updated).toMatchObject({
      id: existing.id,
      accessToken: "new-gh-token",
      refreshToken: "new-gh-refresh",
      email: "renamed-gh@example.com",
      testStatus: "active",
      lastError: null,
      errorCode: null,
      lastErrorAt: null,
      backoffLevel: 0,
    });
  });

  it("forwards reauthConnectionId through codex start-proxy session registration", async () => {
    const existing = await ctx.createProviderConnection({
      provider: "codex",
      authType: "oauth",
      accessToken: "old-codex",
    });

    const res = await ctx.GET(
      makeGetRequest(
        "codex",
        "start-proxy",
        `app_port=20128&state=st-1&code_verifier=cv-1&redirect_uri=${encodeURIComponent("http://localhost:1455/auth/callback")}&reauth_connection_id=${encodeURIComponent(existing.id)}`,
      ),
      { params: Promise.resolve({ provider: "codex", action: "start-proxy" }) },
    );

    expect(res.status).toBe(200);
    expect(ctx.registerCodexSession).toHaveBeenCalledWith({
      state: "st-1",
      codeVerifier: "cv-1",
      redirectUri: "http://localhost:1455/auth/callback",
      reauthConnectionId: existing.id,
    });
  });

  it("returns 400 when reauthConnectionId belongs to a different provider and does not exchange or mutate", async () => {
    const claudeConn = await ctx.createProviderConnection({
      provider: "claude",
      authType: "oauth",
      email: "alice@example.com",
      accessToken: "claude-token-intact",
    });

    const exchangeRes = await ctx.POST(
      makePostRequest("codex", "exchange", {
        code: "some-code",
        redirectUri: "http://localhost:1455/auth/callback",
        codeVerifier: "verifier",
        state: "state",
        reauthConnectionId: claudeConn.id,
      }),
      { params: Promise.resolve({ provider: "codex", action: "exchange" }) },
    );

    expect(exchangeRes.status).toBe(400);
    expect(ctx.exchangeTokens).not.toHaveBeenCalled();

    const pollRes = await ctx.POST(
      makePostRequest("github", "poll", {
        deviceCode: "dev-code",
        reauthConnectionId: claudeConn.id,
      }),
      { params: Promise.resolve({ provider: "github", action: "poll" }) },
    );

    expect(pollRes.status).toBe(400);
    expect(ctx.pollForToken).not.toHaveBeenCalled();

    const proxyRes = await ctx.GET(
      makeGetRequest(
        "codex",
        "start-proxy",
        `app_port=20128&state=st-2&code_verifier=cv-2&redirect_uri=http://localhost:1455/auth/callback&reauth_connection_id=${encodeURIComponent(claudeConn.id)}`,
      ),
      { params: Promise.resolve({ provider: "codex", action: "start-proxy" }) },
    );

    expect(proxyRes.status).toBe(400);
    expect(ctx.startCodexProxy).not.toHaveBeenCalled();

    const regRes = await ctx.POST(
      makePostRequest("trae", "register-session", {
        state: "trae-state",
        reauthConnectionId: claudeConn.id,
      }),
      { params: Promise.resolve({ provider: "trae", action: "register-session" }) },
    );

    expect(regRes.status).toBe(400);
    expect(ctx.registerTraeSession).not.toHaveBeenCalled();

    const intact = await ctx.getProviderConnectionById(claudeConn.id);
    expect(intact.accessToken).toBe("claude-token-intact");
  });

  it("returns 404 when reauthConnectionId does not exist and 400 for non-OAuth connections", async () => {
    const missingRes = await ctx.POST(
      makePostRequest("claude", "exchange", {
        code: "code",
        redirectUri: "http://localhost:20128/callback",
        codeVerifier: "verifier",
        state: "state",
        reauthConnectionId: "does-not-exist",
      }),
      { params: Promise.resolve({ provider: "claude", action: "exchange" }) },
    );
    expect(missingRes.status).toBe(404);
    expect(ctx.exchangeTokens).not.toHaveBeenCalled();

    const apiKeyConn = await ctx.createProviderConnection({
      provider: "claude",
      authType: "apikey",
      apiKey: "sk-ant-test",
    });

    const wrongTypeRes = await ctx.POST(
      makePostRequest("claude", "exchange", {
        code: "code",
        redirectUri: "http://localhost:20128/callback",
        codeVerifier: "verifier",
        state: "state",
        reauthConnectionId: apiKeyConn.id,
      }),
      { params: Promise.resolve({ provider: "claude", action: "exchange" }) },
    );
    expect(wrongTypeRes.status).toBe(400);
    expect(ctx.exchangeTokens).not.toHaveBeenCalled();
  });

  it("saveOAuthConnection updates only the targeted Codex row when multiple accounts exist", async () => {
    const first = await ctx.createProviderConnection({
      provider: "codex",
      authType: "oauth",
      name: "Account 1",
      email: "first@example.com",
      accessToken: "token-1",
      providerSpecificData: { chatgptAccountId: "acct-1" },
    });
    const second = await ctx.createProviderConnection({
      provider: "codex",
      authType: "oauth",
      name: "Account 2",
      email: "second@example.com",
      accessToken: "token-2-expired",
      providerSpecificData: { chatgptAccountId: "acct-2", proxyPoolId: "pool-9" },
    });
    await ctx.updateProviderConnection(second.id, {
      testStatus: "error",
      lastError: "refresh_token_reused",
      errorCode: 401,
      lastErrorAt: "2026-04-01T00:00:00.000Z",
      backoffLevel: 2,
    });

    const { saveOAuthConnection } = await import("@/lib/oauth/utils/reauth.js");
    const updated = await saveOAuthConnection({
      provider: "codex",
      authType: "oauth",
      accessToken: "token-2-fresh",
      refreshToken: "refresh-2-fresh",
      email: "second-updated@example.com",
      providerSpecificData: { chatgptAccountId: "acct-2-rotated" },
      testStatus: "active",
    }, second.id);

    expect(updated.id).toBe(second.id);

    const all = await ctx.getProviderConnections({ provider: "codex" });
    expect(all).toHaveLength(2);

    const untouched = await ctx.getProviderConnectionById(first.id);
    expect(untouched.accessToken).toBe("token-1");

    const refreshed = await ctx.getProviderConnectionById(second.id);
    expect(refreshed).toMatchObject({
      id: second.id,
      name: "Account 2",
      email: "second-updated@example.com",
      accessToken: "token-2-fresh",
      refreshToken: "refresh-2-fresh",
      testStatus: "active",
      lastError: null,
      errorCode: null,
      lastErrorAt: null,
      backoffLevel: 0,
      providerSpecificData: {
        proxyPoolId: "pool-9",
        chatgptAccountId: "acct-2-rotated",
      },
    });
  });
});
