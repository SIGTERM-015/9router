import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const lookupMock = vi.fn();
vi.mock("node:dns/promises", () => ({
  lookup: async (host, opts) => {
    const record = await lookupMock(host, opts);
    return opts?.all ? [record] : record;
  },
}));

const { resolveImageBytes } = await import("../../open-sse/executors/uc-web.js");
const { resolveImageRef } = await import("../../open-sse/executors/muse-web.js");

describe("caller-supplied image URLs in the web executors", () => {
  beforeEach(() => {
    lookupMock.mockReset();
    globalThis.fetch = vi.fn(async () => ({ ok: true, body: null }));
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it.each([
    ["cloud metadata", "http://169.254.169.254/latest/meta-data/"],
    ["loopback", "http://127.0.0.1:20128/api/settings"],
    ["private network", "http://10.0.0.5/internal.png"],
  ])("muse-web never fetches %s", async (_label, url) => {
    lookupMock.mockResolvedValue({ address: new URL(url).hostname });

    expect(await resolveImageRef(url)).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("muse-web never fetches a public name that resolves to a private address", async () => {
    lookupMock.mockResolvedValue({ address: "192.168.1.10" });

    expect(await resolveImageRef("https://rebind.example.com/a.png")).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("uc-web never fetches the cloud metadata address", async () => {
    lookupMock.mockResolvedValue({ address: "169.254.169.254" });

    await expect(resolveImageBytes("http://169.254.169.254/latest/meta-data/")).rejects.toThrow("input image download failed");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
