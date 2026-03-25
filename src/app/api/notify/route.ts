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

  const { agent, action, company, status, summary, details,
    pr_number, pr_url, pr_title, duration_s, task_title, error, run_url } = body;

  if (!agent || !action || !status || !summary) {
    return err("Missing required fields: agent, action, status, summary", 400);
  }

  // Accept any status — agents use various statuses (dispatched, needs_carlos, etc.)
  // Normalize to the closest valid NotificationEvent status for formatting
  const statusMap: Record<string, "started" | "success" | "failed"> = {
    started: "started", success: "success", failed: "failed",
    dispatched: "success", needs_carlos: "failed", error: "failed",
  };
  const normalizedStatus = statusMap[status] || "success";

  const sent = await notifyHive({
    agent, action, company, status: normalizedStatus, summary, details,
    pr_number, pr_url, pr_title, duration_s, task_title, error, run_url,
  });

  return json({ sent });
}
