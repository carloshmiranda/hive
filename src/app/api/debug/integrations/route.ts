import { NextRequest } from "next/server";
import { json, err } from "@/lib/db";
import { getSettingValue } from "@/lib/settings";

export async function GET(req: NextRequest) {
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

  // Try listing stores
  try {
    const res = await fetch(`https://api.vercel.com/v1/stores?teamId=${teamId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    results.stores_status = res.status;
    results.stores = await res.json();
  } catch (e: any) {
    results.stores_error = e.message;
  }

  return json(results);
}
