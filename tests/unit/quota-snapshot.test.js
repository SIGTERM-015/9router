import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  connections: [],
  readConnectionUsage: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(async (filter) => mocks.connections.filter((c) => !filter?.isActive || c.isActive)),
}));
vi.mock("@/shared/constants/providers", () => ({
  AI_PROVIDERS: { kimi: { name: "Kimi" }, github: { name: "GitHub Copilot" } },
  USAGE_SUPPORTED_PROVIDERS: ["kimi", "github", "glm"],
}));
vi.mock("@/app/api/usage/[connectionId]/route.js", () => ({
  readConnectionUsage: mocks.readConnectionUsage,
}));

const { getQuotaSnapshot, toWindows } = await import("../../src/lib/quotaSnapshot.js");

const kimi = { id: "k1", provider: "kimi", name: "kimi main", email: "k@example.com", isActive: true };
const copilot = { id: "g1", provider: "github", isActive: true };
const glmKey = { id: "z1", provider: "glm", isActive: true };
const disabled = { id: "k2", provider: "kimi", isActive: false };
const noUsage = { id: "o1", provider: "openai", isActive: true };

describe("quota snapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connections = [kimi, copilot, glmKey, disabled, noUsage];
    mocks.readConnectionUsage.mockImplementation(async (connection) => ({
      k1: {
        usage: {
          plan: "Moderato",
          quotas: {
            weekly: { used: 40, total: 100, remainingPercentage: 60, resetAt: "2026-10-10T00:00:00.000Z" },
          },
        },
      },
      g1: {
        usage: {
          plan: "individual",
          quotas: {
            chat: { used: 0, total: 0, unlimited: true },
            premium_interactions: { used: 75, total: 300, remaining: 225, resetAt: null },
          },
        },
      },
      z1: { usage: { message: "Usage not available for this connection" } },
    })[connection.id]);
  });

  it("reports every active usage-capable account with windows as percent used", async () => {
    const snapshot = await getQuotaSnapshot();

    expect(snapshot.accounts).toEqual([
      {
        id: "k1",
        provider: "kimi",
        providerName: "Kimi",
        label: "kimi main",
        email: "k@example.com",
        plan: "Moderato",
        windows: [{ label: "weekly", usedPercent: 40, resetsAt: "2026-10-10T00:00:00.000Z" }],
        error: null,
      },
      {
        id: "g1",
        provider: "github",
        providerName: "GitHub Copilot",
        label: null,
        email: null,
        plan: "individual",
        windows: [{ label: "premium_interactions", usedPercent: 25, resetsAt: null, used: 75, total: 300 }],
        error: null,
      },
      {
        id: "z1",
        provider: "glm",
        providerName: "glm",
        label: null,
        email: null,
        plan: null,
        windows: [],
        error: "Usage not available for this connection",
      },
    ]);
    expect(mocks.readConnectionUsage).toHaveBeenCalledTimes(3);
  });

  it("keeps a failing account with its error instead of failing the snapshot", async () => {
    mocks.connections = [kimi, copilot];
    mocks.readConnectionUsage.mockImplementation(async (connection) => {
      if (connection.id === "k1") return { error: "Credential refresh failed: revoked", status: 401 };
      throw new Error("boom");
    });

    const snapshot = await getQuotaSnapshot();

    expect(snapshot.accounts.map((a) => [a.id, a.error])).toEqual([
      ["k1", "Credential refresh failed: revoked"],
      ["g1", "boom"],
    ]);
  });

  it("clamps and rounds percentages and skips unmeasurable rows", () => {
    expect(toWindows({
      over: { remainingPercentage: -5 },
      precise: { used: 1, total: 3 },
      empty: { used: 0, total: 0 },
      junk: "n/a",
    })).toEqual([
      { label: "over", usedPercent: 100, resetsAt: null },
      { label: "precise", usedPercent: 33.3, resetsAt: null, used: 1, total: 3 },
    ]);
  });
});
