import { runDiscovery, getDiscoveryState } from "@/lib/modelDiscovery";

export const dynamic = "force-dynamic";

// GET /v0/models/sync — what a run would add, without changing anything (API key gated in dashboardGuard)
export async function GET() {
  try {
    const results = await runDiscovery({ dryRun: true });
    if (!results) return Response.json({ error: "Discovery already running" }, { status: 409 });
    return Response.json({ dryRun: true, results, state: getDiscoveryState() });
  } catch (error) {
    console.error("[modelDiscovery] dry run failed:", error);
    return Response.json({ error: "Failed to list models" }, { status: 500 });
  }
}

// POST /v0/models/sync — discover and register models the built-in tables do not know yet
export async function POST() {
  try {
    const results = await runDiscovery();
    if (!results) return Response.json({ error: "Discovery already running" }, { status: 409 });
    return Response.json({ dryRun: false, results, state: getDiscoveryState() });
  } catch (error) {
    console.error("[modelDiscovery] failed:", error);
    return Response.json({ error: "Failed to sync models" }, { status: 500 });
  }
}
