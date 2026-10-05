import { resetQuota, CompatError } from "@/lib/cliproxyCompat";

export const dynamic = "force-dynamic";

// POST /v0/management/reset-quota — CLIProxyAPI-compatible (API key gated in dashboardGuard)
export async function POST(request) {
  let input;
  try {
    input = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  try {
    return Response.json(await resetQuota(input));
  } catch (error) {
    if (error instanceof CompatError) return Response.json({ error: error.message }, { status: error.status });
    console.error("[CLIProxy compat] reset-quota failed:", error);
    return Response.json({ error: "Request failed" }, { status: 500 });
  }
}
