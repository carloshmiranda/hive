import { NextRequest } from "next/server";
import { json, err } from "@/lib/db";
import { getSettingValue } from "@/lib/settings";
import { setSentryTags } from "@/lib/sentry-tags";

export async function GET(req: NextRequest) {
  setSentryTags({
    action_type: "agent_api",
    route: "/api/agents/debug-integrations",
  });

  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return err("Unauthorized", 401);
  }

  const token = await getSettingValue("vercel_token");
  const teamId = await getSettingValue("vercel_team_id");

  const results: Record<string, unknown> = {};

  // Try view=account
  try {
    const res = await fetch(`https://api.vercel.com/v1/integrations/configurations?view=account&teamId=${teamId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    results.account_status = res.status;
    results.account = await res.json();
  } catch (e: any) {
    results.account_error = e.message;
  }

  // Try listing stores via correct endpoint
  try {
    const res = await fetch(`https://api.vercel.com/v1/storage/stores?teamId=${teamId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    results.stores_status = res.status;
    results.stores = await res.json();
  } catch (e: any) {
    results.stores_error = e.message;
  }

  // Find Neon integration config and list its products
  const configs = results.account as any;
  const neonConfig = configs?.configurations?.find((c: any) =>
    c.slug === "neon" || c.integration?.slug === "neon"
  );
  if (neonConfig) {
    results.neon_config_id = neonConfig.id;
    try {
      const res = await fetch(`https://api.vercel.com/v1/integrations/configurations/${neonConfig.id}/products?teamId=${teamId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      results.neon_products_status = res.status;
      results.neon_products = await res.json();
    } catch (e: any) {
      results.neon_products_error = e.message;
    }

    // Also try listing existing stores for this integration
    try {
      const res = await fetch(`https://api.vercel.com/v1/storage/stores?integrationConfigurationId=${neonConfig.id}&teamId=${teamId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      results.neon_stores_status = res.status;
      results.neon_stores = await res.json();
    } catch (e: any) {
      results.neon_stores_error = e.message;
    }
  }

  return json(results);
}
