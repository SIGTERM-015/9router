// Gemini-native agent clients (google-genai SDKs: Antigravity CLI `agy`, Gemini CLI
// with GOOGLE_GEMINI_BASE_URL) on /v1beta: key headers, tool schemas, replayed
// thoughts, and Gemini-shaped responses from non-Gemini upstreams.
import { describe, expect, it } from "vitest";

const { FORMATS } = await import("../../open-sse/translator/formats.js");
const { translateRequest, translateResponse, initState } = await import("../../open-sse/translator/index.js");
const { translateNonStreamingResponse } = await import("../../open-sse/handlers/chatCore/nonStreamingHandler.js");
const { extractApiKey } = await import("../../src/sse/services/clientKey.js");

const keyRequest = (url, headers = {}) => new Request(url, { method: "POST", headers });

describe("extractApiKey", () => {
  it("reads every header a supported SDK sends its key in", () => {
    expect(extractApiKey(keyRequest("https://r.test/v1/chat/completions", { Authorization: "Bearer openai-key" }))).toBe("openai-key");
    expect(extractApiKey(keyRequest("https://r.test/v1/messages", { "x-api-key": "anthropic-key" }))).toBe("anthropic-key");
    expect(extractApiKey(keyRequest("https://r.test/v1beta/models/m:generateContent", { "x-goog-api-key": "google-key" }))).toBe("google-key");
    expect(extractApiKey(keyRequest("https://r.test/v1beta/models/m:generateContent?key=query-key"))).toBe("query-key");
    expect(extractApiKey(keyRequest("https://r.test/v1/chat/completions"))).toBe(null);
  });

  it("prefers Bearer when a client sends several", () => {
    expect(extractApiKey(keyRequest("https://r.test/x?key=q", { Authorization: "Bearer b", "x-goog-api-key": "g" }))).toBe("b");
  });
});

// What `agy` 1.4 sends on its first agent turn (trimmed): JSON Schema tools and a
// replayed thought from the previous model turn.
const agyBody = {
  systemInstruction: { parts: [{ text: "You are an agent." }] },
  contents: [
    { role: "user", parts: [{ text: "list the files" }] },
    { role: "model", parts: [
      { text: "I should run ls.", thought: true, thoughtSignature: "sig" },
      { functionCall: { id: "c1", name: "run_command", args: { CommandLine: "ls" } } },
    ] },
    { role: "user", parts: [{ functionResponse: { id: "c1", name: "run_command", response: { output: "a.txt" } } }] },
  ],
  tools: [{ functionDeclarations: [{
    name: "run_command",
    description: "Run a shell command",
    parametersJsonSchema: { type: "object", properties: { CommandLine: { type: "string" } }, required: ["CommandLine"] },
  }] }],
  generationConfig: { maxOutputTokens: 65536, thinkingConfig: { includeThoughts: true, thinkingBudget: -1 } },
};

describe("Gemini request → OpenAI upstream", () => {
  const out = translateRequest(FORMATS.GEMINI, FORMATS.OPENAI, "some-model", structuredClone(agyBody), true, null, "openai");

  it("keeps JSON Schema tool parameters", () => {
    expect(out.tools).toEqual([{
      type: "function",
      function: {
        name: "run_command",
        description: "Run a shell command",
        parameters: { type: "object", properties: { CommandLine: { type: "string" } }, required: ["CommandLine"] },
      },
    }]);
  });

  it("drops replayed thoughts instead of turning them into assistant text", () => {
    const assistant = out.messages.find((m) => m.role === "assistant");
    expect(assistant.content ?? null).toBe(null);
    expect(assistant.tool_calls).toEqual([{ id: "c1", type: "function", function: { name: "run_command", arguments: '{"CommandLine":"ls"}' } }]);
    expect(JSON.stringify(out.messages)).not.toContain("I should run ls.");
  });

  it("pairs the tool result with its call", () => {
    expect(out.messages.find((m) => m.role === "tool")).toEqual({ role: "tool", tool_call_id: "c1", content: '{"output":"a.txt"}' });
  });
});

describe("OpenAI upstream → Gemini client (streaming)", () => {
  it("emits Gemini chunks without the Antigravity envelope, tool calls whole at finish", () => {
    const state = initState(FORMATS.GEMINI);
    const chunks = [
      { id: "chatcmpl-1", model: "m", choices: [{ index: 0, delta: { reasoning_content: "thinking" } }] },
      { id: "chatcmpl-1", model: "m", choices: [{ index: 0, delta: { content: "Running ls." } }] },
      { id: "chatcmpl-1", model: "m", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c2", function: { name: "run_command", arguments: '{"Command' } }] } }] },
      { id: "chatcmpl-1", model: "m", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'Line":"ls"}' } }] } }] },
      { id: "chatcmpl-1", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ];
    const out = chunks.flatMap((c) => translateResponse(FORMATS.OPENAI, FORMATS.GEMINI, c, state) || []);

    expect(out.every((o) => !("response" in o))).toBe(true);
    expect(out.map((o) => o.candidates[0].content.parts)).toEqual([
      [{ thought: true, text: "thinking" }],
      [{ text: "Running ls." }],
      [{ functionCall: { name: "run_command", args: { CommandLine: "ls" } } }],
    ]);
    expect(out.at(-1).candidates[0].finishReason).toBe("STOP");
    expect(out.at(-1).usageMetadata).toEqual({ promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 });
  });
});

describe("OpenAI upstream → Gemini client (JSON)", () => {
  it("returns a GenerateContentResponse with text, thoughts and function calls", () => {
    const json = translateNonStreamingResponse({
      id: "chatcmpl-2",
      model: "m",
      choices: [{ index: 0, finish_reason: "tool_calls", message: {
        role: "assistant",
        content: "Running ls.",
        reasoning_content: "thinking",
        tool_calls: [{ id: "c3", type: "function", function: { name: "run_command", arguments: '{"CommandLine":"ls"}' } }],
      } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, completion_tokens_details: { reasoning_tokens: 2 } },
    }, FORMATS.OPENAI, FORMATS.GEMINI);

    expect(json).toEqual({
      candidates: [{
        content: { role: "model", parts: [
          { thought: true, text: "thinking" },
          { text: "Running ls." },
          { functionCall: { name: "run_command", args: { CommandLine: "ls" } } },
        ] },
        finishReason: "STOP",
        index: 0,
      }],
      modelVersion: "m",
      responseId: "chatcmpl-2",
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15, thoughtsTokenCount: 2 },
    });
  });

  it("leaves Gemini upstream bodies untouched for Gemini clients", () => {
    const body = { candidates: [{ content: { role: "model", parts: [{ text: "hi", thoughtSignature: "s" }] } }] };
    expect(translateNonStreamingResponse(body, FORMATS.GEMINI, FORMATS.GEMINI)).toBe(body);
  });
});
