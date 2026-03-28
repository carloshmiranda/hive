import { NextRequest } from "next/server";
import { json, err } from "@/lib/db";
import { getSettingValue } from "@/lib/settings";
import { setSentryTags } from "@/lib/sentry-tags";

/**
 * POST /api/agents/connect-store — Replace a Neon store on a Vercel project.
 * Body: { store_id: string, project_id: string, disconnect_store_id?: string, integration_config_id?: string }
 *
 * GET /api/agents/connect-store?project_id=X&action=list_envs — List env vars (no mutations)
 * GET /api/agents/connect-store?project_id=X&action=get_env&key=DATABASE_URL — Get decrypted env var value
 * GET /api/agents/connect-store?project_id=X&action=disconnect_store&store_id=Y&config_id=Z — Remove store connection
 *
 * Auth: CRON_SECRET
 *
 * Strategy: delete old Neon env vars first, then connect new store via installations API.
 * project_id must be a prj_ ID (not a slug).
 */

const NEON_ENV_KEYS = [
  "DATABASE_URL", "DATABASE_URL_UNPOOLED",
  "PGHOST", "PGHOST_UNPOOLED", "PGUSER", "PGDATABASE", "PGPASSWORD",
  "POSTGRES_URL", "POSTGRES_URL_UNPOOLED", "POSTGRES_URL_NON_POOLING",
  "POSTGRES_URL_NO_SSL", "POSTGRES_HOST", "POSTGRES_USER",
  "POSTGRES_PASSWORD", "POSTGRES_DATABASE", "POSTGRES_PRISMA_URL",
  "NEON_PROJECT_ID", "NEON_DATABASE_NAME", "NEON_BRANCH_ID",
];

export async function GET(req: NextRequest) {
  setSentryTags({
    action_type: "agent_api",
    route: "/api/agents/connect-store",
  });

  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return err("Unauthorized", 401);
  }

  const url = new URL(req.url);
  const projectId = url.searchParams.get("project_id");
  const action = url.searchParams.get("action") || "list_envs";
  if (!projectId) return err("project_id required", 400);

  const [token, teamId] = await Promise.all([
    getSettingValue("vercel_token"),
    getSettingValue("vercel_team_id"),
  ]);
  if (!token) return err("Vercel token not configured", 500);
  const teamParam = teamId ? `?teamId=${teamId}` : "";

  try {
    if (action === "list_envs") {
      const res = await fetch(
        `https://api.vercel.com/v9/projects/${projectId}/env${teamParam}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const data = await res.json();
      const envs = (data.envs || []).map((e: { id: string; key: string; target?: string[] }) => ({
        id: e.id, key: e.key, target: e.target,
      }));
      return json({ ok: true, total: envs.length, envs });
    }

    if (action === "get_env") {
      const key = url.searchParams.get("key");
      if (!key) return err("key required", 400);
      // List envs to find the ID
      const listRes = await fetch(
        `https://api.vercel.com/v9/projects/${projectId}/env${teamParam}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const listData = await listRes.json();
      const env = (listData.envs || []).find((e: { key: string }) => e.key === key);
      if (!env) return json({ ok: false, error: `${key} not found` });
      // Fetch decrypted value
      const detailRes = await fetch(
        `https://api.vercel.com/v9/projects/${projectId}/env/${env.id}${teamParam}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const detail = await detailRes.json();
      return json({ ok: true, key, value: detail.value || null });
    }

    if (action === "disconnect_store") {
      const storeId = url.searchParams.get("store_id");
      const configId = url.searchParams.get("config_id") || "icfg_6qDnLTXfjp7za9aJlJ7cYWRe";
      if (!storeId) return err("store_id required", 400);

      // List connections for this store
      const listRes = await fetch(
        `https://api.vercel.com/v1/integrations/installations/${configId}/resources/${storeId}/connections${teamParam}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const listData = await listRes.json();
      const connections = Array.isArray(listData) ? listData : listData.connections || [];
      const match = connections.find((c: { projectId?: string }) => c.projectId === projectId);

      if (!match) {
        // Try storage API
        const storeRes = await fetch(
          `https://api.vercel.com/v1/storage/stores/${storeId}/connections${teamParam}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const storeData = await storeRes.json();
        const storeConns = Array.isArray(storeData) ? storeData : storeData.connections || [];
        const storeMatch = storeConns.find((c: { projectId?: string }) => c.projectId === projectId);
        if (storeMatch) {
          const delRes = await fetch(
            `https://api.vercel.com/v1/storage/stores/${storeId}/connections/${storeMatch.id}${teamParam}`,
            { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }
          );
          return json({ ok: delRes.ok, method: "storage", status: delRes.status, connection_id: storeMatch.id });
        }
        return json({ ok: false, error: "No connection found", connections_checked: connections.length + storeConns.length });
      }

      // Delete via installations API
      const delRes = await fetch(
        `https://api.vercel.com/v1/integrations/installations/${configId}/resources/${storeId}/connections/${match.id}${teamParam}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }
      );
      return json({ ok: delRes.ok, method: "installations", status: delRes.status, connection_id: match.id });
    }

    return err(`Unknown action: ${action}`, 400);
  } catch (e: unknown) {
    return err(e instanceof Error ? e.message : String(e), 500);
  }
}

export async function POST(req: NextRequest) {
  setSentryTags({
    action_type: "agent_api",
    route: "/api/agents/connect-store",
  });

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
