// Enterprise Antigravity accounts (Gemini Enterprise license) are served by Business AI Code:
// regional host, bare Gemini body + entitlement, experience model names.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";

const proxyAwareFetch = vi.hoisted(() => vi.fn());
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));

import { AntigravityExecutor, enterpriseModelName } from "../../open-sse/executors/antigravity.js";
import { getAntigravityUsage } from "../../open-sse/services/usage/google.js";
import { parseEnterpriseConfigModels, selfAssignAntigravityLicense } from "../../open-sse/services/antigravityEnterprise.js";
import antigravityOAuth from "../../src/lib/oauth/providers/antigravity.js";

const LICENSE = { userTier: "gcp-ge-plus-tier", tierDisplayName: "Gemini Enterprise Plus", projectId: "acme-proj", location: "eu" };
const BAIC = "https://businessaicode.eu.rep.googleapis.com/v1beta/projects/acme-proj/locations/eu";

const enterprise = { accessToken: "tok", projectId: "acme-proj", connectionId: "c1", providerSpecificData: { enterpriseLicense: LICENSE } };
const consumer = { accessToken: "tok", projectId: "consumer-proj", connectionId: "c1", providerSpecificData: {} };

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

describe("AntigravityExecutor routing", () => {
  const executor = new AntigravityExecutor();

  it("sends enterprise accounts to the regional Business AI Code host", () => {
    expect(executor.buildUrl("gemini-4-carbon-high", false, 0, enterprise)).toBe(`${BAIC}:generateContent`);
    expect(executor.buildUrl("gemini-4-carbon-high", true, 0, enterprise)).toBe(`${BAIC}:streamGenerateContent?alt=sse`);
  });

  it("keeps consumer accounts on Cloud Code", () => {
    expect(executor.buildUrl("gemini-4-carbon-high", true, 0, consumer)).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
    expect(executor.buildUrl("gemini-4-carbon-high", true, 0, null)).toBe("https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse");
  });

  it("builds a bare Gemini body with the entitlement for enterprise", () => {
    const body = executor.transformRequest("gemini-4-carbon", request(), true, enterprise);
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
    const body = executor.transformRequest("gemini-4-carbon-medium(medium)", request(), true, consumer);
    expect(body.project).toBe("consumer-proj");
    expect(body.model).toBe("gemini-4-carbon-medium(medium)");
    expect(body.userAgent).toBe("antigravity");
    expect(body.request.toolConfig).toEqual({ functionCallingConfig: { mode: "VALIDATED" } });
    expect(body).not.toHaveProperty("entitlement");
  });

  it("sends image generation for enterprise without the Cloud Code envelope", () => {
    const body = executor.transformRequest("gemini-3-pro-image", request(), false, enterprise);
    expect(Object.keys(body).sort()).toEqual(["contents", "entitlement", "generationConfig", "model"]);
    expect(body.model).toBe("gemini-3-pro-image");
  });

  it("uses only the IDE's Business AI Code headers for enterprise", () => {
    expect(executor.buildHeaders(enterprise, true)).toEqual({
      "Content-Type": "application/json",
      "Authorization": "Bearer tok",
      "x-request-source": "local",
    });
  });

  it("executes a streaming enterprise request against the regional URL", async () => {
    proxyAwareFetch.mockResolvedValue(new Response("data: {}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }));
    await executor.execute({ model: "gemini-4-carbon-high", body: request(), stream: true, credentials: enterprise, log: null });
    const [url, init] = proxyAwareFetch.mock.calls[0];
    expect(url).toBe(`${BAIC}:streamGenerateContent?alt=sse`);
    const sent = JSON.parse(init.body);
    expect(sent.model).toBe("gemini-4-carbon-high");
    expect(sent.entitlement).toEqual({ userTier: "gcp-ge-plus-tier" });
    expect(sent).not.toHaveProperty("project");
    expect(sent).not.toHaveProperty("sessionId");
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
  it("maps fetchQuotaStatus groups onto the weekly Gemini quota", async () => {
    proxyAwareFetch.mockResolvedValue(json({
      groups: [{
        displayName: "Gemini Enterprise Quota",
        description: "Your project's weekly Gemini Enterprise base quota.",
        buckets: [{ bucketId: "gemini-enterprise-weekly", displayName: "Weekly", window: "weekly", resetTime: "2026-11-26T08:08:48Z", remainingFraction: 0.25 }],
      }],
      overageInfo: {},
    }));

    const usage = await getAntigravityUsage("tok", { enterpriseLicense: LICENSE });

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
  });

  it("reports a quota API rejection without throwing", async () => {
    proxyAwareFetch.mockResolvedValue(json({ error: { code: 403 } }, 403));
    const usage = await getAntigravityUsage("tok", { enterpriseLicense: LICENSE });
    expect(usage).toEqual({ plan: "Gemini Enterprise Plus", message: "Antigravity enterprise quota API error (403). Chat may still work.", quotas: {} });
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

    const extra = await antigravityOAuth.postExchange({ access_token: "tok" }, { projectId: "acme-proj", location: "eu" });
    const mapped = antigravityOAuth.mapTokens({ access_token: "tok", refresh_token: "r", expires_in: 3600 }, extra);

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

  it("falls back to the consumer flow without a project/location", async () => {
    fetchMock.mockImplementation(async (url) => {
      if (String(url).includes("/userinfo")) return json({ email: "dev@gmail.test" });
      if (String(url).includes(":loadCodeAssist")) return json({ cloudaicompanionProject: null, allowedTiers: [] });
      throw new Error(`unexpected ${url}`);
    });

    const extra = await antigravityOAuth.postExchange({ access_token: "tok" });
    const mapped = antigravityOAuth.mapTokens({ access_token: "tok" }, extra);

    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("businessaicode"))).toBe(false);
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

  afterAll(() => {
    vi.unstubAllGlobals();
    fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("lists the admin-allowed experiences from fetchConfig", async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(json({
      availableExperiences: [{ name: "gemini-4-carbon-high", model: { displayName: "Gemini 4 Carbon (High)" } }],
    }));
    const conn = await createProviderConnection({
      provider: "antigravity",
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
});
