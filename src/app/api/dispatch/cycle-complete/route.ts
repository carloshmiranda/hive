import { getDb, json } from "@/lib/db";
import { getSettingValue } from "@/lib/settings";
import { invalidateCompanyCache } from "@/lib/cache";

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
    // Growth: dispatch if no success in last 12h
    const [lastGrowth] = await sql`
      SELECT id FROM agent_actions
      WHERE agent = 'growth' AND status = 'success'
      AND company_id = (SELECT id FROM companies WHERE slug = ${c.slug})
      AND started_at > NOW() - INTERVAL '12 hours'
      LIMIT 1
    `.catch((e: any) => { console.warn(`[cycle-complete] check recent growth for ${c.slug} failed: ${e?.message || e}`); return []; });
    if (!lastGrowth) workers.push({ company: c.slug, agent: "growth" });

    // Ops: dispatch if no success in last 12h
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
    const res = await fetch(`${HIVE_URL}/api/agents/dispatch`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cronSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        company_slug: w.company,
        agent: w.agent,
        trigger: "cascade_free_worker",
      }),
      signal: AbortSignal.timeout(30000),
    }).catch((e: any) => { console.warn(`[cycle-complete] dispatch free worker ${w.agent}:${w.company} failed: ${e?.message || e}`); return null; });
    if (res?.ok) results.push(`${w.agent}:${w.company}`);
  }
  return results;
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

  // Log the completion
  if (agent && company) {
    const [companyRecord] = await sql`
      SELECT id FROM companies WHERE slug = ${company} LIMIT 1
    `.catch((e: any) => { console.warn(`[cycle-complete] lookup company ${company} failed: ${e?.message || e}`); return []; });

    if (companyRecord) {
      await sql`
        INSERT INTO agent_actions (agent, action_type, status, description, started_at, finished_at, company_id)
        VALUES (${agent}, ${action_type || "cycle_callback"}, 'success',
          ${`Chain callback: ${agent} completed ${status || "unknown"} for ${company}`},
          NOW(), NOW(), ${companyRecord.id})
      `.catch((e: any) => { console.warn(`[cycle-complete] log chain callback for ${company} failed: ${e?.message || e}`); });

      // Invalidate cache for the completed company since cycle state changed
      await invalidateCompanyCache(companyRecord.id);
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
    return json({ chained: false, reason: "health_gate_unreachable" });
  }

  const healthRaw = await healthRes.json();
  const health = healthRaw.data || healthRaw;

  if (health.recommendation === "stop") {
    // Claude is blocked but free workers can still run
    const freeWorkers = await dispatchFreeWorkers(cronSecret!, sql).catch((e: any) => { console.warn(`[cycle-complete] dispatch free workers on health stop failed: ${e?.message || e}`); return []; });
    return json({ chained: false, reason: "health_gate_stop", blockers: health.blockers, free_workers_dispatched: freeWorkers });
  }

  // Step 2: If Hive needs fixes first, dispatch backlog instead of company cycle
  if (health.hive_first) {
    const backlogRes = await fetch(`${HIVE_URL}/api/backlog/dispatch`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cronSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10000),
    }).catch(() => null);

    if (backlogRes && backlogRes.ok) {
      const backlogData = await backlogRes.json();
      if (backlogData.data?.dispatched || backlogData.dispatched) {
        return json({
          chained: true,
          type: "hive_backlog",
          reason: "hive_first_priority",
          item: backlogData.data?.item || backlogData.item,
        });
      }
    }
  }

  // Step 3: Score companies and pick the next one
  if (health.recommendation === "wait") {
    // Claude is throttled but free workers can still run
    const freeWorkers = await dispatchFreeWorkers(cronSecret!, sql).catch((e: any) => { console.warn(`[cycle-complete] dispatch free workers on health wait failed: ${e?.message || e}`); return []; });
    return json({ chained: false, reason: "health_gate_wait", blockers: health.blockers, free_workers_dispatched: freeWorkers });
  }

  const ghPat = await getSettingValue("github_token").catch(() => null);
  if (!ghPat) {
    return json({ chained: false, reason: "no_github_token" });
  }

  // Dedup: check for recently dispatched cycle_start (covers the race window
  // between dispatch and the CEO registering as 'running' in agent_actions)
  const [recentCycleDispatch] = await sql`
    SELECT id FROM agent_actions
    WHERE agent = 'dispatch' AND action_type = 'chain_cycle'
    AND started_at > NOW() - INTERVAL '10 minutes'
    LIMIT 1
  `.catch((e: any) => { console.warn(`[cycle-complete] check recent cycle dispatch failed: ${e?.message || e}`); return []; });
  if (recentCycleDispatch) {
    return json({ chained: false, reason: "recent_cycle_dispatched" });
  }

  // Find companies needing cycles (same logic as Sentinel Check 13c)
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
    return json({ chained: false, reason: "no_eligible_companies" });
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

  // Score each company (same formula as Sentinel)
  type ScoredCompany = { slug: string; id: string; pending_tasks: number; priority_score: number; github_repo: string };
  const scored: ScoredCompany[] = [];
  for (const c of eligible) {
    if (runningIds.has(c.id)) continue;
    const daysSinceLastCycle = Math.max(
      0,
      (Date.now() - new Date(c.last_cycle).getTime()) / 86400000
    );
    // Skip if cycle was less than 6h ago (minimum spacing)
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
    // No companies need cycles — try backlog instead
    const backlogRes = await fetch(`${HIVE_URL}/api/backlog/dispatch`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cronSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10000),
    }).catch(() => null);

    if (backlogRes && backlogRes.ok) {
      const backlogData = await backlogRes.json();
      if (backlogData.data?.dispatched || backlogData.dispatched) {
        return json({
          chained: true,
          type: "hive_backlog",
          reason: "no_companies_need_cycles",
          item: backlogData.data?.item || backlogData.item,
        });
      }
    }

    return json({ chained: false, reason: "no_companies_need_cycles" });
  }

  const next = scored[0]!;

  // Dispatch cycle_start for the top company
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
    // Log dispatch for dedup (so concurrent calls don't double-dispatch)
    await sql`
      INSERT INTO agent_actions (agent, action_type, status, description, company_id, started_at, finished_at)
      VALUES ('dispatch', 'chain_cycle', 'success',
        ${`Chain dispatch: ${company || "unknown"} → ${next.slug} (score ${next.priority_score})`},
        ${next.id}, NOW(), NOW())
    `.catch((e: any) => { console.warn(`[cycle-complete] log chain dispatch ${company} -> ${next.slug} failed: ${e?.message || e}`); });

    // Notify via Telegram
    await fetch(`${HIVE_URL}/api/notify`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cronSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agent: "dispatch",
        action: "chain_cycle",
        company: next.slug,
        status: "dispatched",
        summary: `Chained: ${company} done → dispatching ${next.slug} (score: ${next.priority_score})`,
      }),
      signal: AbortSignal.timeout(5000),
    }).catch((e: any) => { console.warn(`[cycle-complete] notify chain dispatch ${next.slug} failed: ${e?.message || e}`); });

    return json({
      chained: true,
      type: "company_cycle",
      completed: { agent, company, status },
      next: {
        company: next.slug,
        priority_score: next.priority_score,
        pending_tasks: next.pending_tasks,
      },
    });
  }

  return json({ chained: false, reason: "github_dispatch_failed", status: res.status });
}
