import { NextRequest } from "next/server";
import { json, err } from "@/lib/db";
import { notifyHive } from "@/lib/telegram";

// POST /api/notify — send a Telegram notification
// Auth: CRON_SECRET or OIDC
// Body: { agent, action, company?, status, summary, details? }
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (authHeader !== `Bearer ${cronSecret}`) {
    const { validateOIDC } = await import("@/lib/oidc");
    const result = await validateOIDC(req);
    if (result instanceof Response) return result;
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return err("Invalid JSON body", 400);
  }

  const { agent, action, company, status, summary, details } = body;

  if (!agent || !action || !status || !summary) {
    return err("Missing required fields: agent, action, status, summary", 400);
  }

  const validStatuses = ["started", "success", "failed"];
  if (!validStatuses.includes(status)) {
    return err(`Invalid status. Must be one of: ${validStatuses.join(", ")}`, 400);
  }

  const sent = await notifyHive({ agent, action, company, status, summary, details });

  return json({ sent });
}
