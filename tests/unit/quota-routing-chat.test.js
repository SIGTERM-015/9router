// Quota-aware routing through the real chat handler: a Claude response's rate-limit headers
// reach the account picker, so an account whose 5h window just ran out is not tried again
// until the window resets, even once its 429 lock (2s backoff, or the reset time capped at
// 30 minutes) has expired.
import { beforeEach, describe, expect, it, vi } from "vitest";

const NOW = Date.parse("2026-11-14T15:00:00.000Z");
const HOUR = 3600000;

const mocks = vi.hoisted(() => ({
  connections: [],
  updates: [],
  handleChatCore: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => ({ requireApiKey: false, providerStrategies: { claude: { fallbackStrategy: "quota-aware" } } }),
  getProviderConnections: async () => mocks.connections,
  updateProviderConnection: async (id, patch) => {
    mocks.updates.push({ id, patch });
    Object.assign(mocks.connections.find((c) => c.id === id), patch);
  },
  getProxyPools: async () => [],
  validateApiKey: async () => true,
  getModelAliases: async () => ({}),
  getComboByName: async () => null,
  getCombos: async () => [],
  getProviderNodes: async () => [],
  getProviderConnectionById: async () => null,
  getCustomModels: async () => [],
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: async () => ({}) }));
vi.mock("@/lib/db/repos/combosRepo.js", () => ({ getCombos: async () => [] }));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({ getApiKeyByKey: async () => null }));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: vi.fn() }));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
  pickProxyPoolId: vi.fn(),
}));
vi.mock("@/lib/quotaSnapshot", () => ({ readAccount: vi.fn(async () => ({ windows: [] })) }));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_p, c) => c,
  updateProviderCredentials: vi.fn(),
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.handleChatCore }));

const { handleChat } = await import("../../src/sse/handlers/chat.js");
const { __test__ } = await import("../../src/sse/services/quotaRouting.js");

const account = (id, priority) => ({ id, name: id, provider: "claude", authType: "oauth", accessToken: `t-${id}`, isActive: true, priority });
const epoch = (ms) => String(Math.round(ms / 1000));
const quotaHeaders = ({ fiveHour, fiveHourStatus = "allowed", fiveHourReset }) => ({
  "anthropic-ratelimit-unified-5h-utilization": String(fiveHour),
  "anthropic-ratelimit-unified-5h-status": fiveHourStatus,
  "anthropic-ratelimit-unified-5h-reset": epoch(fiveHourReset),
  "anthropic-ratelimit-unified-7d-utilization": "0.5",
  "anthropic-ratelimit-unified-7d-status": "allowed",
  "anthropic-ratelimit-unified-7d-reset": epoch(NOW + 47 * HOUR),
  "anthropic-ratelimit-unified-status": fiveHourStatus,
  "anthropic-ratelimit-unified-reset": epoch(fiveHourReset),
});
// One Claude Code request (it sends its session id in a header).
const send = (session) => handleChat(new Request("http://localhost/v1/messages", {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-claude-code-session-id": session },
  body: JSON.stringify({ model: "claude/claude-opus-5-5", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
}));
const accountsTried = () => mocks.handleChatCore.mock.calls.map(([args]) => args.connectionId);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  for (const map of Object.values(__test__.state)) map.clear();
  mocks.connections = [account("nerea", 1), account("aileen", 2)];
  mocks.updates = [];
  mocks.handleChatCore.mockReset();
});

describe("quota-aware routing through handleChat", () => {
  it("moves off an account whose 5h window ran out and keeps it off until the window resets", async () => {
    const reset = NOW + 20 * 60000;
    mocks.handleChatCore.mockImplementation(async ({ connectionId }) => {
      if (connectionId === "nerea") {
        const headers = { ...quotaHeaders({ fiveHour: 1, fiveHourStatus: "rejected", fiveHourReset: reset }), "retry-after": "3000" };
        return {
          success: false, status: 429, error: "rate limited", resetsAtMs: reset,
          response: new Response("{}", { status: 429, headers }),
        };
      }
      return { success: true, response: new Response("{}", { status: 200, headers: quotaHeaders({ fiveHour: 0.2, fiveHourReset: NOW + 4 * HOUR }) }) };
    });

    expect((await send("s1")).status).toBe(200);
    expect(accountsTried()).toEqual(["nerea", "aileen"]);
    const lock = mocks.updates.find((u) => u.id === "nerea").patch["modelLock_claude-opus-5-5"];
    expect(lock).toBe(new Date(reset).toISOString());

    // Without the lock, the router still knows the 5h window is spent, and the session
    // stays on Aileen.
    mocks.connections[0]["modelLock_claude-opus-5-5"] = null;
    mocks.handleChatCore.mockClear();
    expect((await send("s1")).status).toBe(200);
    expect(accountsTried()).toEqual(["aileen"]);

    // A new conversation too: Nerea resets first weekly, but her 5h window is spent.
    mocks.handleChatCore.mockClear();
    expect((await send("s2")).status).toBe(200);
    expect(accountsTried()).toEqual(["aileen"]);

    // Once the window resets, new conversations go back to Nerea.
    vi.setSystemTime(reset + 1000);
    mocks.handleChatCore.mockClear();
    mocks.handleChatCore.mockImplementation(async () => ({ success: true, response: new Response("{}", { status: 200 }) }));
    expect((await send("s3")).status).toBe(200);
    expect(accountsTried()).toEqual(["nerea"]);
  });
});
