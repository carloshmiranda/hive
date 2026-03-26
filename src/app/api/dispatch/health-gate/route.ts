import { getDb, json } from "@/lib/db";

// POST /api/dispatch/health-gate — check system health before dispatching next work
// Returns: { healthy: bool, budget: {...}, blockers: [...], recommendation: "dispatch"|"wait"|"stop" }
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
  const blockers: string[] = [];

  // 1. Budget check — Claude messages in current 5h window
  const [usage] = await sql`
    SELECT COALESCE(SUM(tokens_used), 0)::int as turns,
           COUNT(*)::int as actions
    FROM agent_actions
    WHERE agent IN ('ceo', 'scout', 'engineer', 'evolver', 'healer')
    AND started_at > NOW() - INTERVAL '5 hours'
  `.catch(() => [{ turns: 0, actions: 0 }]);
  const claudeTurns = Number(usage?.turns || 0);
  const claudePct = Math.round((claudeTurns / 225) * 100);

  if (claudePct > 90) blockers.push(`claude_budget_critical: ${claudePct}%`);
  else if (claudePct > 85) blockers.push(`claude_budget_high: ${claudePct}%`);

  // 2. Running agents — check for concurrent work
  const runningAgents = await sql`
    SELECT agent, company_id, action_type, started_at
    FROM agent_actions
    WHERE status = 'running'
    AND started_at > NOW() - INTERVAL '2 hours'
  `.catch(() => []);

  const runningBrains = runningAgents.filter(
    (a) => ["ceo", "scout", "engineer", "evolver", "healer"].includes(a.agent)
  );
  if (runningBrains.length >= 3) {
    blockers.push(`concurrent_brains: ${runningBrains.length} brain agents running`);
  }

  // 3a. Rate limit detection — consecutive Claude limit failures
  const [rateLimitRow] = await sql`
    SELECT COUNT(*) FILTER (WHERE status = 'failed'
      AND (error ILIKE '%rate limit%' OR error ILIKE '%session limit%'
        OR error ILIKE '%usage cap%' OR error ILIKE '%too many%'
        OR error ILIKE '%quota%' OR error ILIKE '%limit reached%'
        OR error ILIKE '%max_tokens%' OR error ILIKE '%capacity%'))::int as rate_limited
    FROM agent_actions
    WHERE agent IN ('ceo', 'scout', 'engineer', 'evolver', 'healer')
    AND started_at > NOW() - INTERVAL '2 hours'
  `.catch(() => [{ rate_limited: 0 }]);
  const rateLimited = Number((rateLimitRow as Record<string, number>)?.rate_limited || 0);
  if (rateLimited >= 2) blockers.push(`claude_rate_limited: ${rateLimited} failures in 2h (weekly/session cap likely hit)`);

  // 3. System failure rate (last 6h — short window so old retry storms don't block recovery)
  const [failRate] = await sql`
    SELECT COUNT(*) FILTER (WHERE status = 'failed'
        AND NOT (
          -- Exclude 0-turn ghost failures
          (tokens_used = 0 OR tokens_used IS NULL)
          AND (error ILIKE '%unknown (0 turns)%'
               OR error ILIKE '%exhausted after 0 turns%'
               OR error ILIKE '%workflow file issue%'
               OR error ILIKE '%syntax error%'
               OR description ILIKE '%unknown (0 turns)%')
        )
        -- Exclude sentinel internal checks
        AND action_type NOT IN ('schema_drift_check', 'auto_resolve_escalation')
      )::float /
      NULLIF(COUNT(*) FILTER (WHERE NOT (
          -- Exclude 0-turn ghost failures
          (tokens_used = 0 OR tokens_used IS NULL)
          AND (error ILIKE '%unknown (0 turns)%'
               OR error ILIKE '%exhausted after 0 turns%'
               OR error ILIKE '%workflow file issue%'
               OR error ILIKE '%syntax error%'
               OR description ILIKE '%unknown (0 turns)%')
        )
        -- Exclude sentinel internal checks
        AND action_type NOT IN ('schema_drift_check', 'auto_resolve_escalation')
      )), 0)::float as rate,
      COUNT(*) FILTER (WHERE status = 'failed'
        AND NOT (
          -- Exclude 0-turn ghost failures
          (tokens_used = 0 OR tokens_used IS NULL)
          AND (error ILIKE '%unknown (0 turns)%'
               OR error ILIKE '%exhausted after 0 turns%'
               OR error ILIKE '%workflow file issue%'
               OR error ILIKE '%syntax error%'
               OR description ILIKE '%unknown (0 turns)%')
        )
        -- Exclude sentinel internal checks
        AND action_type NOT IN ('schema_drift_check', 'auto_resolve_escalation')
      )::int as failures,
      COUNT(*) FILTER (WHERE NOT (
          -- Exclude 0-turn ghost failures
          (tokens_used = 0 OR tokens_used IS NULL)
          AND (error ILIKE '%unknown (0 turns)%'
               OR error ILIKE '%exhausted after 0 turns%'
               OR error ILIKE '%workflow file issue%'
               OR error ILIKE '%syntax error%'
               OR description ILIKE '%unknown (0 turns)%')
        )
        -- Exclude sentinel internal checks
        AND action_type NOT IN ('schema_drift_check', 'auto_resolve_escalation')
      ))::int as total
    FROM agent_actions
    WHERE agent NOT IN ('sentinel', 'healer')
    AND finished_at > NOW() - INTERVAL '6 hours'
  `.catch(() => [{ rate: 0, failures: 0, total: 0 }]);
  const sysFailRate = Number(failRate?.rate || 0);
  if (sysFailRate > 0.5) blockers.push(`high_failure_rate: ${Math.round(sysFailRate * 100)}%`);

  // 4. Pending Hive fixes — check if self-improvement should take priority
  const [hiveBacklog] = await sql`
    SELECT COUNT(*) FILTER (WHERE priority IN ('P0', 'P1'))::int as critical,
           COUNT(*)::int as total
    FROM hive_backlog
    WHERE status IN ('ready', 'approved')
  `.catch(() => [{ critical: 0, total: 0 }]);
  const criticalBacklog = Number(hiveBacklog?.critical || 0);

  // 5. Approved evolver proposals waiting
  const [proposals] = await sql`
    SELECT COUNT(*)::int as count
    FROM evolver_proposals
    WHERE status = 'approved'
    AND created_at > NOW() - INTERVAL '14 days'
  `.catch(() => [{ count: 0 }]);

  // Recommendation logic
  let recommendation: "dispatch" | "wait" | "stop" = "dispatch";
  if (blockers.some((b) => b.includes("critical") || b.includes("high_failure_rate"))) {
    recommendation = "stop";
  } else if (blockers.length > 0) {
    recommendation = "wait";
  }

  // If critical Hive backlog items exist and no Hive engineer is running, recommend hive-first
  const hiveEngineerRunning = runningAgents.some(
    (a) => a.agent === "engineer" && !a.company_id
  );
  const hiveFirst = criticalBacklog > 0 && !hiveEngineerRunning;

  return json({
    healthy: blockers.length === 0,
    recommendation,
    hive_first: hiveFirst,
    budget: {
      claude_turns: claudeTurns,
      claude_pct: claudePct,
      claude_max: 225,
    },
    system: {
      failure_rate: Math.round(sysFailRate * 100),
      failures_24h: Number(failRate?.failures || 0),
      running_brains: runningBrains.length,
      running_agents: runningAgents.length,
    },
    backlog: {
      critical: criticalBacklog,
      total: Number(hiveBacklog?.total || 0),
      approved_proposals: Number(proposals?.count || 0),
    },
    blockers,
  });
}
