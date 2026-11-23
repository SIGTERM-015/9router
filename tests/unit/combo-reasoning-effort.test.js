import { beforeEach, describe, expect, it, vi } from "vitest";

const proxyAwareFetch = vi.hoisted(() => vi.fn());
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));

const db = vi.hoisted(() => ({
  getSettings: vi.fn(async () => ({ requireApiKey: false, comboStrategy: "fallback" })),
  getComboByName: vi.fn(),
  getModelAliases: vi.fn(async () => ({})),
  getProviderNodes: vi.fn(async () => []),
  getProviderConnections: vi.fn(async () => []),
  getApiKeyByKey: vi.fn(async () => null),
}));
vi.mock("@/lib/localDb", () => db);

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
}));

const auth = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false })),
  clearAccountError: vi.fn(async () => {}),
  extractApiKey: vi.fn(() => null),
  isValidApiKey: vi.fn(async () => true),
}));
vi.mock("../../src/sse/services/auth.js", () => auth);

vi.mock("../../src/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: vi.fn(async () => {}),
  checkAndRefreshToken: vi.fn(async (_provider, creds) => creds),
}));

vi.mock("../../src/sse/services/keyAccess.js", () => ({
  getKeyAccessContext: vi.fn(async () => null),
  enforceKeyAccess: vi.fn(async () => null),
  filterAdapterModels: vi.fn(async (_ctx, models) => models),
}));

const { POST } = await import("../../src/app/api/v1/chat/completions/route.js");

const ENTERPRISE_LICENSE = {
  userTier: "gcp-ge-plus-tier",
  tierDisplayName: "Gemini Enterprise Plus",
  projectId: "acme-proj",
  location: "eu",
};

function geminiJsonResponse(text) {
  return new Response(JSON.stringify({
    candidates: [{
      content: { role: "model", parts: [{ text }] },
      finishReason: "STOP",
    }],
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function postComboChat(body) {
  return POST(new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

beforeEach(() => {
  proxyAwareFetch.mockReset();
  db.getComboByName.mockReset();
  auth.getProviderCredentials.mockReset();
  auth.markAccountUnavailable.mockReset();
  auth.markAccountUnavailable.mockResolvedValue({ shouldFallback: false });
});

describe("combo /v1/chat/completions reasoning_effort propagation", () => {
  it("propagates reasoning_effort through combo fallback to both antigravity-enterprise and gemini seats", async () => {
    db.getComboByName.mockResolvedValue({
      name: "gemini-4-neon",
      models: ["age/gemini-4-neon", "gemini/gemini-4-neon"],
    });

    auth.getProviderCredentials.mockImplementation(async (provider) => {
      if (provider === "antigravity-enterprise") {
        return {
          connectionId: "conn-age",
          connectionName: "age-1",
          accessToken: "tok-age",
          projectId: "acme-proj",
          providerSpecificData: { enterpriseLicense: ENTERPRISE_LICENSE },
        };
      }
      if (provider === "gemini") {
        return {
          connectionId: "conn-gem",
          connectionName: "gem-1",
          apiKey: "key-gem",
          providerSpecificData: {},
        };
      }
      return null;
    });

    // First seat (age) returns 400 (request-scoped, no retry delay) so combo falls back immediately to second seat (gemini).
    proxyAwareFetch.mockImplementation(async (url) => {
      if (String(url).includes("businessaicode")) {
        return new Response(JSON.stringify({ error: { message: "Request validation failed" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return geminiJsonResponse("ok from gemini");
    });

    const res = await postComboChat({
      model: "gemini-4-neon",
      stream: false,
      reasoning_effort: "xhigh",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(res.status).toBe(200);
    // Both seats were called: the first (age) answers 400, so the request falls back to gemini.
    const ageCall = proxyAwareFetch.mock.calls.find(([url]) => String(url).includes("businessaicode"));
    const geminiCall = proxyAwareFetch.mock.calls.find(([url]) => String(url).includes("generativelanguage.googleapis.com"));
    expect(ageCall).toBeDefined();
    expect(geminiCall).toBeDefined();

    const agePayload = JSON.parse(ageCall[1].body);
    expect(agePayload.model).toBe("gemini-4-neon-xhigh");
    expect(agePayload.generationConfig.thinkingConfig).toEqual({
      thinkingLevel: "xhigh",
      includeThoughts: true,
    });
    expect(agePayload).not.toHaveProperty("reasoning_effort");

    const geminiPayload = JSON.parse(geminiCall[1].body);
    expect(geminiPayload.generationConfig.thinkingConfig).toEqual({
      thinkingLevel: "xhigh",
      includeThoughts: true,
    });
    expect(geminiPayload).not.toHaveProperty("reasoning_effort");
  });

  it("maps lower reasoning_effort on age/gemini-4-neon to the matching enterprise experience and thinkingLevel", async () => {
    db.getComboByName.mockResolvedValue({
      name: "gemini-4-neon",
      models: ["age/gemini-4-neon"],
    });

    auth.getProviderCredentials.mockResolvedValue({
      connectionId: "conn-age",
      connectionName: "age-1",
      accessToken: "tok-age",
      projectId: "acme-proj",
      providerSpecificData: { enterpriseLicense: ENTERPRISE_LICENSE },
    });

    proxyAwareFetch.mockResolvedValueOnce(geminiJsonResponse("ok from age"));

    const res = await postComboChat({
      model: "gemini-4-neon",
      stream: false,
      reasoning_effort: "low",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(res.status).toBe(200);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    const [url, init] = proxyAwareFetch.mock.calls[0];
    expect(url).toContain("businessaicode.eu.rep.googleapis.com");
    const payload = JSON.parse(init.body);
    expect(payload.model).toBe("gemini-4-neon-low");
    expect(payload.generationConfig.thinkingConfig).toEqual({
      thinkingLevel: "low",
      includeThoughts: true,
    });
    expect(payload).not.toHaveProperty("reasoning_effort");
  });

  it("propagates reasoning_effort to antigravity consumer seat and translates to thinkingConfig", async () => {
    db.getComboByName.mockResolvedValue({
      name: "gemini-4-neon",
      models: ["ag/gemini-4-neon"],
    });

    auth.getProviderCredentials.mockResolvedValue({
      connectionId: "conn-ag",
      connectionName: "ag-1",
      accessToken: "tok-ag",
      projectId: "consumer-proj",
      providerSpecificData: {},
    });

    proxyAwareFetch.mockResolvedValueOnce(geminiJsonResponse("ok from ag"));

    const res = await postComboChat({
      model: "gemini-4-neon",
      stream: false,
      reasoning_effort: "xhigh",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(res.status).toBe(200);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(proxyAwareFetch.mock.calls[0][1].body);
    expect(payload.model).toBe("gemini-4-neon-xhigh");
    expect(payload.request.generationConfig.thinkingConfig).toEqual({
      thinkingLevel: "xhigh",
      includeThoughts: true,
    });
  });
});
