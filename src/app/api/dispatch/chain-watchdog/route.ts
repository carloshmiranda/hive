import { getDb, json, err } from "@/lib/db";
import { qstashPublish } from "@/lib/qstash";
import { verifyCronAuth } from "@/lib/qstash";

// POST /api/dispatch/chain-watchdog — Detect and recover from stalled dispatch chains
// Scheduled by cycle-complete 30 min after dispatching work. If the dispatched
// company hasn't produced a callback (cycle_complete) in that window, re-kicks
// the chain so we don't wait 4h for Sentinel to notice the gap.
// Auth: QStash signature or CRON_SECRET
export async function POST(req: Request) {
  const auth = await verifyCronAuth(req);
  if (!auth.authorized) return err("Unauthorized", 401);

  const body = await req.json().catch(() => ({}));
  const { dispatched_slugs, dispatched_at } = body;

  if (!dispatched_slugs || !Array.isArray(dispatched_slugs) || dispatched_slugs.length === 0) {
    return json({ ok: true, action: "no_slugs", skipped: true });
  }

  const sql = getDb();
  const dispatchTime = dispatched_at ? new Date(dispatched_at) : new Date(Date.now() - 30 * 60 * 1000);

  // Check if any of the dispatched companies produced a callback since dispatch
  const callbacks = await sql`
    SELECT DISTINCT description FROM agent_actions
    WHERE agent = 'dispatch' AND action_type = 'chain_cycle'
    AND started_at > ${dispatchTime.toISOString()}::timestamptz
    LIMIT 5
  `.catch(() => []);

  // Check if any of the dispatched companies have running brain agents
  const running = await sql`
    SELECT DISTINCT c.slug FROM agent_actions aa
    JOIN companies c ON c.id = aa.company_id
    WHERE aa.agent IN ('ceo', 'engineer')
    AND aa.status = 'running'
    AND aa.started_at > NOW() - INTERVAL '2 hours'
    AND c.slug = ANY(${dispatched_slugs})
  `.catch(() => []);

  const runningSlugs = new Set(running.map((r) => r.slug));
  const stallDetected = dispatched_slugs.every((s: string) => !runningSlugs.has(s));

  // If callbacks exist or agents are still running, chain is healthy
  if (callbacks.length > 0 || !stallDetected) {
    return json({
      ok: true,
      action: "chain_healthy",
      callbacks_found: callbacks.length,
      running_agents: running.length,
    });
  }

  // Chain is stalled — re-kick by calling cycle-complete with a synthetic completion
  console.warn(`[chain-watchdog] Stall detected: dispatched ${dispatched_slugs.join(",")} at ${dispatched_at} but no callbacks or running agents found. Re-kicking chain.`);

  await qstashPublish("/api/dispatch/cycle-complete", {
    agent: "chain_watchdog",
    company: dispatched_slugs[0],
    status: "watchdog_recovery",
    action_type: "chain_watchdog_kick",
    retry_reason: "stall_detected",
  }, {
    deduplicationId: `watchdog-kick-${Date.now().toString(36)}`,
    retries: 2,
  }).catch((e: unknown) => {
    console.warn(`[chain-watchdog] Failed to re-kick chain:`, e instanceof Error ? e.message : e);
  });

  // Log the recovery action
  await sql`
    INSERT INTO agent_actions (agent, action_type, status, description, started_at, finished_at)
    VALUES ('dispatch', 'chain_watchdog', 'success',
      ${`Chain stall recovery: re-kicked after ${dispatched_slugs.join(",")} failed to produce callback within 30m`},
      NOW(), NOW())
  `.catch(() => {});

  return json({
    ok: true,
    action: "chain_re_kicked",
    stalled_slugs: dispatched_slugs,
    dispatched_at,
  });
}
