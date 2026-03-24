import { getDb, json } from "@/lib/db";
import { getSettingValue } from "@/lib/settings";

const REPO = "carloshmiranda/hive";
const HIVE_URL = process.env.NEXT_PUBLIC_URL || "https://hive-phi.vercel.app";

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
    await sql`
      INSERT INTO agent_actions (agent, action_type, status, description, started_at, finished_at, company_id)
      SELECT ${agent}, ${action_type || "cycle_callback"}, 'success',
        ${`Chain callback: ${agent} completed ${status || "unknown"} for ${company}`},
        NOW(), NOW(),
        (SELECT id FROM companies WHERE slug = ${company} LIMIT 1)
    `.catch(() => {});
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
    return json({ chained: false, reason: "health_gate_stop", blockers: health.blockers });
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
    return json({ chained: false, reason: "health_gate_wait", blockers: health.blockers });
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
  `.catch(() => []);
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
      (SELECT score FROM cycles
       WHERE company_id = c.id
       ORDER BY created_at DESC LIMIT 1) as last_score,
      (SELECT COUNT(*)::int FROM cycles WHERE company_id = c.id) as cycle_count
    FROM companies c
    WHERE c.status IN ('mvp', 'active')
    ORDER BY c.created_at ASC
  `.catch(() => []);

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
  `.catch(() => []);
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

  // Parallel dispatch: dispatch up to max_concurrent companies simultaneously
  const maxDispatch = Math.min(
    health.max_concurrent || 1, // Use max_concurrent from health gate
    scored.length,
    health.max_concurrent - health.system.running_brains // Available slots
  );

  const toDispatch = scored.slice(0, maxDispatch);
  const dispatched: Array<{ company: string; priority_score: number; status: number }> = [];

  // Dispatch all selected companies in parallel
  const dispatchPromises = toDispatch.map(async (company) => {
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
          company: company.slug,
          company_id: company.id,
          priority_score: company.priority_score,
          chain_next: true,
          parallel_mode: true,
        },
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (res.ok || res.status === 204) {
      dispatched.push({
        company: company.slug,
        priority_score: company.priority_score,
        status: res.status,
      });
    }

    return { company, res };
  });

  const results = await Promise.allSettled(dispatchPromises);

  if (dispatched.length > 0) {
    // Log parallel dispatches for dedup
    for (const d of dispatched) {
      const companyId = toDispatch.find(c => c.slug === d.company)?.id;
      await sql`
        INSERT INTO agent_actions (agent, action_type, status, description, company_id, started_at, finished_at)
        VALUES ('dispatch', 'chain_cycle', 'success',
          ${`Parallel dispatch: ${company || "unknown"} done → ${d.company} (score ${d.priority_score})`},
          ${companyId}, NOW(), NOW())
      `.catch(() => {});
    }

    // Notify via Telegram
    const summary = dispatched.length === 1
      ? `Chained: ${company} done → dispatching ${dispatched[0].company} (score: ${dispatched[0].priority_score})`
      : `Parallel dispatch: ${company} done → dispatched ${dispatched.length} companies: ${dispatched.map(d => d.company).join(", ")}`;

    await fetch(`${HIVE_URL}/api/notify`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cronSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agent: "dispatch",
        action: "chain_cycle",
        company: dispatched.length === 1 ? dispatched[0].company : "parallel",
        status: "dispatched",
        summary,
      }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});

    return json({
      chained: true,
      type: "company_cycle",
      mode: dispatched.length > 1 ? "parallel" : "single",
      completed: { agent, company, status },
      dispatched: dispatched.map(d => ({
        company: d.company,
        priority_score: d.priority_score,
      })),
    });
  }

  const failedResults = results.filter(r => r.status === 'rejected');
  return json({
    chained: false,
    reason: "github_dispatch_failed",
    failures: failedResults.length,
    attempted: toDispatch.length
  });
}
