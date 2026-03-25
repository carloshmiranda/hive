import { getDb } from "@/lib/db";

// Strip UUIDs, timestamps, URLs, and long hex strings from error messages for grouping
function normalizeError(error: string): string {
  return error
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "UUID")
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\dZ]*/g, "TIMESTAMP")
    .replace(/https?:\/\/[^\s)]+/g, "URL")
    .replace(/[0-9a-f]{16,}/gi, "HEX")
    .trim()
    .slice(0, 100);
}

type AgentProfile = {
  overall_success_rate: number;
  trend: "improving" | "declining" | "stable";
  by_action_type: Record<string, { success_rate: number; avg_duration_s: number; count: number }>;
  top_failure_patterns: Array<{ pattern: string; count: number; pct: number }>;
  by_company: Record<string, { success_rate: number }>;
  strengths: string[];
  weaknesses: string[];
  recent_prs: Array<{ pr_number: number; branch: string; changed_files?: string[]; finished_at: string }>;
};

export type AgentProfilesResult = {
  profiles: Record<string, AgentProfile>;
  recommendations: string[];
};

/**
 * Compute agent specialization profiles from the last 30 days of agent_actions.
 */
export async function getAgentProfiles(): Promise<AgentProfilesResult> {
  const sql = getDb();

  // Fetch all completed actions from the last 30 days with company slugs
  const actions = await sql`
    SELECT
      aa.agent,
      aa.action_type,
      aa.status,
      aa.error,
      aa.company_id,
      aa.output,
      c.slug,
      EXTRACT(EPOCH FROM (aa.finished_at - aa.started_at))::int as duration_s,
      aa.finished_at
    FROM agent_actions aa
    LEFT JOIN companies c ON c.id = aa.company_id
    WHERE aa.status IN ('success', 'failed')
      AND aa.finished_at > NOW() - INTERVAL '30 days'
    ORDER BY aa.finished_at DESC
  `;

  // Query per-agent trend stats (last 7 days vs previous 7 days)
  const recentByAgent = await sql`
    SELECT agent,
      COUNT(*) FILTER (WHERE status = 'success')::int as successes,
      COUNT(*)::int as total
    FROM agent_actions
    WHERE status IN ('success', 'failed')
      AND finished_at > NOW() - INTERVAL '7 days'
    GROUP BY agent
  `.catch(() => []);

  const priorByAgent = await sql`
    SELECT agent,
      COUNT(*) FILTER (WHERE status = 'success')::int as successes,
      COUNT(*)::int as total
    FROM agent_actions
    WHERE status IN ('success', 'failed')
      AND finished_at BETWEEN NOW() - INTERVAL '14 days' AND NOW() - INTERVAL '7 days'
    GROUP BY agent
  `.catch(() => []);

  const recentMap: Record<string, { successes: number; total: number }> = {};
  for (const r of recentByAgent) {
    recentMap[r.agent as string] = { successes: Number(r.successes), total: Number(r.total) };
  }
  const priorMap: Record<string, { successes: number; total: number }> = {};
  for (const r of priorByAgent) {
    priorMap[r.agent as string] = { successes: Number(r.successes), total: Number(r.total) };
  }

  // Group actions by agent
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byAgent: Record<string, any[]> = {};
  for (const row of actions) {
    const agent = row.agent as string;
    if (!byAgent[agent]) byAgent[agent] = [];
    byAgent[agent].push(row);
  }

  const profiles: Record<string, AgentProfile> = {};
  const recommendations: string[] = [];

  for (const [agent, agentActions] of Object.entries(byAgent)) {
    const total = agentActions.length;
    const successes = agentActions.filter((a) => a.status === "success").length;
    const overallRate = total > 0 ? successes / total : 0;

    // Trend
    const recent = recentMap[agent];
    const prior = priorMap[agent];
    const recentRate = recent && recent.total >= 3 ? recent.successes / recent.total : null;
    const priorRate = prior && prior.total >= 3 ? prior.successes / prior.total : null;
    let trend: "improving" | "declining" | "stable" = "stable";
    if (recentRate !== null && priorRate !== null) {
      const delta = recentRate - priorRate;
      if (delta > 0.1) trend = "improving";
      else if (delta < -0.1) trend = "declining";
    }

    // By action_type
    const byActionType: Record<string, { successes: number; total: number; durations: number[] }> = {};
    for (const a of agentActions) {
      const at = a.action_type as string;
      if (!byActionType[at]) byActionType[at] = { successes: 0, total: 0, durations: [] };
      byActionType[at].total++;
      if (a.status === "success") byActionType[at].successes++;
      if (a.duration_s != null && a.duration_s > 0) byActionType[at].durations.push(Number(a.duration_s));
    }

    const actionTypeStats: Record<string, { success_rate: number; avg_duration_s: number; count: number }> = {};
    for (const [at, stats] of Object.entries(byActionType)) {
      const avgDuration = stats.durations.length > 0
        ? Math.round(stats.durations.reduce((a, b) => a + b, 0) / stats.durations.length)
        : 0;
      actionTypeStats[at] = {
        success_rate: Math.round((stats.successes / stats.total) * 100) / 100,
        avg_duration_s: avgDuration,
        count: stats.total,
      };
    }

    // Failure patterns
    const failedActions = agentActions.filter((a) => a.status === "failed" && a.error);
    const errorCounts: Record<string, number> = {};
    for (const a of failedActions) {
      const normalized = normalizeError(a.error!);
      if (normalized) {
        errorCounts[normalized] = (errorCounts[normalized] || 0) + 1;
      }
    }
    const totalFailures = failedActions.length;
    const topFailurePatterns = Object.entries(errorCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([pattern, count]) => ({
        pattern,
        count,
        pct: totalFailures > 0 ? Math.round((count / totalFailures) * 100) / 100 : 0,
      }));

    // By company
    const byCompany: Record<string, { successes: number; total: number }> = {};
    for (const a of agentActions) {
      const slug = a.slug as string | null;
      if (!slug) continue;
      if (!byCompany[slug]) byCompany[slug] = { successes: 0, total: 0 };
      byCompany[slug].total++;
      if (a.status === "success") byCompany[slug].successes++;
    }
    const companyStats: Record<string, { success_rate: number }> = {};
    for (const [slug, stats] of Object.entries(byCompany)) {
      companyStats[slug] = {
        success_rate: Math.round((stats.successes / stats.total) * 100) / 100,
      };
    }

    // Strengths and weaknesses (by action_type, min 3 actions)
    const strengths: string[] = [];
    const weaknesses: string[] = [];
    for (const [at, stats] of Object.entries(actionTypeStats)) {
      if (byActionType[at].total < 3) continue;
      if (stats.success_rate >= 0.8) strengths.push(at);
      else if (stats.success_rate < 0.5) weaknesses.push(at);
    }

    // Extract recent PRs from successful actions
    const recent_prs: Array<{ pr_number: number; branch: string; changed_files?: string[]; finished_at: string }> = [];
    for (const a of agentActions) {
      if (a.status === "success" && a.output) {
        try {
          const output = typeof a.output === 'string' ? JSON.parse(a.output) : a.output;
          const prTracking = output?.pr_tracking;
          if (prTracking && prTracking.pr_number && prTracking.branch) {
            recent_prs.push({
              pr_number: Number(prTracking.pr_number),
              branch: String(prTracking.branch),
              changed_files: Array.isArray(prTracking.changed_files) ? prTracking.changed_files : undefined,
              finished_at: a.finished_at
            });
          }
        } catch {
          // Ignore JSON parse errors
        }
      }
    }
    // Sort by most recent first and limit to 10
    recent_prs.sort((a, b) => new Date(b.finished_at).getTime() - new Date(a.finished_at).getTime());
    recent_prs.splice(10);

    profiles[agent] = {
      overall_success_rate: Math.round(overallRate * 100) / 100,
      trend,
      by_action_type: actionTypeStats,
      top_failure_patterns: topFailurePatterns,
      by_company: companyStats,
      strengths,
      weaknesses,
      recent_prs,
    };

    // Generate recommendations
    if (overallRate < 0.3 && total >= 5) {
      recommendations.push(
        `${agent} has ${Math.round(overallRate * 100)}% success rate — check if API keys are configured and prompts are working`
      );
    }
    for (const [at, stats] of Object.entries(actionTypeStats)) {
      if (stats.success_rate < 0.5 && byActionType[at].total >= 3) {
        const failRate = Math.round((1 - stats.success_rate) * 100);
        recommendations.push(
          `${agent} has ${failRate}% failure rate on ${at} — consider splitting into smaller steps`
        );
      }
    }
    if (trend === "declining" && recentRate !== null && priorRate !== null) {
      recommendations.push(
        `${agent} success rate declining: ${Math.round(priorRate * 100)}% → ${Math.round(recentRate * 100)}% (last 7d vs prior 7d)`
      );
    }
  }

  return { profiles, recommendations };
}

/**
 * Get a compact summary of agent profiles suitable for CEO context injection.
 * Returns a small object with just what the CEO needs for task assignment.
 */
export async function getAgentProfileSummary(): Promise<
  Array<{
    agent: string;
    success_rate: number;
    trend: string;
    strengths: string[];
    weaknesses: string[];
    top_failure: string | null;
  }>
> {
  const { profiles } = await getAgentProfiles();

  return Object.entries(profiles).map(([agent, profile]) => ({
    agent,
    success_rate: profile.overall_success_rate,
    trend: profile.trend,
    strengths: profile.strengths.slice(0, 3),
    weaknesses: profile.weaknesses.slice(0, 3),
    top_failure: profile.top_failure_patterns[0]?.pattern || null,
  }));
}
