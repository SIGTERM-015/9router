import { detectClientTool } from "../../utils/clientDetector.js";

// Who sent a request, for analytics: the raw key (resolved to an id/name by the analytics
// layer, never stored as is), the endpoint, and the client tool from the User-Agent.
export function traceContext(apiKey, clientRawRequest, body) {
  const headers = clientRawRequest?.headers || {};
  const ua = headers["user-agent"] || "";
  return {
    apiKey: apiKey || null,
    endpoint: clientRawRequest?.endpoint || null,
    client: detectClientTool(headers, body || {}) || ua.split(/[\s/]/)[0].toLowerCase(),
  };
}
