import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ proxyAwareFetch: vi.fn() }));
vi.mock("open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.proxyAwareFetch }));

const { getClaudeUsage } = await import("../../open-sse/services/usage/claude.js");

describe("Claude usage when Anthropic rate-limits the usage endpoint", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reports the rate limit instead of the legacy admin-permissions message", async () => {
    mocks.proxyAwareFetch.mockResolvedValue({ ok: false, status: 429 });

    const usage = await getClaudeUsage("token-429", null, { force: true });

    expect(usage).toEqual({ message: "Claude usage API rate-limited by Anthropic. Retrying in 3 min." });
    expect(mocks.proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(mocks.proxyAwareFetch.mock.calls[0][0]).toBe("https://api.anthropic.com/api/oauth/usage?cedar_ember=1");
  });

  it("does not call Anthropic again during the cooldown", async () => {
    mocks.proxyAwareFetch.mockResolvedValue({ ok: false, status: 429 });
    await getClaudeUsage("token-cool", null, { force: true });

    const usage = await getClaudeUsage("token-cool", null, { force: true });

    expect(usage.message).toMatch(/rate-limited/);
    expect(mocks.proxyAwareFetch).toHaveBeenCalledTimes(1);
  });
});
