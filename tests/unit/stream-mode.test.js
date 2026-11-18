import { describe, expect, it } from "vitest";

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { resolveStreamMode } = await import("../../open-sse/utils/streamMode.js");

const mode = (over) => resolveStreamMode({ body: {}, sourceFormat: FORMATS.OPENAI, providerRequiresStreaming: false, ...over });

describe("resolveStreamMode", () => {
  it("does not stream an OpenAI chat request that omits `stream`", () => {
    expect(mode({ body: { model: "m", messages: [] } })).toBe(false);
  });

  it("streams an OpenAI chat request with stream:true, whatever the Accept header says", () => {
    expect(mode({ body: { stream: true } })).toBe(true);
    expect(mode({ body: { stream: true }, acceptHeader: "application/json" })).toBe(true);
  });

  it("does not stream an OpenAI chat request with stream:false", () => {
    expect(mode({ body: { stream: false } })).toBe(false);
  });

  it.each([FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES])("keeps streaming by default for %s clients", (sourceFormat) => {
    expect(mode({ sourceFormat })).toBe(true);
    expect(mode({ sourceFormat, body: { stream: false } })).toBe(false);
  });

  it("answers JSON to a client that accepts JSON and not SSE", () => {
    expect(mode({ sourceFormat: FORMATS.CLAUDE, acceptHeader: "application/json" })).toBe(false);
    expect(mode({ sourceFormat: FORMATS.CLAUDE, acceptHeader: "application/json, text/event-stream" })).toBe(true);
  });

  it("always streams when the provider requires it, except for the deepseek TUI", () => {
    expect(mode({ providerRequiresStreaming: true, acceptHeader: "application/json" })).toBe(true);
    expect(mode({ providerRequiresStreaming: true, detectedTool: "deepseek-tui" })).toBe(false);
  });
});
