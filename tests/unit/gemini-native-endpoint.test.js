import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleChat: vi.fn(),
  getSettings: vi.fn(),
  isValidApiKey: vi.fn(),
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(),
}));

vi.mock("@/sse/handlers/chat.js", () => ({
  handleChat: mocks.handleChat,
}));

vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  isValidApiKey: mocks.isValidApiKey,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: mocks.getSettings,
}));

const { GET } = await import("../../src/app/api/v1beta/models/route.js");
const { POST } = await import("../../src/app/api/v1beta/models/[...path]/route.js");

function makeGeminiRequest(path, body, headers = {}, signal) {
  return new Request(`https://router.test/v1beta/models/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer router-client-key",
      ...headers,
    },
    body: JSON.stringify(body),
    signal,
  });
}

function audioBody() {
  return {
    contents: [{ parts: [{ text: "Speak naturally: hello" }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: "Kore" },
        },
      },
      temperature: 0.01,
      seed: 123,
    },
  };
}

describe("Gemini native v1beta endpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSettings.mockResolvedValue({ requireApiKey: true });
    mocks.isValidApiKey.mockResolvedValue(true);
    mocks.getProviderCredentials.mockResolvedValue({
      apiKey: "real-gemini-key",
      connectionId: "gemini-conn",
      connectionName: "Gemini Test",
      providerSpecificData: {},
    });
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: false });
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    mocks.handleChat.mockResolvedValue(
      Response.json({ candidates: [{ content: { parts: [{ text: "chat" }] } }] })
    );
  });

  it("lists Gemini TTS models using standard Google model names", async () => {
    const response = await GET();
    const body = await response.json();
    const names = body.models.map((model) => model.name);

    expect(names).toContain("models/gemini-3.1-flash-tts-preview");
    expect(names).toContain("models/gemini-2.5-flash-preview-tts");
    expect(names).toContain("models/gemini-2.5-pro-preview-tts");
  });

  it("passes Gemini AUDIO generateContent requests through to Google's native endpoint", async () => {
    const body = audioBody();
    const response = await POST(makeGeminiRequest("gemini-3.1-flash-tts-preview:generateContent", body), {
      params: Promise.resolve({ path: ["gemini-3.1-flash-tts-preview:generateContent"] }),
    });

    expect(response.status).toBe(200);
    expect(mocks.handleChat).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-tts-preview:generateContent"
    );

    const options = global.fetch.mock.calls[0][1];
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body)).toEqual(body);
    expect(options.headers["x-goog-api-key"]).toBe("real-gemini-key");
    expect(options.headers.Authorization).toBeUndefined();
  });

  it("accepts Google-style client keys without forwarding them upstream", async () => {
    const request = makeGeminiRequest(
      "gemini-2.5-flash-preview-tts:generateContent?key=query-router-key",
      audioBody(),
      {
        Authorization: "",
        "x-goog-api-key": "client-router-key",
      }
    );
    await POST(request, {
      params: Promise.resolve({ path: ["gemini-2.5-flash-preview-tts:generateContent"] }),
    });

    expect(mocks.isValidApiKey).toHaveBeenCalledWith("client-router-key");
    expect(global.fetch.mock.calls[0][1].headers["x-goog-api-key"]).toBe("real-gemini-key");
    expect(global.fetch.mock.calls[0][1].headers["x-goog-api-key"]).not.toBe("client-router-key");
  });

  it("does not forward stale compression headers from native upstream responses", async () => {
    global.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Encoding": "gzip",
          "Content-Length": "123",
        },
      })
    );

    const response = await POST(makeGeminiRequest("gemini-3.1-flash-tts-preview:generateContent", audioBody()), {
      params: Promise.resolve({ path: ["gemini-3.1-flash-tts-preview:generateContent"] }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
  });

  it("falls back to the next Gemini credential when native fetch times out before headers", async () => {
    const timeoutError = new TypeError("fetch failed");
    timeoutError.cause = { code: "UND_ERR_HEADERS_TIMEOUT", name: "HeadersTimeoutError" };

    mocks.getProviderCredentials
      .mockResolvedValueOnce({
        apiKey: "first-gemini-key",
        connectionId: "first-conn",
        connectionName: "First Gemini",
        providerSpecificData: {},
      })
      .mockResolvedValueOnce({
        apiKey: "second-gemini-key",
        connectionId: "second-conn",
        connectionName: "Second Gemini",
        providerSpecificData: {},
      });
    mocks.markAccountUnavailable.mockResolvedValueOnce({ shouldFallback: true });
    global.fetch
      .mockRejectedValueOnce(timeoutError)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { data: "pcm" } }] } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

    const response = await POST(makeGeminiRequest("gemini-3.1-flash-tts-preview:generateContent", audioBody()), {
      params: Promise.resolve({ path: ["gemini-3.1-flash-tts-preview:generateContent"] }),
    });

    expect(response.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[0][1].headers["x-goog-api-key"]).toBe("first-gemini-key");
    expect(global.fetch.mock.calls[1][1].headers["x-goog-api-key"]).toBe("second-gemini-key");
    expect(mocks.markAccountUnavailable).toHaveBeenCalledWith(
      "first-conn",
      504,
      expect.stringContaining("UND_ERR_HEADERS_TIMEOUT"),
      "gemini",
      "gemini-3.1-flash-tts-preview"
    );
    expect(mocks.clearAccountError).toHaveBeenCalledWith(
      "second-conn",
      expect.objectContaining({ apiKey: "second-gemini-key" }),
      "gemini-3.1-flash-tts-preview"
    );
  });

  it("returns 502 for native fetch failures when credential fallback is not allowed", async () => {
    const networkError = new TypeError("fetch failed");
    networkError.cause = { code: "ECONNRESET" };
    mocks.markAccountUnavailable.mockResolvedValueOnce({ shouldFallback: false });
    global.fetch.mockRejectedValueOnce(networkError);

    const response = await POST(makeGeminiRequest("gemini-3.1-flash-tts-preview:generateContent", audioBody()), {
      params: Promise.resolve({ path: ["gemini-3.1-flash-tts-preview:generateContent"] }),
    });
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.error.message).toContain("ECONNRESET");
    expect(mocks.markAccountUnavailable).toHaveBeenCalledWith(
      "gemini-conn",
      502,
      expect.stringContaining("ECONNRESET"),
      "gemini",
      "gemini-3.1-flash-tts-preview"
    );
  });

  it("does not mark Gemini credentials unavailable when the native client aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    global.fetch.mockRejectedValueOnce(new DOMException("The operation was aborted", "AbortError"));

    const response = await POST(
      makeGeminiRequest("gemini-3.1-flash-tts-preview:generateContent", audioBody(), {}, controller.signal),
      {
        params: Promise.resolve({ path: ["gemini-3.1-flash-tts-preview:generateContent"] }),
      }
    );

    expect(response.status).toBe(499);
    expect(mocks.markAccountUnavailable).not.toHaveBeenCalled();
  });

  it("keeps non-audio Gemini requests on the existing chat conversion path", async () => {
    const body = {
      contents: [{ parts: [{ text: "hello" }] }],
      generationConfig: { temperature: 0.3 },
    };

    await POST(makeGeminiRequest("gemini-2.5-flash:generateContent", body), {
      params: Promise.resolve({ path: ["gemini-2.5-flash:generateContent"] }),
    });

    expect(mocks.handleChat).toHaveBeenCalledTimes(1);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("hands chat the Gemini body intact (tools, thoughts, function calls) plus the model", async () => {
    const body = {
      contents: [
        { role: "user", parts: [{ text: "list files" }] },
        { role: "model", parts: [{ text: "plan", thought: true, thoughtSignature: "sig" }, { functionCall: { name: "run_command", args: { CommandLine: "ls" } } }] },
        { role: "user", parts: [{ functionResponse: { name: "run_command", response: { output: "a.txt" } } }] },
      ],
      tools: [{ functionDeclarations: [{ name: "run_command", parametersJsonSchema: { type: "object" } }] }],
      generationConfig: { thinkingConfig: { includeThoughts: true } },
    };

    await POST(makeGeminiRequest("gemini/gemini-4-neon:streamGenerateContent?alt=sse", body, { "x-goog-api-key": "k" }), {
      params: Promise.resolve({ path: ["gemini", "gemini-4-neon:streamGenerateContent"] }),
    });

    const forwarded = mocks.handleChat.mock.calls[0][0];
    expect(await forwarded.json()).toEqual({ ...body, model: "gemini/gemini-4-neon" });
    expect(forwarded.headers.get("x-goog-api-key")).toBe("k");
    expect(forwarded.headers.get("accept")).not.toBe("application/json");
  });

  it("asks chat for JSON on :generateContent", async () => {
    await POST(makeGeminiRequest("gemini-4-neon:generateContent", { contents: [{ parts: [{ text: "hi" }] }] }), {
      params: Promise.resolve({ path: ["gemini-4-neon:generateContent"] }),
    });

    expect(mocks.handleChat.mock.calls[0][0].headers.get("accept")).toBe("application/json");
  });

  it("does not hijack provider-prefixed non-Gemini audio requests", async () => {
    await POST(makeGeminiRequest("openai/gpt-4o-mini-tts:generateContent", audioBody()), {
      params: Promise.resolve({ path: ["openai", "gpt-4o-mini-tts:generateContent"] }),
    });

    expect(mocks.handleChat).toHaveBeenCalledTimes(1);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("v1beta streams held while the response is not ready", () => {
  const streamRequest = () => makeGeminiRequest("gemini-4-neon:streamGenerateContent?alt=sse", { contents: [{ parts: [{ text: "hi" }] }] });
  const params = { params: Promise.resolve({ path: ["gemini-4-neon:streamGenerateContent"] }) };
  const sse = (text) => new Response(text, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  const deferred = () => {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("passes a stream that is ready in time through untouched", async () => {
    const upstream = sse('data: {"candidates":[{"content":{"parts":[{"text":"fast"}]}}]}\n\n');
    mocks.handleChat.mockResolvedValue(upstream);

    const response = await POST(streamRequest(), params);

    expect(response).toBe(upstream);
  });

  it("answers 200 at once, sends empty chunks while waiting, then the real stream", async () => {
    const chat = deferred();
    mocks.handleChat.mockReturnValue(chat.promise);

    const pending = POST(streamRequest(), params);
    await vi.advanceTimersByTimeAsync(10_000);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");

    await vi.advanceTimersByTimeAsync(30_000);
    chat.resolve(sse('data: {"candidates":[{"content":{"parts":[{"text":"slow"}]}}]}\n\n'));

    expect(await response.text()).toBe(
      'data: {"candidates":[]}\n\n'.repeat(3)
      + 'data: {"candidates":[{"content":{"parts":[{"text":"slow"}]}}]}\n\n'
    );
  });

  it("turns an error that comes after the 200 into a Gemini error frame", async () => {
    const chat = deferred();
    mocks.handleChat.mockReturnValue(chat.promise);

    const pending = POST(streamRequest(), params);
    await vi.advanceTimersByTimeAsync(10_000);
    const response = await pending;
    chat.resolve(Response.json({ error: { message: "[gemini/gemini-4-neon] fetch connect timeout" } }, { status: 503 }));

    expect(await response.text()).toBe(
      'data: {"candidates":[]}\n\n'
      + 'data: {"error":{"code":503,"message":"[gemini/gemini-4-neon] fetch connect timeout","status":"UNAVAILABLE"}}\n\n'
    );
  });

  it("sends a late JSON body as a single chunk", async () => {
    const chat = deferred();
    mocks.handleChat.mockReturnValue(chat.promise);

    const pending = POST(streamRequest(), params);
    await vi.advanceTimersByTimeAsync(10_000);
    const response = await pending;
    chat.resolve(Response.json({ candidates: [{ content: { parts: [{ text: "json" }] } }] }));

    expect(await response.text()).toBe(
      'data: {"candidates":[]}\n\n'
      + 'data: {"candidates":[{"content":{"parts":[{"text":"json"}]}}]}\n\n'
    );
  });

  it("never holds :generateContent", async () => {
    const chat = deferred();
    mocks.handleChat.mockReturnValue(chat.promise);

    const pending = POST(makeGeminiRequest("gemini-4-neon:generateContent", { contents: [{ parts: [{ text: "hi" }] }] }), {
      params: Promise.resolve({ path: ["gemini-4-neon:generateContent"] }),
    });
    await vi.advanceTimersByTimeAsync(60_000);
    const upstream = Response.json({ candidates: [] });
    chat.resolve(upstream);

    expect(await pending).toBe(upstream);
  });
});
