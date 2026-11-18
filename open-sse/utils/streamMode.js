import { FORMATS } from "../translator/formats.js";

/**
 * Decide whether the upstream call and the reply to the client stream.
 *
 * OpenAI Chat Completions: a request without `stream` is NOT streamed. Clients built on
 * the AI SDK send no `stream` field and parse the reply as JSON, so answering with SSE
 * breaks them ("Invalid JSON response"). Other source formats keep streaming by default.
 */
export function resolveStreamMode({ body, sourceFormat, providerRequiresStreaming, detectedTool, acceptHeader = "" }) {
  const streamDefault = sourceFormat !== FORMATS.OPENAI;
  let stream = providerRequiresStreaming || (body.stream === undefined ? streamDefault : body.stream !== false);

  // DeepSeek-TUI: interactive TUI panel sends stream:true and needs SSE.
  // Non-interactive mode (-p flag) sends without stream and can't parse SSE.
  if (detectedTool === "deepseek-tui" && body.stream !== true) stream = false;

  // A client that accepts JSON and not SSE gets JSON unless it asked for streaming.
  const prefersJson = acceptHeader.includes("application/json");
  const prefersSSE = acceptHeader.includes("text/event-stream");
  if (prefersJson && !prefersSSE && body.stream !== true && !providerRequiresStreaming) stream = false;

  return stream;
}
