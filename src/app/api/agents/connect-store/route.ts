import { NextRequest } from "next/server";
import { json, err } from "@/lib/db";
import { getSettingValue } from "@/lib/settings";

/**
 * POST /api/agents/connect-store — Connect a Vercel Marketplace store to a project.
 * Body: { store_id: string, project_id: string, disconnect_store_id?: string }
 * Auth: CRON_SECRET
 *
 * If disconnect_store_id is provided, disconnects that store first (removes env vars).
 */
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return err("Unauthorized", 401);
  }

  try {
    const { store_id, project_id, disconnect_store_id } = await req.json();
    if (!store_id || !project_id) return err("store_id and project_id required", 400);

    const [token, teamId] = await Promise.all([
      getSettingValue("vercel_token"),
      getSettingValue("vercel_team_id"),
    ]);
    if (!token) return err("Vercel token not configured", 500);

    const teamParam = teamId ? `?teamId=${teamId}` : "";
    const results: Record<string, unknown> = {};

    // Step 0: Disconnect old store if requested
    if (disconnect_store_id) {
      try {
        const res = await fetch(
          `https://api.vercel.com/v1/storage/stores/${disconnect_store_id}/connections/${project_id}${teamParam}`,
          {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` },
          }
        );
        results.disconnect_status = res.status;
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          results.disconnect_error = body;
        } else {
          results.disconnect = "ok";
        }
      } catch (e: unknown) {
        results.disconnect_error = e instanceof Error ? e.message : String(e);
      }
    }

    // Step 1: Connect new store via /v1/storage/stores/{storeId}/connections
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
      results.connect_status = res.status;
      results.connect = await res.json();
      if (res.ok) {
        return json({ ok: true, method: "storage/stores/connections", ...results });
      }
    } catch (e: unknown) {
      results.connect_error = e instanceof Error ? e.message : String(e);
    }

    return json({ ok: false, results });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(msg, 500);
  }
}
