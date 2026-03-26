import { getDb, json } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

export async function GET() {
  const session = await requireAuth();
  if (!session) return json({ status: "error", message: "Unauthorized" }, 401);

  const sql = getDb();
  const now = new Date();
  const last7Days = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const last24Hours = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  try {
    // 1. Chain dispatch success rate (last 7 days)
    const [chainDispatchStats] = await sql`
      SELECT
        COUNT(*) as total_dispatches,
        COUNT(*) FILTER (WHERE status IN ('success', 'completed')) as successful_dispatches
      FROM agent_actions
      WHERE action_type IN ('dispatch', 'chain_dispatch')
        AND started_at >= ${last7Days.toISOString()}
    `;

    const chainDispatchRate = chainDispatchStats?.total_dispatches > 0
      ? (chainDispatchStats.successful_dispatches / chainDispatchStats.total_dispatches) * 100
      : 0;

    // 2. PR merge rate (merged PRs / green-CI PRs) - last 7 days
    const [prStats] = await sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'done' AND pr_number IS NOT NULL) as merged_prs,
        COUNT(*) FILTER (WHERE status IN ('pr_open', 'done') AND pr_number IS NOT NULL) as total_prs
      FROM hive_backlog
      WHERE dispatched_at >= ${last7Days.toISOString()}
        OR completed_at >= ${last7Days.toISOString()}
    `;

    const prMergeRate = prStats?.total_prs > 0
      ? (prStats.merged_prs / prStats.total_prs) * 100
      : 100; // Default to 100% if no PRs (all direct commits)

    // 3. Auto-decompose trigger rate (last 24 hours)
    const [autoDecomposeStats] = await sql`
      SELECT
        COUNT(*) as decompose_triggers
      FROM agent_actions
      WHERE action_type = 'auto_decompose'
        AND started_at >= ${last24Hours.toISOString()}
    `;

    const autoDecomposeRate = autoDecomposeStats?.decompose_triggers || 0;

    // 4. Circuit breaker activation frequency (last 24 hours)
    // Look for error patterns and routing weight degradation
    const [circuitBreakerStats] = await sql`
      SELECT
        COUNT(*) as circuit_breaker_activations
      FROM agent_actions
      WHERE (error ILIKE '%circuit%breaker%' OR error ILIKE '%rate%limit%' OR error ILIKE '%model%unavailable%')
        AND started_at >= ${last24Hours.toISOString()}
    `;

    // Check routing weights for degraded models (success rate < 50%)
    const [degradedModels] = await sql`
      SELECT
        COUNT(*) as degraded_model_count
      FROM routing_weights
      WHERE success_rate < 0.5
        AND (successes + failures) >= 10
        AND last_updated >= ${last24Hours.toISOString()}
    `;

    const circuitBreakerActivations = (circuitBreakerStats?.circuit_breaker_activations || 0) +
                                     (degradedModels?.degraded_model_count || 0);

    // Calculate overall health score (weighted average)
    // Chain dispatch: 30%, PR merge: 25%, Auto-decompose: 20%, Circuit breaker: 25%
    const healthScore = Math.round(
      (chainDispatchRate * 0.30) +
      (prMergeRate * 0.25) +
      (Math.max(0, 100 - autoDecomposeRate * 10) * 0.20) + // Lower decompose rate = better
      (Math.max(0, 100 - circuitBreakerActivations * 5) * 0.25) // Fewer breakers = better
    );

    // Define thresholds
    const thresholds = {
      chainDispatch: 80, // 80% success rate
      prMerge: 70,       // 70% merge rate
      autoDecompose: 5,  // Max 5 auto-decompose triggers per day
      circuitBreaker: 3  // Max 3 circuit breaker activations per day
    };

    // Alert conditions
    const alerts = {
      chainDispatchAlert: chainDispatchRate < thresholds.chainDispatch,
      prMergeAlert: prMergeRate < thresholds.prMerge,
      autoDecomposeAlert: autoDecomposeRate > thresholds.autoDecompose,
      circuitBreakerAlert: circuitBreakerActivations > thresholds.circuitBreaker,
      overallAlert: healthScore < 75
    };

    const metrics = {
      chainDispatchSuccessRate: {
        value: Math.round(chainDispatchRate * 100) / 100,
        total: chainDispatchStats?.total_dispatches || 0,
        successful: chainDispatchStats?.successful_dispatches || 0,
        threshold: thresholds.chainDispatch,
        alert: alerts.chainDispatchAlert,
        period: "7 days"
      },
      prMergeRate: {
        value: Math.round(prMergeRate * 100) / 100,
        merged: prStats?.merged_prs || 0,
        total: prStats?.total_prs || 0,
        threshold: thresholds.prMerge,
        alert: alerts.prMergeAlert,
        period: "7 days"
      },
      autoDecomposeTriggerRate: {
        value: autoDecomposeRate,
        threshold: thresholds.autoDecompose,
        alert: alerts.autoDecomposeAlert,
        period: "24 hours"
      },
      circuitBreakerActivations: {
        value: circuitBreakerActivations,
        errorActivations: circuitBreakerStats?.circuit_breaker_activations || 0,
        modelDegradations: degradedModels?.degraded_model_count || 0,
        threshold: thresholds.circuitBreaker,
        alert: alerts.circuitBreakerAlert,
        period: "24 hours"
      },
      overallHealthScore: {
        value: healthScore,
        status: healthScore >= 85 ? "excellent" :
                healthScore >= 75 ? "good" :
                healthScore >= 60 ? "warning" : "critical",
        alert: alerts.overallAlert
      }
    };

    return json({
      ok: true,
      data: {
        ...metrics,
        timestamp: now.toISOString(),
        thresholds,
        alerts
      }
    });

  } catch (error: any) {
    console.error("[cascade-health] Error calculating health metrics:", error);
    return json({
      ok: false,
      error: "Failed to calculate cascade health metrics",
      detail: error.message
    }, 500);
  }
}