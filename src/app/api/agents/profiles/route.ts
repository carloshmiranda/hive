import { NextRequest } from "next/server";
import { json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { validateOIDC } from "@/lib/oidc";
import { getAgentProfiles } from "@/lib/agent-profiles";

export const dynamic = "force-dynamic";

// GET /api/agents/profiles
// Returns agent specialization profiles computed from the last 30 days of agent_actions.
// Auth: session (dashboard), OIDC (GitHub Actions), or Bearer CRON_SECRET.
export async function GET(req: NextRequest) {
  // Check auth: OIDC, CRON_SECRET, or session
  const authHeader = req.headers.get("authorization");
  const isCron = authHeader === `Bearer ${process.env.CRON_SECRET}`;

  if (!isCron) {
    // Try OIDC first (GitHub Actions)
    if (authHeader?.startsWith("Bearer ")) {
      const oidcResult = await validateOIDC(req);
      if (oidcResult instanceof Response) {
        // OIDC failed — fall back to session auth
        const session = await requireAuth();
        if (!session) return err("Unauthorized", 401);
      }
    } else {
      // No bearer token — try session auth
      const session = await requireAuth();
      if (!session) return err("Unauthorized", 401);
    }
  }

  try {
    const result = await getAgentProfiles();
    return json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(`Failed to compute agent profiles: ${message}`, 500);
  }
}
