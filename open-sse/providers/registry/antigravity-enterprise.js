import { ANTIGRAVITY_ENTERPRISE_OAUTH_CLIENT, GOOGLE_SLOW_HEADERS } from "../shared.js";

const antigravityEnterprise = {
  id: "antigravity-enterprise",
  priority: 21,
  alias: "age",
  uiAlias: "age",
  display: {
    name: "Gemini Enterprise (Antigravity)",
    icon: "rocket_launch",
    color: "#4285F4",
    website: "https://antigravity.google",
    notice: {
      signupUrl: "https://antigravity.google",
    },
  },
  category: "oauth",
  serviceKinds: ["llm"],
  transport: {
    baseUrls: ["https://businessaicode.googleapis.com"],
    format: "antigravity",
    retry: {
      "429": {
        attempts: 3,
      },
      "500": {
        attempts: 3,
      },
      "503": {
        attempts: 3,
      },
      ...GOOGLE_SLOW_HEADERS.retry,
    },
    timeoutMs: GOOGLE_SLOW_HEADERS.timeoutMs,
    usage: {
      tokenUrl: "https://oauth2.googleapis.com/token",
    },
    ...ANTIGRAVITY_ENTERPRISE_OAUTH_CLIENT,
  },
  // Static fallback catalogue of Business AI Code experience names; live admin-allowed
  // experiences are fetched per connection from fetchConfig via /api/providers/[id]/models.
  models: [
    { id: "gemini-4-neon-xhigh", name: "Gemini 4 Neon (Extra High)" },
    { id: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
    { id: "gemini-4-neon-medium", name: "Gemini 4 Neon (Medium)" },
    { id: "gemini-4-neon-low", name: "Gemini 4 Neon (Low)" },
    { id: "gemini-4-carbon-high", name: "Gemini 4 Carbon (High)" },
    { id: "gemini-4-carbon-medium", name: "Gemini 4 Carbon (Medium)" },
    { id: "gemini-4-carbon-low", name: "Gemini 4 Carbon (Low)" },
    { id: "gemini-4-argon-high", name: "Gemini 4 Argon (High)" },
    { id: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)" },
    { id: "gemini-4-argon-low", name: "Gemini 4 Argon (Low)" },
    { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
    { id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
    { id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
    { id: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)" },
    { id: "gemini-3.7-flash-medium", name: "Gemini 3.7 Flash (Medium)" },
    { id: "gemini-3.7-flash-low", name: "Gemini 3.7 Flash (Low)" },
    { id: "gemini-3.6-flash-high", name: "Gemini 3.6 Flash (High)" },
    { id: "gemini-3.6-flash-medium", name: "Gemini 3.6 Flash (Medium)" },
    { id: "gemini-3.6-flash-low", name: "Gemini 3.6 Flash (Low)" },
    { id: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)" },
    { id: "gemini-3.1-pro-low", name: "Gemini 3.1 Pro (Low)" },
    { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite" },
  ],
  oauth: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userInfoUrl: "https://www.googleapis.com/oauth2/v1/userinfo",
    scopes: [
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/cclog",
      "https://www.googleapis.com/auth/experimentsandconfigs",
    ],
    refreshLeadMs: 300000,
  },
  features: {
    usage: true,
  },
};

export default antigravityEnterprise;
