import { beforeEach, describe, expect, it, vi } from "vitest";

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

const { windowApplies, pickQuotaAware, refreshAccountUsage, noteRateLimited, __test__ } =
  await import("@/sse/services/quotaRouting.js");
const { getProviderCredentials } = await import("@/sse/services/auth.js");

const NOW = Date.parse("2026-11-14T15:00:00.000Z");
const at = (hours) => new Date(NOW + hours * 3600000).toISOString();
const account = (id, priority) => ({ id, name: id, provider: "claude", authType: "oauth", isActive: true, priority });
const windows = ({ session = 0, weekly = 0, weeklyResetH, fable } = {}) => [
  { label: "session (5h)", usedPercent: session, resetsAt: at(3) },
  { label: "weekly (7d)", usedPercent: weekly, resetsAt: weeklyResetH === undefined ? null : at(weeklyResetH) },
  ...(fable === undefined ? [] : [{ label: "weekly fable (7d)", usedPercent: fable, resetsAt: at(weeklyResetH ?? 100) }]),
];
const setUsage = (id, w) => __test__.state.usage.set(id, { windows: w, attemptedAt: Date.now() });

// The three accounts as they were on 2026-11-14: one nearly spent that resets in two days,
// one exhausted until its weekly reset, one fresh that resets in four days.
const nerea = account("nerea", 1);
const aileen = account("aileen", 2);
const ms = account("makingscience", 3);

beforeEach(() => {
  vi.clearAllMocks();
  __test__.state.usage.clear();
  __test__.state.inflight.clear();
  __test__.state.sessions.clear();
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
    __test__.state.usage.clear();
    expect(pickQuotaAware([nerea, aileen, ms], { model: "claude-opus-5-5", now: NOW }).connection).toBe(nerea);
  });

  it("tries the account that frees up first when every account is exhausted", () => {
    setUsage("nerea", windows({ session: 100, weekly: 90, weeklyResetH: 47 }));
    setUsage("aileen", windows({ weekly: 100, weeklyResetH: 97 }));
    const pick = pickQuotaAware([nerea, aileen, ms], { model: "claude-opus-5-5", now: NOW });
    expect(pick).toEqual({ connection: nerea, reason: "all exhausted, first frees in 3h" });
  });
});

describe("refreshAccountUsage", () => {
  beforeEach(() => __test__.state.usage.clear());

  it("reads usage once per five minutes and keeps the last windows when a read comes back empty", async () => {
    mocks.readAccount.mockResolvedValueOnce({ windows: windows({ weekly: 10, weeklyResetH: 5 }) });
    await refreshAccountUsage(nerea);
    await refreshAccountUsage(nerea);
    expect(mocks.readAccount).toHaveBeenCalledTimes(1);
    expect(mocks.readAccount).toHaveBeenCalledWith(nerea, { force: false });

    mocks.readAccount.mockResolvedValueOnce({ windows: [] });
    __test__.state.usage.get("nerea").attemptedAt -= 5 * 60000;
    await refreshAccountUsage(nerea);
    expect(__test__.state.usage.get("nerea").windows).toEqual(windows({ weekly: 10, weeklyResetH: 5 }));
  });

  it("re-reads an account's usage after a 429 at most once a minute", async () => {
    mocks.readAccount.mockResolvedValue({ windows: windows({ weekly: 100, weeklyResetH: 36 }) });
    noteRateLimited(ms); // never read yet: not a quota-aware account, nothing to do
    expect(mocks.readAccount).not.toHaveBeenCalled();

    await refreshAccountUsage(ms);
    __test__.state.usage.get("makingscience").attemptedAt -= 61000;
    noteRateLimited(ms);
    await __test__.state.inflight.get("makingscience");
    noteRateLimited(ms);
    expect(mocks.readAccount).toHaveBeenCalledTimes(2);
    expect(mocks.readAccount).toHaveBeenLastCalledWith(ms, { force: true });
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
