import { NextRequest } from "next/server";
import { json, err } from "@/lib/db";
import { getSettingValue } from "@/lib/settings";

/**
 * POST /api/agents/connect-store — Connect a Vercel Marketplace store to a project.
 * Body: { store_id: string, project_id: string }
 * Auth: CRON_SECRET
 */
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return err("Unauthorized", 401);
  }

  try {
    const { store_id, project_id } = await req.json();
    if (!store_id || !project_id) return err("store_id and project_id required", 400);

    const [token, teamId] = await Promise.all([
      getSettingValue("vercel_token"),
      getSettingValue("vercel_team_id"),
    ]);
    if (!token) return err("Vercel token not configured", 500);

    const teamParam = teamId ? `?teamId=${teamId}` : "";
    const results: Record<string, unknown> = {};

    // Try primary: /v1/storage/stores/{storeId}/connections
    try {
      const res = await fetch(
        `https://api.vercel.com/v1/storage/stores/${store_id}/connections${teamParam}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            projectId: project_id,
            environmentVariableSuffix: "",
          }),
        }
      );
      results.primary_status = res.status;
      results.primary = await res.json();
      if (res.ok) {
        return json({ ok: true, method: "storage/stores/connections", ...results });
      }
    } catch (e: unknown) {
      results.primary_error = e instanceof Error ? e.message : String(e);
    }

    // Try fallback: /v1/projects/{projectId}/store-connections
    try {
      const res = await fetch(
        `https://api.vercel.com/v1/projects/${project_id}/store-connections${teamParam}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            storeId: store_id,
            environmentVariableSuffix: "",
          }),
        }
      );
      results.fallback_status = res.status;
      results.fallback = await res.json();
      if (res.ok) {
        return json({ ok: true, method: "projects/store-connections", ...results });
      }
    } catch (e: unknown) {
      results.fallback_error = e instanceof Error ? e.message : String(e);
    }

    return json({ ok: false, results });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(msg, 500);
  }
}
