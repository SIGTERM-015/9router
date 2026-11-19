import { AntigravityExecutor, isImageModel } from "./antigravity.js";
import { PROVIDERS } from "../config/providers.js";
import { antigravityEnterpriseUrl } from "../providers/shared.js";
import { getModelUpstreamId, PROVIDER_MODELS } from "../config/providerModels.js";

// Business AI Code only accepts the admin config's experience names (e.g. "gemini-4-carbon-high"),
// never Cloud Code ids with a thinking preset ("gemini-4-carbon-medium(medium)"). `model` is the
// 9router id; ids that already end in a level are experience names as-is.
const LEVEL_TAIL_RE = /-(low|medium|high|xhigh)$/;
const SUFFIX_RE = /\(([^()]+)\)\s*$/;

export function enterpriseModelName(model) {
  const base = model.replace(SUFFIX_RE, "").trim();
  if (LEVEL_TAIL_RE.test(base)) return base;
  const level = model.match(SUFFIX_RE)?.[1].trim().toLowerCase();
  if (level) return `${base}-${level}`;
  // Level-less alias: the level its registry entry defaults to ("gemini-4-carbon" → medium), or the
  // levelled id sharing its upstream ("gemini-pro-agent" → "gemini-3.1-pro-high").
  const upstream = getModelUpstreamId("ag", base).replace(SUFFIX_RE, "").trim();
  if (LEVEL_TAIL_RE.test(upstream)) return upstream;
  const sibling = PROVIDER_MODELS.ag?.find(m => m.upstreamModelId === upstream && LEVEL_TAIL_RE.test(m.id));
  return sibling?.id || base;
}

// Business AI Code takes a bare Gemini request plus the license entitlement. It rejects the
// Cloud Code envelope (project, requestId, userAgent), `sessionId` and the VALIDATED tool mode.
function enterpriseBody(model, request, license) {
  const { sessionId: _sessionId, toolConfig: _toolConfig, ...rest } = request;
  return { model, ...rest, entitlement: { userTier: license.userTier } };
}

function requireLicense(credentials) {
  const license = credentials?.providerSpecificData?.enterpriseLicense;
  if (!license?.userTier || !license?.projectId || !license?.location) {
    throw new Error("Antigravity Enterprise connection is missing license metadata — reconnect the account.");
  }
  return license;
}

export class AntigravityEnterpriseExecutor extends AntigravityExecutor {
  constructor() {
    super("antigravity-enterprise", PROVIDERS["antigravity-enterprise"]);
  }

  buildUrl(model, stream, _urlIndex = 0, credentials = null) {
    const license = requireLicense(credentials);
    const forceNonStream = isImageModel(model);
    const action = (stream && !forceNonStream) ? "streamGenerateContent?alt=sse" : "generateContent";
    return antigravityEnterpriseUrl(license, action);
  }

  buildHeaders(credentials) {
    return {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${credentials.accessToken}`,
      "x-request-source": "local",
    };
  }

  transformRequest(model, body, stream, credentials) {
    const license = requireLicense(credentials);
    const { isImage, cleanModel, request } = this.prepareRequestBody(model, body, stream, credentials);
    return enterpriseBody(isImage ? cleanModel : enterpriseModelName(model), request, license);
  }
}

export default AntigravityEnterpriseExecutor;
