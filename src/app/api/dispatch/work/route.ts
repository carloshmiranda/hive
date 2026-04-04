import { getDb } from "@/lib/db";
import { verifyCronAuth } from "@/lib/qstash";
import { isDispatchPaused } from "@/lib/edge-config";
import { dispatchEvent } from "@/lib/dispatch";
import { qstashPublish } from "@/lib/qstash";

const HIVE_URL = process.env.NEXT_PUBLIC_URL || "https://hive-phi.vercel.app";

// Type weights for priority scoring
const TYPE_WEIGHTS = {
  p0_backlog: 100,
  healer: 90,
  p1_backlog: 70,
  company_cycle: 50,
  growth: 30,
} as const;

type WorkType = keyof typeof TYPE_WEIGHTS;

interface PriorityScore {
  type: WorkType;
  type_weight: number;
  urgency_bonus: number;
  budget_penalty: number;
  total: number;
}

function computePriorityScore(
  type: WorkType,
  claudePct: number,
  urgencyBonus: number
): PriorityScore {
  const type_weight = TYPE_WEIGHTS[type];
  const budget_penalty = claudePct > 90 ? 50 : claudePct > 70 ? 30 : 0;
  const total = type_weight + urgencyBonus - budget_penalty;

  return {
    type,
    type_weight,
    urgency_bonus: urgencyBonus,
    budget_penalty,
    total,
  };
}

// POST /api/dispatch/work — unified work dispatcher
// Single authority for all dispatch decisions in the system.
// Auth: QStash signature or CRON_SECRET
export async function POST(req: Request) {
  // 1. Auth
  const authResult = await verifyCronAuth(req);
  if (!authResult.authorized) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  // 2. Kill switch check
  const paused = await isDispatchPaused().catch(() => false);
  if (paused) {
    return Response.json({ ok: true, skipped: "dispatch_paused" });
  }

  // Parse request body for caller-provided hints
  const body = await req.json().catch(() => ({}));
  const callerUrgencyBonus = typeof body.urgency_bonus === "number"
    ? Math.max(0, Math.min(100, body.urgency_bonus))
    : 0;
  const companySlugHint: string | undefined = body.company_slug;
  // work_type_hint reserved for future use

  const cronSecret = process.env.CRON_SECRET;
  const sql = getDb();

  // 3. Health gate check
  const healthRes = await fetch(`${HIVE_URL}/api/dispatch/health-gate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cronSecret}`,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(8000),
  }).catch(() => null);

  if (!healthRes || !healthRes.ok) {
    return Response.json(
      { ok: false, error: "health_gate_unreachable" },
      { status: 503 }
    );
  }

  const healthRaw = await healthRes.json();
  const health = healthRaw.data || healthRaw;

  if (health.recommendation === "stop") {
    return Response.json({
      ok: true,
      dispatched: null,
      reason: "health_gate_stop",
      budget: health.budget,
    });
  }

  if (health.recommendation === "wait") {
    // Schedule self-retry after budget reset window (30min)
    await qstashPublish("/api/dispatch/work", {
      source: "budget_reset_retry",
    }, {
      deduplicationId: `dispatch-work-budget-retry-${new Date().toISOString().slice(0, 13)}`,
      delay: 1800,
    }).catch(() => {});
    return Response.json({
      ok: true,
      dispatched: null,
      reason: "health_gate_wait",
      budget: health.budget,
    });
  }

  // health.recommendation === "dispatch" — continue
  const claudePct: number = health.budget?.claude_pct ?? 0;

  // 4. Priority scoring and work selection

  // --- 4a. P0 backlog items ---
  const p0Items = await sql`
    SELECT id, slug, title, description, acceptance_criteria, company_slug
    FROM hive_backlog
    WHERE priority = 'P0'
    AND status IN ('ready', 'approved')
    ORDER BY created_at ASC
    LIMIT 5
  `.catch(() => [] as any[]);

  if (p0Items.length > 0) {
    const item = p0Items[0];
    const score = computePriorityScore("p0_backlog", claudePct, callerUrgencyBonus);

    await dispatchEvent("feature_request", {
      source: "unified_dispatcher",
      backlog_item_id: item.id,
      backlog_item_slug: item.slug,
      title: item.title,
      description: item.description,
      acceptance_criteria: item.acceptance_criteria,
      company: item.company_slug || null,
      priority: "P0",
      priority_score: score.total,
    });

    console.log(`[dispatch/work] dispatched P0 backlog: ${item.slug} (score ${score.total})`);
    return Response.json({
      ok: true,
      dispatched: {
        type: "p0_backlog",
        target: item.slug,
        priority_score: score.total,
      },
    });
  }

  // --- 4b. Healer — companies with recent failures ---
  const healerCandidates = await sql`
    SELECT c.id, c.slug,
      COUNT(*) FILTER (WHERE aa.status = 'failed') as recent_failures
    FROM companies c
    JOIN agent_actions aa ON aa.company_id = c.id
    WHERE c.status IN ('mvp', 'active')
    AND aa.started_at > NOW() - INTERVAL '6 hours'
    AND aa.agent IN ('ceo', 'engineer', 'growth')
    GROUP BY c.id, c.slug
    HAVING COUNT(*) FILTER (WHERE aa.status = 'failed') >= 3
    ORDER BY recent_failures DESC
    LIMIT 1
  `.catch(() => [] as any[]);

  if (healerCandidates.length > 0) {
    const candidate = healerCandidates[0];
    const score = computePriorityScore("healer", claudePct, callerUrgencyBonus + 10);

    await dispatchEvent("healer_trigger", {
      source: "unified_dispatcher",
      company: candidate.slug,
      company_id: candidate.id,
      recent_failures: Number(candidate.recent_failures),
      priority_score: score.total,
    });

    console.log(`[dispatch/work] dispatched healer for ${candidate.slug} (score ${score.total})`);
    return Response.json({
      ok: true,
      dispatched: {
        type: "healer",
        target: candidate.slug,
        priority_score: score.total,
      },
    });
  }

  // --- 4c. P1 backlog items ---
  const p1Items = await sql`
    SELECT id, slug, title, description, acceptance_criteria, company_slug
    FROM hive_backlog
    WHERE priority = 'P1'
    AND status IN ('ready', 'approved')
    ORDER BY created_at ASC
    LIMIT 5
  `.catch(() => [] as any[]);

  if (p1Items.length > 0) {
    const item = p1Items[0];
    const score = computePriorityScore("p1_backlog", claudePct, callerUrgencyBonus);

    await dispatchEvent("feature_request", {
      source: "unified_dispatcher",
      backlog_item_id: item.id,
      backlog_item_slug: item.slug,
      title: item.title,
      description: item.description,
      acceptance_criteria: item.acceptance_criteria,
      company: item.company_slug || null,
      priority: "P1",
      priority_score: score.total,
    });

    console.log(`[dispatch/work] dispatched P1 backlog: ${item.slug} (score ${score.total})`);
    return Response.json({
      ok: true,
      dispatched: {
        type: "p1_backlog",
        target: item.slug,
        priority_score: score.total,
      },
    });
  }

  // --- 4d. Company cycle — highest-scoring company without active brain agent ---
  const companyCandidates = await sql`
    SELECT c.id, c.slug, c.status, c.github_repo,
      COALESCE(
        (SELECT MAX(started_at) FROM agent_actions
         WHERE company_id = c.id AND agent = 'ceo' AND action_type = 'cycle_plan'),
        c.created_at
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
  `.catch(() => [] as any[]);

  if (companyCandidates.length > 0) {
    // Filter out companies with active brain agents
    const runningCycles = await sql`
      SELECT DISTINCT company_id FROM agent_actions
      WHERE agent IN ('ceo', 'engineer')
      AND status = 'running'
      AND started_at > NOW() - INTERVAL '2 hours'
    `.catch(() => [] as any[]);
    const runningIds = new Set(runningCycles.map((r: any) => r.company_id));

    // Validate companySlugHint against actual company slugs
    const validSlugs = new Set(companyCandidates.map((c: any) => c.slug));
    const validatedSlugHint = companySlugHint && validSlugs.has(companySlugHint)
      ? companySlugHint
      : undefined;

    // Score each company using the same formula as cycle-complete
    type ScoredCompany = {
      slug: string;
      id: string;
      pending_tasks: number;
      priority_score: number;
      github_repo: string;
    };
    const scored: ScoredCompany[] = [];

    for (const c of companyCandidates) {
      if (runningIds.has(c.id)) continue;
      // Skip if company hint given and doesn't match
      if (validatedSlugHint && c.slug !== validatedSlugHint) continue;

      const daysSinceLastCycle = Math.max(
        0,
        (Date.now() - new Date(c.last_cycle).getTime()) / 86400000
      );
      if (daysSinceLastCycle < 0.25) continue;

      const pendingTasks = Number(c.pending_tasks || 0);
      const lastScore = Number(c.last_score || 5);
      const cycleCount = Number(c.cycle_count || 0);
      const isNew = c.status === "mvp" && cycleCount < 3;

      let companyScore = 0;
      companyScore += pendingTasks * 2;
      companyScore += Math.min(14, daysSinceLastCycle) * 3;
      if (isNew) companyScore += 18;
      if (lastScore < 5) companyScore += 5;
      companyScore -= cycleCount * 0.5;

      scored.push({
        slug: c.slug,
        id: c.id,
        pending_tasks: pendingTasks,
        priority_score: Math.round(companyScore * 10) / 10,
        github_repo: c.github_repo,
      });
    }
    scored.sort((a, b) => b.priority_score - a.priority_score);

    if (scored.length > 0) {
      const next = scored[0];
      const dispatchScore = computePriorityScore("company_cycle", claudePct, callerUrgencyBonus);

      await dispatchEvent("cycle_start", {
        source: "unified_dispatcher",
        company: next.slug,
        company_id: next.id,
        priority_score: next.priority_score,
      });

      console.log(`[dispatch/work] dispatched cycle_start for ${next.slug} (score ${next.priority_score})`);
      return Response.json({
        ok: true,
        dispatched: {
          type: "company_cycle",
          target: next.slug,
          priority_score: dispatchScore.total,
        },
      });
    }
  }

  // --- 4e. Growth / Ops fallback ---
  const growthCandidates = await sql`
    SELECT c.slug FROM companies c
    WHERE c.status IN ('mvp', 'active')
    AND NOT EXISTS (
      SELECT 1 FROM agent_actions aa
      WHERE aa.company_id = c.id
      AND aa.agent = 'growth'
      AND aa.status = 'success'
      AND aa.started_at > NOW() - INTERVAL '12 hours'
    )
    ORDER BY c.created_at ASC
    LIMIT 1
  `.catch(() => [] as any[]);

  if (growthCandidates.length > 0) {
    const growthTarget = growthCandidates[0];
    const score = computePriorityScore("growth", claudePct, callerUrgencyBonus);

    await qstashPublish("/api/agents/dispatch", {
      agent: "growth",
      company_slug: growthTarget.slug,
      source: "unified_dispatcher",
    });

    console.log(`[dispatch/work] dispatched growth for ${growthTarget.slug} (score ${score.total})`);
    return Response.json({
      ok: true,
      dispatched: {
        type: "growth",
        target: growthTarget.slug,
        priority_score: score.total,
      },
    });
  }

  // Nothing to dispatch
  console.log("[dispatch/work] no work available");
  return Response.json({
    ok: true,
    dispatched: null,
    reason: "no_work_available",
  });
}
