import { NextRequest } from "next/server";
import { json, err } from "@/lib/db";
import { getSettingValue } from "@/lib/settings";

/**
 * POST /api/agents/connect-store — Replace a Neon store on a Vercel project.
 * Body: { store_id: string, project_id: string, disconnect_store_id?: string, integration_config_id?: string }
 * Auth: CRON_SECRET
 *
 * Strategy: delete old Neon env vars first, then connect new store via installations API.
 * project_id must be a prj_ ID (not a slug).
 */

const NEON_ENV_KEYS = [
  "DATABASE_URL", "DATABASE_URL_UNPOOLED",
  "PGHOST", "PGHOST_UNPOOLED", "PGUSER", "PGDATABASE", "PGPASSWORD",
  "POSTGRES_URL", "POSTGRES_URL_UNPOOLED", "POSTGRES_URL_NON_POOLING",
  "POSTGRES_HOST", "POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DATABASE",
  "POSTGRES_PRISMA_URL",
];

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return err("Unauthorized", 401);
  }

  try {
    const { store_id, project_id, disconnect_store_id, integration_config_id } = await req.json();
    if (!store_id || !project_id) return err("store_id and project_id required", 400);

    const [token, teamId] = await Promise.all([
      getSettingValue("vercel_token"),
      getSettingValue("vercel_team_id"),
    ]);
    if (!token) return err("Vercel token not configured", 500);

    const teamParam = teamId ? `?teamId=${teamId}` : "";
    const results: Record<string, unknown> = {};

    // Step 0: If disconnecting old store, remove its env vars from the project
    if (disconnect_store_id) {
      // List all env vars on the project
      try {
        const envRes = await fetch(
          `https://api.vercel.com/v9/projects/${project_id}/env${teamParam}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (envRes.ok) {
          const envData = await envRes.json();
          const allEnvs = envData.envs || [];
          results.total_env_vars = allEnvs.length;

          // Find Neon-related env vars to delete
          const neonEnvIds = allEnvs
            .filter((e: { key: string }) => NEON_ENV_KEYS.includes(e.key))
            .map((e: { id: string; key: string }) => ({ id: e.id, key: e.key }));
          results.neon_env_vars_found = neonEnvIds;

          if (neonEnvIds.length > 0) {
            // Batch delete the Neon env vars
            const delRes = await fetch(
              `https://api.vercel.com/v1/projects/${project_id}/env${teamParam}`,
              {
                method: "DELETE",
                headers: {
                  Authorization: `Bearer ${token}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  ids: neonEnvIds.map((e: { id: string }) => e.id),
                }),
              }
            );
            results.delete_env_status = delRes.status;
            results.delete_env = await delRes.json().catch(() => ({}));
          }
        } else {
          results.env_list_error = envRes.status;
        }
      } catch (e: unknown) {
        results.env_error = e instanceof Error ? e.message : String(e);
      }
    }

    // Step 1: Connect new store via installations API (preferred)
    const configId = integration_config_id || "icfg_6qDnLTXfjp7za9aJlJ7cYWRe";
    try {
      const res = await fetch(
        `https://api.vercel.com/v1/integrations/installations/${configId}/resources/${store_id}/connections${teamParam}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ projectId: project_id }),
        }
      );
      results.connect_installations_status = res.status;
      results.connect_installations = await res.json().catch(() => ({}));
      if (res.ok) {
        return json({ ok: true, method: "installations/resources/connections", ...results });
      }
    } catch (e: unknown) {
      results.connect_installations_error = e instanceof Error ? e.message : String(e);
    }

    // Step 2: Fallback — connect via storage/stores API
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
      results.connect_storage_status = res.status;
      results.connect_storage = await res.json().catch(() => ({}));
      if (res.ok) {
        return json({ ok: true, method: "storage/stores/connections", ...results });
      }
    } catch (e: unknown) {
      results.connect_storage_error = e instanceof Error ? e.message : String(e);
    }

    return json({ ok: false, results });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(msg, 500);
  }
}
