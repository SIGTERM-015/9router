import { listAuthFiles } from "@/lib/cliproxyCompat";

export const dynamic = "force-dynamic";

// GET /v0/management/auth-files — CLIProxyAPI-compatible account list (API key gated in dashboardGuard)
export async function GET() {
  try {
    return Response.json(await listAuthFiles());
  } catch (error) {
    console.error("[CLIProxy compat] auth-files failed:", error);
    return Response.json({ error: "Failed to list accounts" }, { status: 500 });
  }
}
