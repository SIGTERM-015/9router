/**
 * Antigravity enterprise (Business AI Code) account calls: license discovery and model catalogue.
 * Requests themselves go through AntigravityExecutor; quota through usage/google.js.
 */

import { antigravityEnterpriseUrl } from "../providers/shared.js";

const headers = (accessToken) => ({
  "Authorization": `Bearer ${accessToken}`,
  "Content-Type": "application/json",
  "x-request-source": "local",
});

/**
 * Assign (or read back) the account's Gemini Enterprise license for a project + location.
 * Returns { userTier, tierDisplayName, projectId, location } or null when the account has none.
 */
export async function selfAssignAntigravityLicense(accessToken, projectId, location) {
  const url = `https://businessaicode.googleapis.com/v1beta/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}:selfAssignLicense`;
  const response = await fetch(url, { method: "POST", headers: headers(accessToken), body: "{}" });
  if (!response.ok) return null;
  const { license } = await response.json();
  return license?.userTier ? license : null;
}

/** Admin-allowed models (`availableExperiences`) as 9router model entries. */
export function parseEnterpriseConfigModels(data) {
  return (data?.availableExperiences || []).filter(exp => exp?.name).map(exp => ({
    id: exp.name,
    name: exp.model?.displayName || exp.name,
    upstreamModelId: exp.name,
    contextLength: exp.model?.inputTokenLimit,
    maxOutputTokens: exp.model?.outputTokenLimit,
    supportedThinkingLevels: exp.model?.supportedThinkingLevels,
  }));
}

export function fetchAntigravityEnterpriseConfig(accessToken, license) {
  const url = `${antigravityEnterpriseUrl(license, "fetchConfig")}?entitlement.userTier=${encodeURIComponent(license.userTier)}`;
  return fetch(url, { method: "GET", headers: headers(accessToken) });
}
