/**
 * Antigravity enterprise (Business AI Code) account calls: license discovery and model catalogue.
 * Requests themselves go through AntigravityEnterpriseExecutor; quota through usage/google.js.
 */

import { antigravityEnterpriseUrl } from "../providers/shared.js";

const headers = (accessToken) => ({
  "Authorization": `Bearer ${accessToken}`,
  "Content-Type": "application/json",
  "x-request-source": "local",
});

/**
 * Every Gemini Enterprise license the signed-in user holds, as
 * { userTier, tierDisplayName, projectId, location }. This is how an enterprise account is found
 * on OAuth alone: no consumer endpoint ever names its Cloud project (`loadCodeAssist` returns
 * cloudaicompanionProject: null), and `projects/-` is denied.
 */
export async function fetchAntigravityLicenses(accessToken) {
  const response = await fetch("https://businessaicode.googleapis.com/v1beta:fetchLicenses", {
    method: "GET",
    headers: headers(accessToken),
  });
  if (!response.ok) return [];
  const { licenses } = await response.json();
  return (licenses || []).filter(license => license?.userTier && license?.projectId && license?.location);
}

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
  if (!license?.userTier || !license?.projectId || !license?.location) {
    throw new Error("Antigravity enterprise license metadata missing");
  }
  const url = `${antigravityEnterpriseUrl(license, "fetchConfig")}?entitlement.userTier=${encodeURIComponent(license.userTier)}`;
  return fetch(url, { method: "GET", headers: headers(accessToken) });
}
