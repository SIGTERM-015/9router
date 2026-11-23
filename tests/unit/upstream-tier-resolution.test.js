import { describe, expect, it } from "vitest";

import { getModelUpstreamId } from "../../open-sse/config/providerModels.js";

// `max` and `-max` ids: "-max" models are different products, never a thinking tier.
describe("getModelUpstreamId tier resolution", () => {
  it("keeps xhigh for a family that has -high and -xhigh tiers", () => {
    expect(getModelUpstreamId("age", "gemini-4-neon", { reasoning_effort: "xhigh" })).toBe("gemini-4-neon-xhigh");
    expect(getModelUpstreamId("ag", "gemini-4-neon", { reasoning_effort: "xhigh" })).toContain("gemini-4-neon-xhigh");
  });

  it("does not move max to a different '-max' model", () => {
    expect(getModelUpstreamId("cu", "claude-4.6-opus", { reasoning_effort: "max" })).toBe("claude-4.6-opus");
    expect(getModelUpstreamId("ocz", "gpt-5.1-codex", { reasoning_effort: "max" })).toBe("gpt-5.1-codex");
    expect(getModelUpstreamId("if", "qwen3", { output_config: { effort: "max" } })).toBe("qwen3");
  });

  it("does not move an explicit (max) suffix to a '-max' model either", () => {
    expect(getModelUpstreamId("cu", "claude-4.6-opus(max)")).toBe("claude-4.6-opus(max)");
  });
});
