import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getSettings: vi.fn(),
  readAccount: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getSettings: mocks.getSettings,
  getProxyPools: vi.fn(),
  validateApiKey: vi.fn(),
  updateProviderConnection: vi.fn(),
}));
vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(async () => ({})),
  pickProxyPoolId: vi.fn(),
}));
vi.mock("@/shared/constants/providers.js", () => ({
  FREE_PROVIDERS: {},
  resolveProviderId: (provider) => provider,
}));
vi.mock("@/lib/quotaSnapshot", () => ({ readAccount: mocks.readAccount }));
vi.mock("@/sse/utils/logger.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn() }));

const { windowApplies, pickQuotaAware, refreshAccountUsage, noteResponse, __test__ } =
  await import("@/sse/services/quotaRouting.js");
const { getProviderCredentials } = await import("@/sse/services/auth.js");
const { anthropicQuotaWindows, anthropicRejectedUntil } = await import("open-sse/utils/anthropicQuota.js");
const { parseUpstreamError } = await import("open-sse/utils/error.js");
const { DefaultExecutor } = await import("open-sse/executors/default.js");

const NOW = Date.parse("2026-11-14T15:00:00.000Z");
const at = (hours) => new Date(NOW + hours * 3600000).toISOString();
const account = (id, priority) => ({ id, name: id, provider: "claude", authType: "oauth", isActive: true, priority });
const windows = ({ session = 0, weekly = 0, weeklyResetH, fable } = {}) => [
  { label: "session (5h)", usedPercent: session, resetsAt: at(3) },
  { label: "weekly (7d)", usedPercent: weekly, resetsAt: weeklyResetH === undefined ? null : at(weeklyResetH) },
  ...(fable === undefined ? [] : [{ label: "weekly fable (7d)", usedPercent: fable, resetsAt: at(weeklyResetH ?? 100) }]),
];
// What the usage API said, read just now.
const setUsage = (id, w) => {
  __test__.state.windows.delete(id);
  __test__.recordWindows(id, w, Date.now());
  __test__.state.readAt.set(id, Date.now());
};
const clearState = () => {
  for (const map of Object.values(__test__.state)) map.clear();
};

// Rate-limit headers as Anthropic sent them to the three accounts on 2026-11-14 (probed).
const NEREA_200 = {
  "anthropic-ratelimit-unified-5h-reset": "1794671400",
  "anthropic-ratelimit-unified-5h-status": "allowed",
  "anthropic-ratelimit-unified-5h-utilization": "0.1",
  "anthropic-ratelimit-unified-7d-reset": "1794837600",
  "anthropic-ratelimit-unified-7d-status": "allowed_warning",
  "anthropic-ratelimit-unified-7d-surpassed-threshold": "0.75",
  "anthropic-ratelimit-unified-7d-utilization": "0.87",
  "anthropic-ratelimit-unified-representative-claim": "seven_day",
  "anthropic-ratelimit-unified-reset": "1794837600",
  "anthropic-ratelimit-unified-status": "allowed_warning",
};
const MAKINGSCIENCE_429 = {
  "anthropic-ratelimit-unified-5h-reset": "1794688800",
  "anthropic-ratelimit-unified-5h-status": "allowed",
  "anthropic-ratelimit-unified-5h-utilization": "0.0",
  "anthropic-ratelimit-unified-7d-reset": "1794798000",
  "anthropic-ratelimit-unified-7d-status": "rejected",
  "anthropic-ratelimit-unified-7d-surpassed-threshold": "1.0",
  "anthropic-ratelimit-unified-7d-utilization": "1.01",
  "anthropic-ratelimit-unified-representative-claim": "seven_day",
  "anthropic-ratelimit-unified-reset": "1794798000",
  "anthropic-ratelimit-unified-status": "rejected",
  "retry-after": "126726",
  "x-should-retry": "true",
};
const RATE_LIMIT_BODY = JSON.stringify({
  type: "error",
  error: { type: "rate_limit_error", message: "This request would exceed your account's rate limit. Please try again later." },
});
// Nerea a few minutes later, once her 5h window ran out.
const NEREA_5H_429 = {
  ...NEREA_200,
  "anthropic-ratelimit-unified-5h-status": "rejected",
  "anthropic-ratelimit-unified-5h-utilization": "1.0",
  "anthropic-ratelimit-unified-representative-claim": "five_hour",
  "anthropic-ratelimit-unified-reset": "1794671400",
  "anthropic-ratelimit-unified-status": "rejected",
  "retry-after": "2992",
};
const response = (status, headers) => new Response(status === 429 ? RATE_LIMIT_BODY : "{}", { status, headers });

// The three accounts as they were on 2026-11-14: one nearly spent that resets in two days,
// one exhausted until its weekly reset, one fresh that resets in four days.
const nerea = account("nerea", 1);
const aileen = account("aileen", 2);
const ms = account("makingscience", 3);

beforeEach(() => {
  vi.clearAllMocks();
  clearState();
  setUsage("nerea", windows({ session: 8, weekly: 87, weeklyResetH: 47 }));
  setUsage("aileen", windows({ session: 2, weekly: 0, weeklyResetH: 97 }));
  setUsage("makingscience", windows({ session: 0, weekly: 100, weeklyResetH: 36 }));
});

describe("windowApplies", () => {
  it.each([
    ["session (5h)", "claude-opus-5-5", true],
    ["weekly (7d)", "claude-fable-5-2", true],
    ["weekly fable (7d)", "claude-fable-5-2", true],
    ["weekly fable (7d)", "claude-opus-5-5", false],
    ["weekly opus (7d)", "claude-opus-5-5[1m]", true],
    ["spark_weekly", "gpt-6.1-spark", true],
    ["review_weekly", "gpt-6.1-sol", false],
    ["weekly", "gpt-6.1-sol", true],
  ])("%s applies to %s: %s", (label, model, expected) => {
    expect(windowApplies(label, model)).toBe(expected);
  });
});

describe("pickQuotaAware", () => {
  it("skips the exhausted account and uses the one whose weekly quota resets first", () => {
    const pick = pickQuotaAware([nerea, aileen, ms], { model: "claude-opus-5-5", now: NOW });
    expect(pick).toEqual({ connection: nerea, reason: "weekly resets in 47h" });
  });

  it("keeps a conversation on its account even when another resets sooner", () => {
    expect(pickQuotaAware([aileen], { model: "claude-opus-5-5", sessionKey: "claude:s1", now: NOW }).connection).toBe(aileen);
    const pick = pickQuotaAware([nerea, aileen, ms], { model: "claude-opus-5-5", sessionKey: "claude:s1", now: NOW });
    expect(pick).toEqual({ connection: aileen, reason: "same session" });
  });

  it("moves a conversation once its account is exhausted, and stays on the new one", () => {
    pickQuotaAware([nerea, aileen], { model: "claude-opus-5-5", sessionKey: "claude:s1", now: NOW });
    setUsage("nerea", windows({ session: 100, weekly: 90, weeklyResetH: 47 }));
    expect(pickQuotaAware([nerea, aileen, ms], { model: "claude-opus-5-5", sessionKey: "claude:s1", now: NOW }).connection).toBe(aileen);
    setUsage("nerea", windows({ session: 0, weekly: 90, weeklyResetH: 47 }));
    expect(pickQuotaAware([nerea, aileen, ms], { model: "claude-opus-5-5", sessionKey: "claude:s1", now: NOW }).connection).toBe(aileen);
  });

  it("forgets a conversation after an hour without requests", () => {
    pickQuotaAware([aileen], { model: "claude-opus-5-5", sessionKey: "claude:s1", now: NOW });
    const later = NOW + 61 * 60000;
    expect(pickQuotaAware([nerea, aileen], { model: "claude-opus-5-5", sessionKey: "claude:s1", now: later }).connection).toBe(nerea);
  });

  it("counts a model-scoped window only for that model", () => {
    setUsage("nerea", windows({ weekly: 50, weeklyResetH: 47, fable: 100 }));
    expect(pickQuotaAware([nerea, aileen], { model: "claude-fable-5-2", now: NOW }).connection).toBe(aileen);
    expect(pickQuotaAware([nerea, aileen], { model: "claude-opus-5-5", now: NOW }).connection).toBe(nerea);
  });

  it("ignores an exhausted window whose reset time has passed", () => {
    setUsage("makingscience", windows({ weekly: 100, weeklyResetH: -1 }));
    expect(pickQuotaAware([ms, aileen], { model: "claude-opus-5-5", now: NOW }).connection).toBe(aileen);
    expect(pickQuotaAware([ms], { model: "claude-opus-5-5", now: NOW }).reason).toBe("weekly resets in unknown");
  });

  it("falls back to priority order while usage is unknown", () => {
    clearState();
    expect(pickQuotaAware([nerea, aileen, ms], { model: "claude-opus-5-5", now: NOW }).connection).toBe(nerea);
  });

  it("tries the account that frees up first when every account is exhausted", () => {
    setUsage("nerea", windows({ session: 100, weekly: 90, weeklyResetH: 47 }));
    setUsage("aileen", windows({ weekly: 100, weeklyResetH: 97 }));
    const pick = pickQuotaAware([nerea, aileen, ms], { model: "claude-opus-5-5", now: NOW });
    expect(pick).toEqual({ connection: nerea, reason: "all exhausted, first frees in 3h" });
  });
});

describe("anthropic rate-limit headers", () => {
  it("reads the 5h and 7d windows of every response", () => {
    expect(anthropicQuotaWindows(new Headers(NEREA_200))).toEqual([
      { label: "session (5h)", usedPercent: 10, resetsAt: "2026-11-14T15:50:00.000Z" },
      { label: "weekly (7d)", usedPercent: 87, resetsAt: "2026-11-16T14:00:00.000Z" },
    ]);
    expect(anthropicQuotaWindows(new Headers(MAKINGSCIENCE_429))).toEqual([
      { label: "session (5h)", usedPercent: 0, resetsAt: "2026-11-14T20:40:00.000Z" },
      { label: "weekly (7d)", usedPercent: 100, resetsAt: "2026-11-16T03:00:00.000Z" },
    ]);
    expect(anthropicQuotaWindows(new Headers({ "content-type": "application/json" }))).toEqual([]);
  });

  it("counts a window as spent by its status, not its utilization", () => {
    const over = { ...NEREA_200, "anthropic-ratelimit-unified-7d-utilization": "1.02", "anthropic-ratelimit-unified-7d-status": "allowed" };
    expect(anthropicQuotaWindows(new Headers(over))[1].usedPercent).toBe(99.9);
  });

  it("gives a rejected request the reset time of the limit that rejected it", async () => {
    expect(anthropicRejectedUntil(new Headers(MAKINGSCIENCE_429))).toBe(Date.parse("2026-11-16T03:00:00.000Z"));
    expect(anthropicRejectedUntil(new Headers(NEREA_200))).toBe(null);

    const parsed = await parseUpstreamError(response(429, MAKINGSCIENCE_429), new DefaultExecutor("claude"));
    expect(parsed).toEqual({
      statusCode: 429,
      message: RATE_LIMIT_BODY,
      resetsAtMs: Date.parse("2026-11-16T03:00:00.000Z"),
    });
    const plain = await parseUpstreamError(new Response("slow down", { status: 429 }), new DefaultExecutor("claude"));
    expect(plain.resetsAtMs).toBeUndefined();
  });
});

describe("noteResponse", () => {
  // Readings are ordered by time: give every step its own millisecond.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    setUsage("nerea", windows({ session: 8, weekly: 87, weeklyResetH: 47 }));
    vi.setSystemTime(NOW + 1000);
  });
  afterEach(() => vi.useRealTimers());

  it("skips an account from the response that exhausts its 5h window on, without a usage read", () => {
    const opus = { model: "claude-opus-5-5", now: NOW };
    expect(pickQuotaAware([nerea, aileen], opus).connection).toBe(nerea);
    noteResponse(nerea, response(429, NEREA_5H_429));
    expect(pickQuotaAware([nerea, aileen], opus)).toEqual({ connection: aileen, reason: "weekly resets in 97h" });
  });

  it("keeps a header reading over a usage read that started before it", async () => {
    let finishRead;
    mocks.readAccount.mockReturnValueOnce(new Promise((resolve) => { finishRead = resolve; }));
    __test__.state.readAt.clear();
    const read = refreshAccountUsage(nerea); // the usage API still has the reading from before
    vi.setSystemTime(NOW + 2000);
    noteResponse(nerea, response(429, NEREA_5H_429));
    finishRead({ windows: windows({ session: 8, weekly: 87, weeklyResetH: 47 }) });
    await read;
    expect(pickQuotaAware([nerea, aileen], { model: "claude-opus-5-5", now: NOW }).connection).toBe(aileen);

    // A read that starts later wins again, e.g. after a reset grant refilled the window.
    mocks.readAccount.mockResolvedValueOnce({ windows: windows({ session: 0, weekly: 87, weeklyResetH: 47 }) });
    vi.setSystemTime(NOW + 5 * 60000 + 1000);
    await refreshAccountUsage(nerea);
    expect(pickQuotaAware([nerea, aileen], { model: "claude-opus-5-5", now: NOW }).connection).toBe(nerea);
  });

  it("re-reads usage a minute after a 429 that carries no quota headers", async () => {
    mocks.readAccount.mockResolvedValue({ windows: windows({ weekly: 100, weeklyResetH: 36 }) });
    __test__.state.readAt.clear();
    noteResponse(ms, response(429, {})); // never read yet: not a quota-aware account, nothing to do
    expect(mocks.readAccount).not.toHaveBeenCalled();

    await refreshAccountUsage(ms);
    vi.setSystemTime(NOW + 62000);
    noteResponse(ms, response(429, {}));
    await __test__.state.inflight.get("makingscience");
    noteResponse(ms, response(429, {}));
    noteResponse(ms, response(200, {}));
    expect(mocks.readAccount).toHaveBeenCalledTimes(2);
  });
});

describe("refreshAccountUsage", () => {
  beforeEach(() => clearState());

  it("reads usage fresh once per five minutes and keeps what is known when a read comes back empty", async () => {
    mocks.readAccount.mockResolvedValueOnce({ windows: windows({ weekly: 10, weeklyResetH: 5 }) });
    await refreshAccountUsage(nerea);
    await refreshAccountUsage(nerea);
    expect(mocks.readAccount).toHaveBeenCalledTimes(1);
    expect(mocks.readAccount).toHaveBeenCalledWith(nerea, { force: true });

    mocks.readAccount.mockResolvedValueOnce({ windows: [] });
    __test__.state.readAt.set("nerea", Date.now() - 5 * 60000);
    await refreshAccountUsage(nerea);
    expect(mocks.readAccount).toHaveBeenCalledTimes(2);
    expect(pickQuotaAware([nerea], { model: "claude-opus-5-5", now: NOW }).reason).toBe("weekly resets in 5h");
  });
});

describe("getProviderCredentials with the quota-aware strategy", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    mocks.getProviderConnections.mockResolvedValue([nerea, aileen, ms]);
    mocks.getSettings.mockResolvedValue({ providerStrategies: { claude: { fallbackStrategy: "quota-aware" } } });
    mocks.readAccount.mockResolvedValue({ windows: [] });
  });

  it("routes by quota and keeps a session on its account across retries", async () => {
    const first = await getProviderCredentials("claude", null, "claude-opus-5-5", { sessionId: "claude:abc" });
    expect(first.connectionId).toBe("nerea");

    // Nerea fails the request: the retry excludes it and the session moves to Aileen.
    const retry = await getProviderCredentials("claude", new Set(["nerea"]), "claude-opus-5-5", { sessionId: "claude:abc" });
    expect(retry.connectionId).toBe("aileen");
    const next = await getProviderCredentials("claude", null, "claude-opus-5-5", { sessionId: "claude:abc" });
    expect(next.connectionId).toBe("aileen");

    const other = await getProviderCredentials("claude", null, "claude-opus-5-5", { sessionId: "claude:other" });
    expect(other.connectionId).toBe("nerea");
    vi.useRealTimers();
  });
});
