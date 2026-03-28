import { getDb, json } from "@/lib/db";
import { getGitHubToken } from "@/lib/github-app";
import { invalidateCompanyCache } from "@/lib/cache";
import { qstashPublish } from "@/lib/qstash";

const REPO = "carloshmiranda/hive";
const HIVE_URL = process.env.NEXT_PUBLIC_URL || "https://hive-phi.vercel.app";

// Dispatch free-tier worker agents (Growth, Ops, Outreach) that don't use Claude
// Called when Claude budget is exhausted so non-Claude work continues
async function dispatchFreeWorkers(cronSecret: string, sql: ReturnType<typeof getDb>) {
  const workers: { company: string; agent: string }[] = [];

  const companies = await sql`
    SELECT c.slug FROM companies c WHERE c.status IN ('mvp', 'active')
  `.catch((e: any) => { console.warn(`[cycle-complete] fetch companies for free workers failed: ${e?.message || e}`); return []; });

  for (const c of companies) {
    const [lastGrowth] = await sql`
      SELECT id FROM agent_actions
      WHERE agent = 'growth' AND status = 'success'
      AND company_id = (SELECT id FROM companies WHERE slug = ${c.slug})
      AND started_at > NOW() - INTERVAL '12 hours'
      LIMIT 1
    `.catch((e: any) => { console.warn(`[cycle-complete] check recent growth for ${c.slug} failed: ${e?.message || e}`); return []; });
    if (!lastGrowth) workers.push({ company: c.slug, agent: "growth" });

    const [lastOps] = await sql`
      SELECT id FROM agent_actions
      WHERE agent = 'ops' AND status = 'success'
      AND company_id = (SELECT id FROM companies WHERE slug = ${c.slug})
      AND started_at > NOW() - INTERVAL '12 hours'
      LIMIT 1
    `.catch((e: any) => { console.warn(`[cycle-complete] check recent ops for ${c.slug} failed: ${e?.message || e}`); return []; });
    if (!lastOps) workers.push({ company: c.slug, agent: "ops" });
  }

  const results: string[] = [];
  for (const w of workers) {
    await qstashPublish("/api/agents/dispatch", {
      company_slug: w.company,
      agent: w.agent,
      trigger: "cascade_free_worker",
    }, {
      deduplicationId: `free-worker-${w.agent}-${w.company}-${new Date().toISOString().slice(0, 13)}`,
    }).catch((e: any) => { console.warn(`[cycle-complete] qstash dispatch free worker ${w.agent}:${w.company} failed: ${e?.message || e}`); });
    results.push(`${w.agent}:${w.company}`);
  }
  return results;
}

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
      deduplicationId: `cycle-chain-retry-${reason}-${Math.floor(Date.now() / 3600000)}`,
      delay: delaySeconds,
    });
    console.log(`[cycle-complete] Chain retry scheduled in ${Math.round(delaySeconds / 60)}m (reason: ${reason})`);
  } catch (e) {
    console.warn(`[cycle-complete] Chain retry scheduling failed:`, e instanceof Error ? e.message : "unknown");
  }
}

// POST /api/dispatch/cycle-complete — completion callback for continuous dispatch
// Called by agent workflows when they finish. Chains to the next company cycle.
// Flow: agent completes → calls this → health gate → score companies → dispatch next
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

  // Step 1: Health gate check
  const healthRes = await fetch(`${HIVE_URL}/api/dispatch/health-gate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cronSecret}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(8000),
  }).catch(() => null);

  if (!healthRes || !healthRes.ok) {
    // Health gate unreachable — retry in 5 min instead of dying
    await scheduleChainRetry("health_gate_unreachable", 5 * 60);
    return json({ chained: false, reason: "health_gate_unreachable", chain_retry: true });
  }

  const healthRaw = await healthRes.json();
  const health = healthRaw.data || healthRaw;

  if (health.recommendation === "stop") {
    // Claude is blocked — dispatch free workers and retry when budget resets
    const freeWorkers = await dispatchFreeWorkers(cronSecret!, sql).catch((e: any) => { console.warn(`[cycle-complete] dispatch free workers on health stop failed: ${e?.message || e}`); return []; });
    await scheduleChainRetry("health_gate_stop", 30 * 60); // Retry in 30 min
    return json({ chained: false, reason: "health_gate_stop", blockers: health.blockers, free_workers_dispatched: freeWorkers, chain_retry: true });
  }

  if (health.recommendation === "wait") {
    // Claude is throttled — dispatch free workers and retry in 15 min
    const freeWorkers = await dispatchFreeWorkers(cronSecret!, sql).catch((e: any) => { console.warn(`[cycle-complete] dispatch free workers on health wait failed: ${e?.message || e}`); return []; });
    await scheduleChainRetry("health_gate_wait", 15 * 60);
    return json({ chained: false, reason: "health_gate_wait", blockers: health.blockers, free_workers_dispatched: freeWorkers, chain_retry: true });
  }

  // Step 2: If Hive needs fixes first, dispatch backlog via QStash (guaranteed delivery)
  if (health.hive_first) {
    await qstashPublish("/api/backlog/dispatch", {
      trigger: "cycle_complete_hive_first",
    }, {
      deduplicationId: `hive-first-${Date.now().toString(36)}`,
    }).catch(() => null);

    return json({
      chained: true,
      type: "hive_backlog",
      reason: "hive_first_priority",
    });
  }

  const ghPat = await getGitHubToken().catch(() => null);
  if (!ghPat) {
    await scheduleChainRetry("no_github_token", 10 * 60);
    return json({ chained: false, reason: "no_github_token", chain_retry: true });
  }

  // Dedup: check for recently dispatched cycle_start
  const [recentCycleDispatch] = await sql`
    SELECT id FROM agent_actions
    WHERE agent = 'dispatch' AND action_type = 'chain_cycle'
    AND started_at > NOW() - INTERVAL '10 minutes'
    LIMIT 1
  `.catch((e: any) => { console.warn(`[cycle-complete] check recent cycle dispatch failed: ${e?.message || e}`); return []; });
  if (recentCycleDispatch) {
    // Don't retry — something was just dispatched and will chain when done
    return json({ chained: false, reason: "recent_cycle_dispatched" });
  }

  // Step 3: Score companies and pick the next one
  const candidates = await sql`
    SELECT c.id, c.slug, c.status, c.github_repo,
      COALESCE(
        (SELECT MAX(started_at) FROM agent_actions
         WHERE company_id = c.id AND agent = 'ceo' AND action_type = 'cycle_plan'
        ), c.created_at
      ) as last_cycle,
      (SELECT COUNT(*)::int FROM company_tasks
       WHERE company_id = c.id AND status = 'pending') as pending_tasks,
      (SELECT (ceo_review->'review'->>'score')::int FROM cycles
       WHERE company_id = c.id AND ceo_review IS NOT NULL
       ORDER BY created_at DESC LIMIT 1) as last_score,
      (SELECT COUNT(*)::int FROM cycles WHERE company_id = c.id) as cycle_count
    FROM companies c
    WHERE c.status IN ('mvp', 'active')
    ORDER BY c.created_at ASC
  `.catch((e: any) => { console.warn(`[cycle-complete] fetch candidate companies failed: ${e?.message || e}`); return []; });

  if (candidates.length === 0) {
    // No active companies — fall back to backlog
    await qstashPublish("/api/backlog/dispatch", {
      trigger: "cycle_complete_no_companies",
    }, {
      deduplicationId: `no-companies-backlog-${Date.now().toString(36)}`,
    }).catch(() => null);
    return json({ chained: true, type: "hive_backlog", reason: "no_eligible_companies" });
  }

  // Skip the company that just completed (avoid re-dispatching immediately)
  const eligible = candidates.filter((c) => c.slug !== company);

  // Check which have a running cycle already
  const runningCycles = await sql`
    SELECT DISTINCT company_id FROM agent_actions
    WHERE agent IN ('ceo', 'engineer')
    AND status = 'running'
    AND started_at > NOW() - INTERVAL '2 hours'
  `.catch((e: any) => { console.warn(`[cycle-complete] check running cycles failed: ${e?.message || e}`); return []; });
  const runningIds = new Set(runningCycles.map((r) => r.company_id));

  // Score each company
  type ScoredCompany = { slug: string; id: string; pending_tasks: number; priority_score: number; github_repo: string };
  const scored: ScoredCompany[] = [];
  for (const c of eligible) {
    if (runningIds.has(c.id)) continue;
    const daysSinceLastCycle = Math.max(
      0,
      (Date.now() - new Date(c.last_cycle).getTime()) / 86400000
    );
    if (daysSinceLastCycle < 0.25) continue;

    const pendingTasks = Number(c.pending_tasks || 0);
    const lastScore = Number(c.last_score || 5);
    const cycleCount = Number(c.cycle_count || 0);
    const isNew = c.status === "mvp" && cycleCount < 3;

    let score = 0;
    score += pendingTasks * 2;
    score += Math.min(14, daysSinceLastCycle) * 3;
    if (isNew) score += 18;
    if (lastScore < 5) score += 5;
    score -= cycleCount * 0.5;

    scored.push({
      slug: c.slug,
      id: c.id,
      pending_tasks: pendingTasks,
      priority_score: Math.round(score * 10) / 10,
      github_repo: c.github_repo,
    });
  }
  scored.sort((a, b) => b.priority_score - a.priority_score);

  if (scored.length === 0) {
    // No companies need cycles — dispatch backlog via QStash
    await qstashPublish("/api/backlog/dispatch", {
      trigger: "cycle_complete_no_scored",
    }, {
      deduplicationId: `no-scored-backlog-${Date.now().toString(36)}`,
    }).catch(() => null);
    return json({ chained: true, type: "hive_backlog", reason: "no_companies_need_cycles" });
  }

  // Determine how many companies to dispatch based on budget
  const claudePct = health.budget?.claude_pct ?? 0;
  const maxSlots = claudePct > 90 ? 0 : claudePct > 70 ? 1 : 2;
  const runningBrains = health.system?.running_brains ?? 0;
  const availableSlots = Math.max(0, Math.min(maxSlots, 3 - runningBrains));
  const toDispatch = scored.slice(0, Math.max(1, availableSlots));

  const dispatched: { slug: string; priority_score: number; pending_tasks: number }[] = [];

  for (const next of toDispatch) {
    const res = await fetch(`https://api.github.com/repos/${REPO}/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `token ${ghPat}`,
        Accept: "application/vnd.github.v3+json",
      },
      body: JSON.stringify({
        event_type: "cycle_start",
        client_payload: {
          source: "chain_dispatch",
          company: next.slug,
          company_id: next.id,
          priority_score: next.priority_score,
          chain_next: true,
        },
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (res.ok || res.status === 204) {
      await sql`
        INSERT INTO agent_actions (agent, action_type, status, description, company_id, started_at, finished_at)
        VALUES ('dispatch', 'chain_cycle', 'success',
          ${`Chain dispatch: ${company || "unknown"} → ${next.slug} (score ${next.priority_score})`},
          ${next.id}, NOW(), NOW())
      `.catch((e: any) => { console.warn(`[cycle-complete] log chain dispatch ${company} -> ${next.slug} failed: ${e?.message || e}`); });

      dispatched.push({
        slug: next.slug,
        priority_score: next.priority_score,
        pending_tasks: next.pending_tasks,
      });
    }
  }

  if (dispatched.length > 0) {
    const summary = dispatched.map(d => `${d.slug} (${d.priority_score})`).join(", ");
    await qstashPublish("/api/notify", {
      agent: "dispatch",
      action: "chain_cycle",
      company: dispatched[0]!.slug,
      status: "dispatched",
      summary: `Chained: ${company} done → dispatching ${dispatched.length} companies: ${summary}`,
    }, { retries: 2 }).catch((e: any) => { console.warn(`[cycle-complete] notify chain dispatch failed: ${e?.message || e}`); });

    // Schedule chain watchdog: if no callback arrives within 30 min, re-kick
    await qstashPublish("/api/dispatch/chain-watchdog", {
      dispatched_slugs: dispatched.map(d => d.slug),
      dispatched_at: new Date().toISOString(),
    }, {
      delay: 30 * 60, // 30 minutes
      deduplicationId: `chain-watchdog-${Date.now().toString(36)}`,
      retries: 2,
    }).catch((e: any) => { console.warn(`[cycle-complete] schedule chain watchdog failed: ${e?.message || e}`); });

    return json({
      chained: true,
      type: "company_cycle",
      completed: { agent, company, status },
      dispatched_count: dispatched.length,
      available_slots: availableSlots,
      next: dispatched,
    });
  }

  // All GitHub dispatches failed — retry in 5 min
  await scheduleChainRetry("github_dispatch_failed", 5 * 60);
  return json({ chained: false, reason: "github_dispatch_failed", chain_retry: true });
}
