import { getDb } from "@/lib/db";
import { invalidateCompanyCache } from "@/lib/cache";
import { qstashPublish } from "@/lib/qstash";
import { setSentryTags, addDispatchBreadcrumb } from "@/lib/sentry-tags";

const HIVE_URL = process.env.NEXT_PUBLIC_URL || "https://hive-phi.vercel.app";

// Schedule a chain retry via QStash when the chain is temporarily blocked.
// This ensures the loop restarts instead of dying on transient blocks.
async function scheduleChainRetry(reason: string, delaySeconds: number) {
  try {
    await qstashPublish("/api/dispatch/cycle-complete", {
      agent: "chain_retry",
      company: "_retry",
      status: "retry",
      action_type: "chain_retry",
      retry_reason: reason,
    }, {
      deduplicationId: `cycle-chain-retry-${reason}-${new Date().toISOString().slice(0, 13)}`,
      delay: delaySeconds,
    });
    console.log(`[cycle-complete] Chain retry scheduled in ${Math.round(delaySeconds / 60)}m (reason: ${reason})`);
  } catch (e) {
    console.warn(`[cycle-complete] Chain retry scheduling failed:`, e instanceof Error ? e.message : "unknown");
  }
}

// POST /api/dispatch/cycle-complete — completion callback for continuous dispatch
// Called by agent workflows when they finish. Chains to the next company cycle.
// Flow: agent completes → calls this → log → CEO gate → delegate to /api/dispatch/work
// Auth: CRON_SECRET or OIDC
export async function POST(req: Request) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (authHeader !== `Bearer ${cronSecret}`) {
    const { validateOIDC } = await import("@/lib/oidc");
    const result = await validateOIDC(req);
    if (result instanceof Response) return result;
  }

  const sql = getDb();
  const body = await req.json().catch(() => ({}));
  const { agent, company, status, action_type } = body;
  const callbackStatus = status === "failed" ? "failed" : "success";

  setSentryTags({ agent: agent || "dispatch", action_type: action_type || "cycle_callback", route: "/api/dispatch/cycle-complete" });
  addDispatchBreadcrumb({
    category: "dispatch",
    message: "Cycle complete callback received",
    data: { agent, company, status: callbackStatus },
  });

  // Log the completion (skip for chain retries)
  if (agent && company && agent !== "chain_retry") {
    const [companyRecord] = await sql`
      SELECT id FROM companies WHERE slug = ${company} LIMIT 1
    `.catch((e: any) => { console.warn(`[cycle-complete] lookup company ${company} failed: ${e?.message || e}`); return []; });

    if (companyRecord) {
      await sql`
        INSERT INTO agent_actions (agent, action_type, status, description, started_at, finished_at, company_id)
        VALUES (${agent}, ${action_type || "cycle_callback"}, ${callbackStatus},
          ${`Chain callback: ${agent} completed ${status || "unknown"} for ${company}`},
          NOW(), NOW(), ${companyRecord.id})
      `.catch((e: any) => { console.warn(`[cycle-complete] log chain callback for ${company} failed: ${e?.message || e}`); });

      await invalidateCompanyCache(companyRecord.id);
    }

    // If the agent failed, notify about the failure but still chain to next work
    if (callbackStatus === "failed") {
      await qstashPublish("/api/notify", {
        agent: agent,
        action: "agent_failed",
        company: company,
        status: "failed",
        summary: `Agent ${agent} failed for ${company}. Chaining to next work item.`,
      }, { retries: 2 }).catch((e: any) => { console.warn(`[cycle-complete] notify failure ${agent}:${company} failed: ${e?.message || e}`); });
    }
  }

  // Minimum cycle duration gate: CEO completing planning does not mean the cycle is done.
  // If CEO just called us and no non-CEO agent has succeeded yet, the cycle has barely started.
  // Schedule a retry in 2h so Engineer/Growth have time to run before we chain to the next company.
  if (agent === "ceo" && company && company !== "_retry") {
    const [companyGateRec] = await sql`
      SELECT id FROM companies WHERE slug = ${company} LIMIT 1
    `.catch((e: any) => { console.warn(`[cycle-complete] gate company lookup failed: ${e?.message || e}`); return []; });

    if (companyGateRec) {
      const [activeCycle] = await sql`
        SELECT id, started_at FROM cycles
        WHERE company_id = ${companyGateRec.id} AND status = 'running'
        ORDER BY started_at DESC LIMIT 1
      `.catch((e: any) => { console.warn(`[cycle-complete] gate cycle lookup failed: ${e?.message || e}`); return []; });

      if (activeCycle) {
        const cycleAgeHours = (Date.now() - new Date(activeCycle.started_at).getTime()) / 3_600_000;
        if (cycleAgeHours < 4) {
          const [nonCeoSuccess] = await sql`
            SELECT id FROM agent_actions
            WHERE company_id = ${companyGateRec.id}
            AND agent NOT IN ('ceo', 'dispatch', 'sentinel', 'ops')
            AND status = 'success'
            AND started_at > ${activeCycle.started_at}
            LIMIT 1
          `.catch((e: any) => { console.warn(`[cycle-complete] gate non-ceo check failed: ${e?.message || e}`); return [null]; });

          if (!nonCeoSuccess) {
            await scheduleChainRetry("minimum_cycle_duration_not_met", 2 * 60 * 60);
            return Response.json({ chained: false, reason: "minimum_cycle_duration_not_met", chain_retry: true, company });
          }
        }
      }
    }
  }

  // Delegate dispatch to /api/dispatch/work — it owns health gate, scoring, and GitHub dispatch
  const workRes = await fetch(`${HIVE_URL}/api/dispatch/work`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cronSecret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      company_slug: body.company,
    }),
    signal: AbortSignal.timeout(30000),
  }).catch(() => null);

  if (!workRes || !workRes.ok) {
    console.warn("[cycle-complete] dispatch/work unreachable");
    return Response.json({ ok: true, dispatched: null, reason: "dispatch_work_unreachable" });
  }

  const workData = await workRes.json().catch(() => ({}));
  return Response.json({ ok: true, dispatched: workData.dispatched ?? null });
}
