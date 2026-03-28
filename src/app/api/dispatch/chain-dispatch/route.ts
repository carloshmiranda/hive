import { json, err } from "@/lib/db";
import { dispatchEvent } from "@/lib/dispatch";
import { verifyCronAuth } from "@/lib/qstash";

// POST /api/dispatch/chain-dispatch — QStash-backed GitHub Actions dispatch
// Receives messages from QStash with guaranteed delivery + retries,
// then forwards them as repository_dispatch events to GitHub Actions.
// This bridges QStash reliability with GitHub Actions execution.
// Auth: QStash signature or CRON_SECRET
export async function POST(req: Request) {
  const auth = await verifyCronAuth(req);
  if (!auth.authorized) return err("Unauthorized", 401);

  const body = await req.json().catch(() => ({}));
  const { event_type, ...payload } = body;

  if (!event_type) {
    return err("event_type required", 400);
  }

  try {
    await dispatchEvent(event_type, payload);
    return json({ ok: true, event_type, dispatched: true });
  } catch (e) {
    console.error(`[chain-dispatch] Failed to dispatch ${event_type}:`, e instanceof Error ? e.message : e);
    return err(`Dispatch failed: ${e instanceof Error ? e.message : "unknown"}`, 500);
  }
}
