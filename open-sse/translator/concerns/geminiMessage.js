const OPENAI_TO_GEMINI_FINISH = { stop: "STOP", tool_calls: "STOP", length: "MAX_TOKENS", content_filter: "SAFETY" };

/**
 * Convert an OpenAI Chat Completions body into a Gemini GenerateContentResponse,
 * for Gemini clients (/v1beta) routed to a non-Gemini upstream.
 */
export function openAICompletionToGemini(responseBody) {
  const choice = responseBody?.choices?.[0];
  if (!choice) return responseBody;
  const message = choice.message || {};

  const parts = [];
  const reasoning = message.reasoning_content || message.reasoning;
  if (typeof reasoning === "string" && reasoning) parts.push({ thought: true, text: reasoning });
  if (typeof message.content === "string" && message.content) parts.push({ text: message.content });
  for (const tc of message.tool_calls || []) {
    let args = {};
    try { args = JSON.parse(tc.function?.arguments || "{}"); } catch { /* malformed args: send none */ }
    parts.push({ functionCall: { name: tc.function?.name, args } });
  }
  if (parts.length === 0) parts.push({ text: "" });

  const result = {
    candidates: [{
      content: { role: "model", parts },
      finishReason: OPENAI_TO_GEMINI_FINISH[choice.finish_reason] || "STOP",
      index: 0,
    }],
    modelVersion: responseBody.model,
    responseId: responseBody.id,
  };
  const usage = responseBody.usage;
  if (usage) {
    result.usageMetadata = {
      promptTokenCount: usage.prompt_tokens || 0,
      candidatesTokenCount: usage.completion_tokens || 0,
      totalTokenCount: usage.total_tokens || 0,
    };
    const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens;
    if (reasoningTokens) result.usageMetadata.thoughtsTokenCount = reasoningTokens;
    const cached = usage.prompt_tokens_details?.cached_tokens;
    if (cached) result.usageMetadata.cachedContentTokenCount = cached;
  }
  return result;
}
