/**
 * Company Health Score — composite metric combining revenue, traffic,
 * error rate, cycle scores, and task completion into a single 0-100 grade.
 */

type Grade = "A" | "B" | "C" | "D" | "F";

interface HealthBreakdown {
  revenue_trend: number;
  traffic_trend: number;
  error_rate: number;
  cycle_score: number;
  task_completion: number;
}

interface HealthScore {
  score: number;
  grade: Grade;
  breakdown: HealthBreakdown;
}

function scoreToGrade(score: number): Grade {
  if (score >= 80) return "A";
  if (score >= 60) return "B";
  if (score >= 40) return "C";
  if (score >= 20) return "D";
  return "F";
}

/**
 * Score a trend by comparing the current 7-day window vs the previous 7-day window.
 * Growth = 100, flat (within 5%) = 50, decline = 0.
 * Linear interpolation between thresholds for nuance.
 */
function scoreTrend(current: number, previous: number): number {
  if (previous === 0 && current === 0) return 50; // no data = flat
  if (previous === 0 && current > 0) return 100;  // from nothing to something = growth

  const changeRate = (current - previous) / previous;

  if (changeRate > 0.05) {
    // Growth: scale from 50 at +5% to 100 at +50% or more
    const t = Math.min(changeRate / 0.5, 1);
    return Math.round(50 + t * 50);
  } else if (changeRate < -0.05) {
    // Decline: scale from 50 at -5% to 0 at -50% or worse
    const t = Math.min(Math.abs(changeRate) / 0.5, 1);
    return Math.round(50 - t * 50);
  }
  return 50; // flat (within +/-5%)
}

export async function calculateHealthScore(
  companyId: string,
  sql: any
): Promise<HealthScore> {
  // --- Revenue trend (30%) ---
  const revenueRows = await sql`
    SELECT
      COALESCE(SUM(CASE WHEN date >= CURRENT_DATE - 7 THEN revenue ELSE 0 END), 0) as current_rev,
      COALESCE(SUM(CASE WHEN date >= CURRENT_DATE - 14 AND date < CURRENT_DATE - 7 THEN revenue ELSE 0 END), 0) as prev_rev
    FROM metrics
    WHERE company_id = ${companyId} AND date >= CURRENT_DATE - 14
  `;
  const revenueTrend = scoreTrend(
    Number(revenueRows[0]?.current_rev ?? 0),
    Number(revenueRows[0]?.prev_rev ?? 0)
  );

  // --- Traffic trend (20%) ---
  const trafficRows = await sql`
    SELECT
      COALESCE(SUM(CASE WHEN date >= CURRENT_DATE - 7 THEN page_views ELSE 0 END), 0) as current_views,
      COALESCE(SUM(CASE WHEN date >= CURRENT_DATE - 14 AND date < CURRENT_DATE - 7 THEN page_views ELSE 0 END), 0) as prev_views
    FROM metrics
    WHERE company_id = ${companyId} AND date >= CURRENT_DATE - 14
  `;
  const trafficTrend = scoreTrend(
    Number(trafficRows[0]?.current_views ?? 0),
    Number(trafficRows[0]?.prev_views ?? 0)
  );

  // --- Error rate (20%) ---
  const errorRows = await sql`
    SELECT
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
      ) as failed,
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
      ) as total
    FROM agent_actions
    WHERE company_id = ${companyId}
      AND started_at >= CURRENT_DATE - 7
  `;
  const totalActions = Number(errorRows[0]?.total ?? 0);
  const failedActions = Number(errorRows[0]?.failed ?? 0);
  let errorScore: number;
  if (totalActions === 0) {
    errorScore = 100; // no actions = no errors
  } else {
    const errorRate = failedActions / totalActions;
    // 0% errors = 100, 20%+ errors = 0, linear in between
    errorScore = Math.round(Math.max(0, 100 - (errorRate / 0.2) * 100));
  }

  // --- Cycle scores (20%) ---
  const cycleRows = await sql`
    SELECT COALESCE(ceo_review->'review'->>'score', ceo_review->>'score') as score
    FROM cycles
    WHERE company_id = ${companyId}
      AND ceo_review IS NOT NULL
      AND COALESCE(ceo_review->'review'->>'score', ceo_review->>'score') IS NOT NULL
    ORDER BY cycle_number DESC
    LIMIT 3
  `;
  let cycleScore: number;
  if (cycleRows.length === 0) {
    cycleScore = 50; // no cycles = neutral
  } else {
    const avg =
      cycleRows.reduce((sum: number, r: any) => sum + Number(r.score), 0) /
      cycleRows.length;
    // CEO scores are 1-10. Map: 1 → 10, 10 → 100
    cycleScore = Math.round(10 + ((avg - 1) / 9) * 90);
  }

  // --- Task completion (10%) ---
  const taskRows = await sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'done') as done,
      COUNT(*) as total
    FROM company_tasks
    WHERE company_id = ${companyId}
  `;
  const totalTasks = Number(taskRows[0]?.total ?? 0);
  const doneTasks = Number(taskRows[0]?.done ?? 0);
  const taskCompletion =
    totalTasks === 0 ? 100 : Math.round((doneTasks / totalTasks) * 100);

  // --- Weighted composite ---
  const score = Math.round(
    revenueTrend * 0.3 +
      trafficTrend * 0.2 +
      errorScore * 0.2 +
      cycleScore * 0.2 +
      taskCompletion * 0.1
  );

  return {
    score,
    grade: scoreToGrade(score),
    breakdown: {
      revenue_trend: revenueTrend,
      traffic_trend: trafficTrend,
      error_rate: errorScore,
      cycle_score: cycleScore,
      task_completion: taskCompletion,
    },
  };
}
