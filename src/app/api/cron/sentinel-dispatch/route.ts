import { getDb } from "@/lib/db";
import { isDispatchPaused } from "@/lib/edge-config";
import { verifyCronAuth } from "@/lib/qstash";

const HIVE_URL = process.env.NEXT_PUBLIC_URL || "https://hive-phi.vercel.app";

// POST /api/cron/sentinel-dispatch — heartbeat safety net
// Fires every 4h via QStash schedule.
// Only dispatches work if the chain has gone silent (no cycle-complete in 5h) AND no brain agent is active.
// All dispatch decisions belong to /api/dispatch/work — this is the stall recovery circuit only.
export async function POST(req: Request) {
  const authResult = await verifyCronAuth(req);
  if (!authResult.authorized) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const paused = await isDispatchPaused().catch(() => false);
  if (paused) {
    return Response.json({ ok: true, skipped: "dispatch_paused" });
  }

  const sql = getDb();
  const cronSecret = process.env.CRON_SECRET;

  // Check if chain is silent: no cycle-complete callback in last 5h
  const [lastCallback] = await sql`
    SELECT started_at FROM agent_actions
    WHERE action_type = 'cycle_callback'
    AND started_at > NOW() - INTERVAL '5 hours'
    ORDER BY started_at DESC LIMIT 1
  `.catch(() => [] as any[]);

  if (lastCallback) {
    return Response.json({ ok: true, skipped: "chain_active", last_callback: lastCallback.started_at });
  }

  // Check if a brain agent is currently running
  const [activeAgent] = await sql`
    SELECT id FROM agent_actions
    WHERE agent IN ('ceo', 'engineer')
    AND status = 'running'
    AND started_at > NOW() - INTERVAL '2 hours'
    LIMIT 1
  `.catch(() => [] as any[]);

  if (activeAgent) {
    return Response.json({ ok: true, skipped: "brain_agent_running" });
  }

  // Chain is silent and no active agents — kick the dispatcher
  const workRes = await fetch(`${HIVE_URL}/api/dispatch/work`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cronSecret}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(30000),
  }).catch(() => null);

  if (!workRes || !workRes.ok) {
    console.warn("[sentinel-dispatch] dispatch/work unreachable");
    return Response.json({ ok: true, dispatched: null, reason: "dispatch_work_unreachable" });
  }

  const workData = await workRes.json().catch(() => ({}));
  console.log(`[sentinel-dispatch] heartbeat fired, dispatched: ${workData.dispatched?.type ?? "nothing"}`);
  return Response.json({ ok: true, dispatched: workData.dispatched ?? null, reason: "heartbeat" });
}

export { POST as GET };
