// Dedicated Gemini Enterprise (Business AI Code) provider `antigravity-enterprise`:
// regional host, bare Gemini body + entitlement, experience model names, enterprise OAuth client.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";

const proxyAwareFetch = vi.hoisted(() => vi.fn());
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));

import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { AntigravityEnterpriseExecutor, enterpriseModelName } from "../../open-sse/executors/antigravity-enterprise.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { getAntigravityUsage, getAntigravityEnterpriseUsage } from "../../open-sse/services/usage/google.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import { getAccessToken, formatProviderCredentials } from "../../open-sse/services/tokenRefresh.js";
import { fetchAntigravityLicenses, parseEnterpriseConfigModels, selfAssignAntigravityLicense } from "../../open-sse/services/antigravityEnterprise.js";
import { ANTIGRAVITY_OAUTH_CLIENT, ANTIGRAVITY_ENTERPRISE_OAUTH_CLIENT } from "../../open-sse/providers/shared.js";
import { resolveProviderAlias } from "../../open-sse/services/model.js";
import enterpriseRegistry from "../../open-sse/providers/registry/antigravity-enterprise.js";
import antigravityOAuth from "../../src/lib/oauth/providers/antigravity.js";
import antigravityEnterpriseOAuth from "../../src/lib/oauth/providers/antigravity-enterprise.js";
import { getProvider } from "../../src/lib/oauth/providers/index.js";
import { resolveProviderIconId } from "@/shared/utils/providerIcon.js";
import { parseQuotaData } from "@/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

const LICENSE = { userTier: "gcp-ge-plus-tier", tierDisplayName: "Gemini Enterprise Plus", projectId: "acme-proj", location: "eu" };
const BAIC = "https://businessaicode.eu.rep.googleapis.com/v1beta/projects/acme-proj/locations/eu";

const enterprise = { accessToken: "tok", refreshToken: "ref-ent", projectId: "acme-proj", connectionId: "c1", providerSpecificData: { enterpriseLicense: LICENSE } };
const consumer = { accessToken: "tok", refreshToken: "ref-con", projectId: "consumer-proj", connectionId: "c1", providerSpecificData: {} };

const request = () => ({
  request: {
    sessionId: "123",
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
    systemInstruction: { role: "user", parts: [{ text: "be terse" }] },
    generationConfig: { maxOutputTokens: 100 },
    tools: [{ functionDeclarations: [{ name: "foo", description: "x", parameters: { type: "object", properties: { a: { type: "string" } } } }] }],
  },
});

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  proxyAwareFetch.mockReset();
});

describe("antigravity-enterprise registry and OAuth config", () => {
  it("registers provider metadata, alias, scopes (no aicode), and enterprise OAuth client", () => {
    expect(enterpriseRegistry.id).toBe("antigravity-enterprise");
    expect(enterpriseRegistry.alias).toBe("age");
    expect(enterpriseRegistry.display.name).toBe("Gemini Enterprise (Antigravity)");
    expect(enterpriseRegistry.category).toBe("oauth");
    expect(enterpriseRegistry.serviceKinds).toEqual(["llm"]);
    expect(enterpriseRegistry.features?.usage).toBe(true);
    expect(resolveProviderAlias("age")).toBe("antigravity-enterprise");
    expect(resolveProviderAlias("antigravity-enterprise")).toBe("antigravity-enterprise");

    expect(enterpriseRegistry.transport.clientId).toBe(ANTIGRAVITY_ENTERPRISE_OAUTH_CLIENT.clientId);
    expect(enterpriseRegistry.transport.clientSecret).toBe(ANTIGRAVITY_ENTERPRISE_OAUTH_CLIENT.clientSecret);
    expect(ANTIGRAVITY_ENTERPRISE_OAUTH_CLIENT.clientId).not.toBe(ANTIGRAVITY_OAUTH_CLIENT.clientId);
    expect(ANTIGRAVITY_ENTERPRISE_OAUTH_CLIENT.clientSecret).not.toBe(ANTIGRAVITY_OAUTH_CLIENT.clientSecret);

    expect(enterpriseRegistry.oauth.scopes).toEqual([
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/cclog",
      "https://www.googleapis.com/auth/experimentsandconfigs",
    ]);
    expect(enterpriseRegistry.oauth.scopes).not.toContain("https://www.googleapis.com/auth/aicode");
  });

  it("registers OAuth handler, executor, and icon alias for antigravity-enterprise", () => {
    expect(getProvider("antigravity-enterprise")).toBe(antigravityEnterpriseOAuth);
    expect(getExecutor("antigravity-enterprise")).toBeInstanceOf(AntigravityEnterpriseExecutor);
    expect(getExecutor("antigravity")).toBeInstanceOf(AntigravityExecutor);
    expect(getExecutor("antigravity")).not.toBeInstanceOf(AntigravityEnterpriseExecutor);
    expect(resolveProviderIconId("antigravity-enterprise")).toBe("antigravity");
  });

  it("builds the enterprise Google OAuth authorize URL with enterprise client and 5 base scopes", () => {
    const authUrl = new URL(antigravityEnterpriseOAuth.buildAuthUrl(antigravityEnterpriseOAuth.config, "http://localhost/callback", "st123"));
    expect(authUrl.origin + authUrl.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(authUrl.searchParams.get("client_id")).toBe(ANTIGRAVITY_ENTERPRISE_OAUTH_CLIENT.clientId);
    expect(authUrl.searchParams.get("access_type")).toBe("offline");
    expect(authUrl.searchParams.get("prompt")).toBe("consent");
    expect(authUrl.searchParams.get("scope").split(" ")).not.toContain("https://www.googleapis.com/auth/aicode");
  });
});

describe("enterpriseModelName", () => {
  it.each([
    ["gemini-4-carbon-high", "gemini-4-carbon-high"],
    ["gemini-4-carbon-high(high)", "gemini-4-carbon-high"],
    ["gemini-4-carbon(high)", "gemini-4-carbon-high"],
    ["gemini-4-carbon", "gemini-4-carbon-medium"],
    ["gemini-3.8-flash", "gemini-3.8-flash-medium"],
    ["gemini-3.7-flash-low", "gemini-3.7-flash-low"],
    ["gemini-pro-agent", "gemini-3.1-pro-high"],
    ["gemini-3.5-flash-lite", "gemini-3.5-flash-lite"],
  ])("%s → %s", (model, expected) => {
    expect(enterpriseModelName(model)).toBe(expected);
  });
});

describe("AntigravityEnterpriseExecutor routing", () => {
  const enterpriseExecutor = new AntigravityEnterpriseExecutor();
  const consumerExecutor = new AntigravityExecutor();

  it("sends enterprise requests to the regional Business AI Code host", () => {
    expect(enterpriseExecutor.buildUrl("gemini-4-carbon-high", false, 0, enterprise)).toBe(`${BAIC}:generateContent`);
    expect(enterpriseExecutor.buildUrl("gemini-4-carbon-high", true, 0, enterprise)).toBe(`${BAIC}:streamGenerateContent?alt=sse`);
  });

  it("throws when enterprise credentials are missing license metadata", () => {
    expect(() => enterpriseExecutor.buildUrl("gemini-4-carbon-high", true, 0, consumer)).toThrow(/missing license metadata/i);
    expect(() => enterpriseExecutor.transformRequest("gemini-4-carbon-high", request(), true, consumer)).toThrow(/missing license metadata/i);
  });

  it("keeps consumer Antigravity strictly on Cloud Code even if enterpriseLicense is present", () => {
    expect(consumerExecutor.buildUrl("gemini-4-carbon-high", true, 0, consumer)).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
    expect(consumerExecutor.buildUrl("gemini-4-carbon-high", true, 0, enterprise)).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
    expect(consumerExecutor.buildUrl("gemini-4-carbon-high", true, 0, null)).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
    expect(consumerExecutor.buildHeaders(enterprise, true)).toHaveProperty("User-Agent");
    expect(consumerExecutor.buildHeaders(enterprise, true)).not.toHaveProperty("x-request-source");

    const body = consumerExecutor.transformRequest("gemini-4-carbon-medium(medium)", request(), true, enterprise);
    expect(body.project).toBe("acme-proj");
    expect(body.userAgent).toBe("antigravity");
    expect(body).not.toHaveProperty("entitlement");
  });

  it("builds a bare Gemini body with the entitlement for enterprise", () => {
    const body = enterpriseExecutor.transformRequest("gemini-4-carbon", request(), true, enterprise);
    expect(body).toEqual({
      model: "gemini-4-carbon-medium",
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      systemInstruction: { role: "user", parts: [{ text: "be terse" }] },
      generationConfig: { maxOutputTokens: 100 },
      tools: [{ functionDeclarations: [{ name: "foo", description: "x", parameters: { type: "object", properties: { a: { type: "string" } } } }] }],
      safetySettings: undefined,
      entitlement: { userTier: "gcp-ge-plus-tier" },
    });
  });

  it("keeps the Cloud Code envelope for consumer accounts", () => {
    const body = consumerExecutor.transformRequest("gemini-4-carbon-medium(medium)", request(), true, consumer);
    expect(body.project).toBe("consumer-proj");
    expect(body.model).toBe("gemini-4-carbon-medium(medium)");
    expect(body.userAgent).toBe("antigravity");
    expect(body.request.toolConfig).toEqual({ functionCallingConfig: { mode: "VALIDATED" } });
    expect(body).not.toHaveProperty("entitlement");
  });

  it("sends image generation for enterprise without the Cloud Code envelope", () => {
    const body = enterpriseExecutor.transformRequest("gemini-3-pro-image", request(), false, enterprise);
    expect(Object.keys(body).sort()).toEqual(["contents", "entitlement", "generationConfig", "model"]);
    expect(body.model).toBe("gemini-3-pro-image");
  });

  it("uses only the IDE's Business AI Code headers for enterprise", () => {
    expect(enterpriseExecutor.buildHeaders(enterprise, true)).toEqual({
      "Content-Type": "application/json",
      "Authorization": "Bearer tok",
      "x-request-source": "local",
    });
  });

  it("executes a streaming enterprise request against the regional URL", async () => {
    proxyAwareFetch.mockResolvedValue(new Response("data: {}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }));
    await enterpriseExecutor.execute({ model: "gemini-4-carbon-high", body: request(), stream: true, credentials: enterprise, log: null });
    const [url, init] = proxyAwareFetch.mock.calls[0];
    expect(url).toBe(`${BAIC}:streamGenerateContent?alt=sse`);
    const sent = JSON.parse(init.body);
    expect(sent.model).toBe("gemini-4-carbon-high");
    expect(sent.entitlement).toEqual({ userTier: "gcp-ge-plus-tier" });
    expect(sent).not.toHaveProperty("project");
    expect(sent).not.toHaveProperty("sessionId");
  });
});

describe("enterprise token refresh", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterAll(() => vi.unstubAllGlobals());

  it("refreshes antigravity-enterprise tokens via tokenRefresh.js using the enterprise OAuth client", async () => {
    fetchMock.mockResolvedValue(json({ access_token: "new-ent-tok", expires_in: 3600 }));
    const res = await getAccessToken("antigravity-enterprise", { refreshToken: "ref-ent" }, null);

    expect(res).toMatchObject({ accessToken: "new-ent-tok", refreshToken: "ref-ent", expiresIn: 3600 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    const params = new URLSearchParams(init.body);
    expect(params.get("client_id")).toBe(ANTIGRAVITY_ENTERPRISE_OAUTH_CLIENT.clientId);
    expect(params.get("client_secret")).toBe(ANTIGRAVITY_ENTERPRISE_OAUTH_CLIENT.clientSecret);
    expect(params.get("refresh_token")).toBe("ref-ent");
  });

  it("refreshes antigravity-enterprise tokens via AntigravityEnterpriseExecutor using the enterprise OAuth client", async () => {
    const enterpriseExecutor = new AntigravityEnterpriseExecutor();
    proxyAwareFetch.mockResolvedValue(json({ access_token: "exec-new-tok", expires_in: 3600 }));

    const res = await enterpriseExecutor.refreshCredentials(enterprise, null);
    expect(res).toMatchObject({ accessToken: "exec-new-tok", refreshToken: "ref-ent", expiresIn: 3600, projectId: "acme-proj" });
    const [, init] = proxyAwareFetch.mock.calls[0];
    const params = new URLSearchParams(init.body);
    expect(params.get("client_id")).toBe(ANTIGRAVITY_ENTERPRISE_OAUTH_CLIENT.clientId);
    expect(params.get("client_secret")).toBe(ANTIGRAVITY_ENTERPRISE_OAUTH_CLIENT.clientSecret);
  });

  it("formats credentials for antigravity-enterprise", () => {
    expect(formatProviderCredentials("antigravity-enterprise", enterprise, null)).toEqual({
      accessToken: "tok",
      refreshToken: "ref-ent",
      projectId: "acme-proj",
    });
  });
});

describe("enterprise models", () => {
  it("maps fetchConfig availableExperiences to model entries", () => {
    const models = parseEnterpriseConfigModels({
      availableExperiences: [
        {
          name: "gemini-4-carbon-high",
          model: { modelId: "gemini-4-carbon", displayName: "Gemini 4 Carbon (High)", inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedThinkingLevels: ["LOW", "MEDIUM", "HIGH"] },
        },
        { name: "gemini-3.5-flash-lite", model: {} },
      ],
      adminControls: {},
    });
    expect(models).toEqual([
      { id: "gemini-4-carbon-high", name: "Gemini 4 Carbon (High)", upstreamModelId: "gemini-4-carbon-high", contextLength: 1048576, maxOutputTokens: 65536, supportedThinkingLevels: ["LOW", "MEDIUM", "HIGH"] },
      { id: "gemini-3.5-flash-lite", name: "gemini-3.5-flash-lite", upstreamModelId: "gemini-3.5-flash-lite", contextLength: undefined, maxOutputTokens: undefined, supportedThinkingLevels: undefined },
    ]);
  });
});

describe("enterprise usage", () => {
  it("maps fetchQuotaStatus groups onto the weekly Gemini quota and routes via getUsageForProvider", async () => {
    proxyAwareFetch.mockResolvedValue(json({
      groups: [{
        displayName: "Gemini Enterprise Quota",
        description: "Your project's weekly Gemini Enterprise base quota.",
        buckets: [{ bucketId: "gemini-enterprise-weekly", displayName: "Weekly", window: "weekly", resetTime: "2026-11-26T08:08:48Z", remainingFraction: 0.25 }],
      }],
      overageInfo: {},
    }));

    const usage = await getUsageForProvider({
      provider: "antigravity-enterprise",
      accessToken: "tok",
      providerSpecificData: { enterpriseLicense: LICENSE },
    });

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    const [url, init] = proxyAwareFetch.mock.calls[0];
    expect(url).toBe(`${BAIC}:fetchQuotaStatus?entitlement.userTier=gcp-ge-plus-tier`);
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(usage).toEqual({
      plan: "Gemini Enterprise Plus",
      quotas: {
        gemini_weekly: {
          used: 750,
          total: 1000,
          resetAt: "2026-11-26T08:08:48.000Z",
          remainingPercentage: 25,
          unlimited: false,
          displayName: "Gemini (Weekly)",
        },
      },
    });

    const parsed = parseQuotaData("antigravity-enterprise", usage);
    expect(parsed).toEqual([
      expect.objectContaining({
        name: "Gemini (Weekly)",
        modelKey: "gemini_weekly",
        used: 750,
        total: 1000,
        remainingPercentage: 25,
      }),
    ]);
  });

  it("reports a quota API rejection without throwing", async () => {
    proxyAwareFetch.mockResolvedValue(json({ error: { code: 403 } }, 403));
    const usage = await getAntigravityEnterpriseUsage("tok", { enterpriseLicense: LICENSE });
    expect(usage).toEqual({ plan: "Gemini Enterprise Plus", message: "Antigravity enterprise quota API error (403). Chat may still work.", quotas: {} });
  });

  it("returns a clear message when enterprise license metadata is missing", async () => {
    const usage = await getAntigravityEnterpriseUsage("tok", {});
    expect(usage).toEqual({ message: "Antigravity enterprise license metadata missing. Reconnect the account.", quotas: {} });
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });

  it("keeps consumer getAntigravityUsage on Cloud Code even if enterpriseLicense is passed", async () => {
    proxyAwareFetch.mockResolvedValue(json({ models: {} }));
    await getAntigravityUsage("tok", { enterpriseLicense: LICENSE });
    expect(proxyAwareFetch.mock.calls.every(([url]) => !String(url).includes("businessaicode"))).toBe(true);
  });
});

describe("enterprise onboarding", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterAll(() => vi.unstubAllGlobals());

  it("selfAssignLicense posts {} to the global host and returns the license", async () => {
    fetchMock.mockResolvedValue(json({ license: LICENSE }));
    expect(await selfAssignAntigravityLicense("tok", "acme-proj", "eu")).toEqual(LICENSE);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://businessaicode.googleapis.com/v1beta/projects/acme-proj/locations/eu:selfAssignLicense");
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{}");
    expect(init.headers).toEqual({ "Authorization": "Bearer tok", "Content-Type": "application/json", "x-request-source": "local" });
  });

  it("selfAssignLicense returns null when the account has no license", async () => {
    fetchMock.mockResolvedValue(json({ error: { code: 400, message: "Precondition check failed." } }, 400));
    expect(await selfAssignAntigravityLicense("tok", "acme-proj", "us")).toBeNull();
  });

  it("persists the license when the caller names the project and location", async () => {
    fetchMock.mockImplementation(async (url) => {
      if (String(url).includes("/userinfo")) return json({ email: "dev@acme.test" });
      if (String(url).includes(":selfAssignLicense")) return json({ license: LICENSE });
      throw new Error(`unexpected ${url}`);
    });

    const extra = await antigravityEnterpriseOAuth.postExchange({ access_token: "tok" }, { projectId: "acme-proj", location: "eu" });
    const mapped = antigravityEnterpriseOAuth.mapTokens({ access_token: "tok", refresh_token: "r", expires_in: 3600 }, extra);

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://www.googleapis.com/oauth2/v1/userinfo?alt=json",
      "https://businessaicode.googleapis.com/v1beta/projects/acme-proj/locations/eu:selfAssignLicense",
    ]);
    expect(mapped).toMatchObject({
      accessToken: "tok",
      email: "dev@acme.test",
      projectId: "acme-proj",
      providerSpecificData: { enterpriseLicense: LICENSE },
    });
  });

  it("detects an enterprise account from fetchLicenses alone", async () => {
    fetchMock.mockImplementation(async (url) => {
      if (String(url).includes("/userinfo")) return json({ email: "dev@acme.test" });
      if (String(url).endsWith("v1beta:fetchLicenses")) return json({ licenses: [LICENSE] });
      if (String(url).includes(":selfAssignLicense")) return json({ license: LICENSE });
      throw new Error(`unexpected ${url}`);
    });

    const extra = await antigravityEnterpriseOAuth.postExchange({ access_token: "tok" });
    const mapped = antigravityEnterpriseOAuth.mapTokens({ access_token: "tok", refresh_token: "r", expires_in: 3600 }, extra);

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://www.googleapis.com/oauth2/v1/userinfo?alt=json",
      "https://businessaicode.googleapis.com/v1beta:fetchLicenses",
      "https://businessaicode.googleapis.com/v1beta/projects/acme-proj/locations/eu:selfAssignLicense",
    ]);
    expect(mapped).toMatchObject({
      email: "dev@acme.test",
      projectId: "acme-proj",
      providerSpecificData: { enterpriseLicense: LICENSE },
    });
  });

  it("matches a specific license when only meta.projectId is supplied", async () => {
    const second = { userTier: "gcp-ge-tier", tierDisplayName: "Gemini Enterprise", projectId: "other-proj", location: "us" };
    fetchMock.mockImplementation(async (url) => {
      if (String(url).includes("/userinfo")) return json({ email: "dev@acme.test" });
      if (String(url).endsWith("v1beta:fetchLicenses")) return json({ licenses: [second, LICENSE] });
      if (String(url).includes(":selfAssignLicense")) return json({ license: LICENSE });
      throw new Error(`unexpected ${url}`);
    });

    const extra = await antigravityEnterpriseOAuth.postExchange({ access_token: "tok" }, { projectId: "acme-proj" });
    expect(extra.enterpriseLicense).toEqual(LICENSE);
  });

  it("fails onboarding with a clear error when no Gemini Enterprise license is found", async () => {
    fetchMock.mockImplementation(async (url) => {
      if (String(url).includes("/userinfo")) return json({ email: "dev@gmail.test" });
      if (String(url).endsWith("v1beta:fetchLicenses")) return json({ licenses: [] });
      throw new Error(`unexpected ${url}`);
    });

    await expect(antigravityEnterpriseOAuth.postExchange({ access_token: "tok" }))
      .rejects.toThrow(/No Gemini Enterprise license found/i);
  });

  it("fails onboarding with a clear error when an explicit project/location has no license", async () => {
    fetchMock.mockImplementation(async (url) => {
      if (String(url).includes("/userinfo")) return json({ email: "dev@acme.test" });
      if (String(url).includes(":selfAssignLicense")) return json({ error: { code: 400 } }, 400);
      throw new Error(`unexpected ${url}`);
    });

    await expect(antigravityEnterpriseOAuth.postExchange({ access_token: "tok" }, { projectId: "missing-proj", location: "us" }))
      .rejects.toThrow(/missing-proj.*us/i);
  });

  it("fetchLicenses returns [] when the endpoint fails", async () => {
    fetchMock.mockResolvedValue(json({ error: { code: 403 } }, 403));
    expect(await fetchAntigravityLicenses("tok")).toEqual([]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://businessaicode.googleapis.com/v1beta:fetchLicenses");
    expect(init.method).toBe("GET");
  });

  it("keeps consumer antigravity onboarding pure Cloud Code (never calls Business AI Code)", async () => {
    fetchMock.mockImplementation(async (url) => {
      if (String(url).includes("/userinfo")) return json({ email: "dev@gmail.test" });
      if (String(url).includes(":loadCodeAssist")) return json({ cloudaicompanionProject: "consumer-proj", allowedTiers: [] });
      if (String(url).includes(":onboardUser")) return json({ done: true });
      throw new Error(`unexpected ${url}`);
    });

    const extra = await antigravityOAuth.postExchange({ access_token: "tok" }, { projectId: "acme-proj", location: "eu" });
    const mapped = antigravityOAuth.mapTokens({ access_token: "tok" }, extra);

    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("businessaicode"))).toBe(false);
    expect(mapped.projectId).toBe("consumer-proj");
    expect(mapped).not.toHaveProperty("providerSpecificData");
  });
});

describe("enterprise models route", () => {
  const originalDataDir = process.env.DATA_DIR;
  const fetchMock = vi.fn();
  let GET;
  let createProviderConnection;

  beforeAll(async () => {
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "9router-ag-enterprise-"));
    vi.resetModules();
    ({ GET } = await import("@/app/api/providers/[id]/models/route.js"));
    ({ createProviderConnection } = await import("@/models/index.js"));
  });

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("lists the admin-allowed experiences from fetchConfig for antigravity-enterprise", async () => {
    fetchMock.mockResolvedValue(json({
      availableExperiences: [{ name: "gemini-4-carbon-high", model: { displayName: "Gemini 4 Carbon (High)" } }],
    }));
    const conn = await createProviderConnection({
      provider: "antigravity-enterprise",
      authType: "oauth",
      accessToken: "tok",
      email: "dev@acme.test",
      projectId: "acme-proj",
      providerSpecificData: { enterpriseLicense: LICENSE },
      testStatus: "active",
    });

    const res = await GET(new Request(`http://localhost/api/providers/${conn.id}/models`), { params: Promise.resolve({ id: conn.id }) });
    const data = await res.json();

    expect(fetchMock.mock.calls[0][0]).toBe(`${BAIC}:fetchConfig?entitlement.userTier=gcp-ge-plus-tier`);
    expect(fetchMock.mock.calls[0][1].method).toBe("GET");
    expect(data.models.map((m) => [m.id, m.name])).toEqual([["gemini-4-carbon-high", "Gemini 4 Carbon (High)"]]);
  });

  it("refreshes expired tokens on 401 using the enterprise OAuth client", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ error: { code: 401 } }, 401))
      .mockResolvedValueOnce(json({ access_token: "fresh-tok", expires_in: 3600 }))
      .mockResolvedValueOnce(json({
        availableExperiences: [{ name: "gemini-4-neon-high", model: { displayName: "Gemini 4 Neon (High)" } }],
      }));
    const conn = await createProviderConnection({
      provider: "antigravity-enterprise",
      authType: "oauth",
      accessToken: "stale-tok",
      refreshToken: "ref-ent",
      email: "dev@acme.test",
      projectId: "acme-proj",
      providerSpecificData: { enterpriseLicense: LICENSE },
      testStatus: "active",
    });

    const res = await GET(new Request(`http://localhost/api/providers/${conn.id}/models`), { params: Promise.resolve({ id: conn.id }) });
    const data = await res.json();

    expect(fetchMock.mock.calls[1][0]).toBe("https://oauth2.googleapis.com/token");
    const refreshParams = new URLSearchParams(fetchMock.mock.calls[1][1].body);
    expect(refreshParams.get("client_id")).toBe(ANTIGRAVITY_ENTERPRISE_OAUTH_CLIENT.clientId);
    expect(refreshParams.get("client_secret")).toBe(ANTIGRAVITY_ENTERPRISE_OAUTH_CLIENT.clientSecret);
    expect(data.models.map((m) => m.id)).toEqual(["gemini-4-neon-high"]);
  });

  it("does not route consumer antigravity connections to Business AI Code", async () => {
    fetchMock.mockResolvedValue(json({ models: [{ id: "gemini-4-neon-high" }] }));
    const conn = await createProviderConnection({
      provider: "antigravity",
      authType: "oauth",
      accessToken: "tok",
      email: "dev@gmail.test",
      projectId: "consumer-proj",
      providerSpecificData: { enterpriseLicense: LICENSE },
      testStatus: "active",
    });

    await GET(new Request(`http://localhost/api/providers/${conn.id}/models`), { params: Promise.resolve({ id: conn.id }) });
    expect(fetchMock.mock.calls[0][0]).toBe("https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:models");
  });
});
