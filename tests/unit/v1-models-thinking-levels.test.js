import { beforeEach, describe, expect, it, vi } from "vitest";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";

const db = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getCombos: vi.fn(async () => []),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
}));

vi.mock("@/lib/localDb", () => db);
vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: vi.fn(async () => ({})),
}));

const { GET, buildModelsList } = await import("../../src/app/api/v1/models/route.js");

beforeEach(() => {
  db.getProviderConnections.mockReset();
  db.getCombos.mockReset();
  db.getCombos.mockResolvedValue([]);
  db.getCustomModels.mockResolvedValue([]);
  db.getModelAliases.mockResolvedValue({});
});

async function listFor(providerId, modelId) {
  db.getProviderConnections.mockResolvedValue([{
    id: 1,
    provider: providerId,
    isActive: true,
    providerSpecificData: { enabledModels: [modelId] },
  }]);
  const models = await buildModelsList(["llm"]);
  return models.find((m) => m.id.endsWith(`/${modelId}`));
}

async function fetchModelsRoute(combos) {
  db.getProviderConnections.mockResolvedValue([{
    id: 1,
    provider: "antigravity-enterprise",
    isActive: true,
    providerSpecificData: { enabledModels: ["gemini-4-neon-high"] },
  }]);
  db.getCombos.mockResolvedValue(combos);
  const res = await GET(new Request("http://localhost/v1/models"));
  expect(res.status).toBe(200);
  const json = await res.json();
  return json.data;
}

describe("/v1/models thinking_levels", () => {
  it("publishes the same levels the dashboard picker uses", async () => {
    const entry = await listFor("claude", "claude-haiku-5-5");
    expect(entry).toBeDefined();
    expect(entry.thinking_levels).toEqual(getThinkingLevels("claude", "claude-haiku-5-5"));
    expect(entry.thinking_levels.length).toBeGreaterThan(0);
  });

  it("omits the field for models without reasoning", async () => {
    const entry = await listFor("claude", "claude-haiku-4-5-20251001");
    if (entry && getThinkingLevels("claude", "claude-haiku-4-5-20251001") === null) {
      expect(entry).not.toHaveProperty("thinking_levels");
    }
  });
});

describe("/v1/models combo thinking_levels", () => {
  it("publishes the shared levels when two seats accept the same levels", async () => {
    const data = await fetchModelsRoute([
      {
        name: "gemini-4-neon",
        models: ["age/gemini-4-neon", "gemini/gemini-4-neon"],
      },
    ]);
    const combo = data.find((m) => m.id === "gemini-4-neon");
    expect(combo).toBeDefined();
    expect(combo.capabilities.reasoning).toBe(true);
    expect(combo.thinking_levels).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("publishes the canonical-order intersection when seats accept different levels", async () => {
    // age/gemini-4-neon: ["low", "medium", "high", "xhigh"]
    // vx/gemini-4-argon: ["low", "medium", "high"]
    // cbcn/deepseek-v4.1-flash (UI alias -> codebuddy-cn): ["low", "high", "max"]
    const data = await fetchModelsRoute([
      {
        name: "neon-argon",
        models: ["age/gemini-4-neon", "vx/gemini-4-argon"],
      },
      {
        name: "neon-codebuddy",
        models: ["age/gemini-4-neon", "cbcn/deepseek-v4.1-flash"],
      },
    ]);

    expect(data.find((m) => m.id === "neon-argon")?.thinking_levels).toEqual(["low", "medium", "high"]);
    expect(data.find((m) => m.id === "neon-codebuddy")?.thinking_levels).toEqual(["low", "high"]);
  });

  it("omits thinking_levels when any seat lacks reasoning or intersection is empty", async () => {
    // openai/gpt-4o has no reasoning; glm-5 has ["none", "thinking"] vs gemini-4-neon ["low", "medium", "high", "xhigh"]
    const data = await fetchModelsRoute([
      {
        name: "mixed-non-reasoning",
        models: ["age/gemini-4-neon", "openai/gpt-4o"],
      },
      {
        name: "disjoint-levels",
        models: ["age/gemini-4-neon", "glm/glm-5"],
      },
    ]);

    const mixed = data.find((m) => m.id === "mixed-non-reasoning");
    expect(mixed).toBeDefined();
    expect(mixed).not.toHaveProperty("thinking_levels");

    const disjoint = data.find((m) => m.id === "disjoint-levels");
    expect(disjoint).toBeDefined();
    expect(disjoint).not.toHaveProperty("thinking_levels");
  });

  it("resolves nested combos recursively and intersects across all leaves", async () => {
    // inner-neon: ["low", "medium", "high", "xhigh"]
    // outer-combo: inner-neon ∩ vx/gemini-4-argon (["low", "medium", "high"]) -> ["low", "medium", "high"]
    const data = await fetchModelsRoute([
      {
        name: "inner-neon",
        models: ["age/gemini-4-neon", "ag/gemini-4-neon"],
      },
      {
        name: "outer-combo",
        models: ["inner-neon", "vx/gemini-4-argon"],
      },
    ]);

    expect(data.find((m) => m.id === "inner-neon")?.thinking_levels).toEqual(["low", "medium", "high", "xhigh"]);
    expect(data.find((m) => m.id === "outer-combo")?.thinking_levels).toEqual(["low", "medium", "high"]);
  });

  it("handles cyclic combos safely and omits thinking_levels", async () => {
    const data = await fetchModelsRoute([
      { name: "cycle-a", models: ["cycle-b"] },
      { name: "cycle-b", models: ["cycle-a"] },
      { name: "self-cycle", models: ["age/gemini-4-neon", "self-cycle"] },
    ]);

    expect(data.find((m) => m.id === "cycle-a")).not.toHaveProperty("thinking_levels");
    expect(data.find((m) => m.id === "cycle-b")).not.toHaveProperty("thinking_levels");
    expect(data.find((m) => m.id === "self-cycle")).not.toHaveProperty("thinking_levels");
  });
});
