import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  connections: [],
  custom: [],
  addCustomModel: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: vi.fn(async () => mocks.connections),
  getCustomModels: vi.fn(async () => mocks.custom),
  addCustomModel: mocks.addCustomModel,
}));
vi.mock("@/shared/constants/providers", () => ({
  getProviderAlias: (id) => ({ claude: "cc", codex: "cx" })[id] || id,
}));
vi.mock("open-sse/config/providerModels.js", () => ({
  getModelsByProviderId: (id) => ({
    claude: [{ id: "claude-opus-5-5" }],
    gemini: [{ id: "gemini-3.5-flash" }],
  })[id] || [],
}));
vi.mock("@/app/api/usage/[connectionId]/route.js", () => ({ refreshAndUpdateCredentials: mocks.refresh }));
vi.mock("open-sse/providers/registry/codex.js", () => ({ default: { transport: { cliVersion: "0.130.0" } } }));

const { discoverModels } = await import("../../src/lib/modelDiscovery.js");

const claude = { id: "c1", provider: "claude", name: "main", accessToken: "tok", isActive: true };
const gemini = { id: "g1", provider: "gemini", name: "key", apiKey: "k", isActive: true };

function listing(map) {
  return vi.fn(async (url) => {
    const entry = Object.entries(map).find(([prefix]) => String(url).startsWith(prefix));
    if (!entry) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => entry[1] };
  });
}

describe("model discovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connections = [claude, gemini];
    mocks.custom = [];
    mocks.refresh.mockImplementation(async (connection) => ({ connection, refreshed: false }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("registers only models the tables and custom models do not already have", async () => {
    mocks.custom = [{ providerAlias: "cc", id: "claude-opus-5" }];
    vi.stubGlobal("fetch", listing({
      "https://api.anthropic.com": { data: [{ id: "claude-opus-5-5" }, { id: "claude-opus-5" }, { id: "claude-fable-5-1" }] },
      "https://generativelanguage.googleapis.com": {
        models: [
          { name: "models/gemini-3.5-flash", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] },
        ],
      },
    }));

    const results = await discoverModels();

    expect(results).toEqual([
      { provider: "claude", alias: "cc", accounts: 1, live: 3, added: ["claude-fable-5-1"] },
      { provider: "gemini", alias: "gemini", accounts: 1, live: 2, added: ["gemini-3.8-flash"] },
    ]);
    expect(mocks.addCustomModel).toHaveBeenCalledWith({ providerAlias: "cc", id: "claude-fable-5-1", type: "llm" });
    expect(mocks.addCustomModel).toHaveBeenCalledWith({ providerAlias: "gemini", id: "gemini-3.8-flash", type: "llm" });
    expect(mocks.addCustomModel).toHaveBeenCalledTimes(2);
  });

  it("dry run reports the difference without writing", async () => {
    mocks.connections = [claude];
    vi.stubGlobal("fetch", listing({ "https://api.anthropic.com": { data: [{ id: "claude-fable-5-1" }] } }));

    const [result] = await discoverModels({ dryRun: true });

    expect(result.added).toEqual(["claude-fable-5-1"]);
    expect(mocks.addCustomModel).not.toHaveBeenCalled();
  });

  it("skips embeddings, media and realtime models and gemini models that cannot chat", async () => {
    mocks.connections = [gemini];
    vi.stubGlobal("fetch", listing({
      "https://generativelanguage.googleapis.com": {
        models: [
          { name: "models/gemini-3.9-flash", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-3.9-flash-tts", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-3.8-live", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-embedding-2", supportedGenerationMethods: ["embedContent"] },
          { name: "models/veo-4", supportedGenerationMethods: ["predictLongRunning"] },
          { name: "models/nano-banana-pro-preview", supportedGenerationMethods: ["generateContent"] },
        ],
      },
    }));

    const [result] = await discoverModels();

    expect(result.added).toEqual(["gemini-3.9-flash"]);
  });

  it("keeps going when one provider fails and reports the error", async () => {
    vi.stubGlobal("fetch", listing({
      "https://generativelanguage.googleapis.com": {
        models: [{ name: "models/gemini-3.9-flash", supportedGenerationMethods: ["generateContent"] }],
      },
    }));

    const results = await discoverModels();

    expect(results[0]).toMatchObject({ provider: "claude", live: 0, added: [], errors: ["main: HTTP 404"] });
    expect(results[1].added).toEqual(["gemini-3.9-flash"]);
  });

  it("uses the stored token when refreshing an oauth account fails", async () => {
    mocks.connections = [claude];
    mocks.refresh.mockRejectedValue(new Error("refresh failed"));
    const fetchMock = listing({ "https://api.anthropic.com": { data: [] } });
    vi.stubGlobal("fetch", fetchMock);

    await discoverModels();

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer tok");
  });

  it("ignores providers with no discoverer", async () => {
    mocks.connections = [{ id: "o1", provider: "openai", isActive: true }];
    vi.stubGlobal("fetch", vi.fn());

    expect(await discoverModels()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
