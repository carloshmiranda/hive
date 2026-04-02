/**
 * POST /api/settings/edge-sync
 *
 * Reconciles Edge Config with current Neon settings values.
 * Run this after initial Edge Config setup or after any config drift.
 *
 * Auth: session or CRON_SECRET
 */
import { json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { syncAllFlagsToEdgeConfig } from "@/lib/edge-config";
import { getSettingValue } from "@/lib/settings";
import { setSentryTags } from "@/lib/sentry-tags";

export async function POST(req: Request) {
  setSentryTags({ action_type: "admin", route: "/api/settings/edge-sync" });

  const authHeader = req.headers.get("authorization");
  const isCronAuth = authHeader === `Bearer ${process.env.CRON_SECRET}`;
  if (!isCronAuth) {
    const session = await requireAuth();
    if (!session) return err("Unauthorized", 401);
  }

  if (!process.env.EDGE_CONFIG) {
    return json({ synced: false, reason: "EDGE_CONFIG env var not set — Edge Config not configured" });
  }

  const vercelToken = await getSettingValue("vercel_token").catch(() => null);
  const results = await syncAllFlagsToEdgeConfig(vercelToken);

  const allSynced = Object.values(results).every(r => r.synced);
  return json({ synced: allSynced, results });
}
