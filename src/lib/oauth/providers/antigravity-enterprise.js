import { ANTIGRAVITY_ENTERPRISE_CONFIG } from "../constants/oauth.js";
import { fetchAntigravityLicenses, selfAssignAntigravityLicense } from "open-sse/services/antigravityEnterprise.js";

const antigravityEnterprise = {
  config: ANTIGRAVITY_ENTERPRISE_CONFIG,
  flowType: "authorization_code",
  buildAuthUrl: (config, redirectUri, state) => {
    if (!config.clientId) throw new Error("Gemini Enterprise login is not configured: set ANTIGRAVITY_ENTERPRISE_CLIENT_ID and ANTIGRAVITY_ENTERPRISE_CLIENT_SECRET");
    const params = new URLSearchParams({
      client_id: config.clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: config.scopes.join(" "),
      state: state,
      access_type: "offline",
      prompt: "consent",
    });
    return `${config.authorizeUrl}?${params.toString()}`;
  },
  exchangeToken: async (config, code, redirectUri) => {
    const response = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code: code,
        redirect_uri: redirectUri,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Token exchange failed: ${error}`);
    }

    return await response.json();
  },
  // Discover the account's Gemini Enterprise (Business AI Code) license via fetchLicenses, or pin a
  // specific project/location when the caller supplies meta.projectId / meta.location.
  postExchange: async (tokens, meta = {}) => {
    const userInfoRes = await fetch(`${ANTIGRAVITY_ENTERPRISE_CONFIG.userInfoUrl}?alt=json`, {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
        "x-request-source": "local",
      },
    });
    const userInfo = userInfoRes.ok ? await userInfoRes.json() : {};

    const projectId = typeof meta?.projectId === "string" ? meta.projectId.trim() : "";
    const location = typeof meta?.location === "string" ? meta.location.trim() : "";

    let enterpriseLicense = null;
    if (projectId && location) {
      enterpriseLicense = await selfAssignAntigravityLicense(tokens.access_token, projectId, location);
    } else {
      const licenses = await fetchAntigravityLicenses(tokens.access_token);
      const found = licenses.find((l) =>
        (!projectId || l.projectId === projectId) &&
        (!location || l.location === location)
      );
      if (found) {
        enterpriseLicense = (await selfAssignAntigravityLicense(tokens.access_token, found.projectId, found.location)) || found;
      }
    }

    if (!enterpriseLicense) {
      throw new Error(
        projectId || location
          ? `No Gemini Enterprise license found for project "${projectId || "*"}" in location "${location || "*"}". Verify the account's license assignment and try again.`
          : "No Gemini Enterprise license found for this Google account. Ensure your Google Workspace account has an active Gemini Enterprise (Business AI Code) license and try again."
      );
    }

    return { userInfo, projectId: enterpriseLicense.projectId, enterpriseLicense };
  },
  mapTokens: (tokens, extra) => ({
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in,
    scope: tokens.scope,
    email: extra?.userInfo?.email,
    projectId: extra?.projectId,
    providerSpecificData: { enterpriseLicense: extra.enterpriseLicense },
  }),
};

export default antigravityEnterprise;
