import { getQuotaSnapshot } from "@/lib/quotaSnapshot";

export const dynamic = "force-dynamic";

// GET /v0/quota — quota windows of every account with a usage API (API key gated in dashboardGuard)
export async function GET() {
  try {
    return Response.json(await getQuotaSnapshot());
  } catch (error) {
    console.error("[Quota snapshot] failed:", error);
    return Response.json({ error: "Failed to read quotas" }, { status: 500 });
  }
}
