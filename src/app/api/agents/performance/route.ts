import { getDb, json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

const AGENTS = ["ceo", "engineer", "growth", "outreach", "ops", "scout"] as const;
type AgentName = (typeof AGENTS)[number];

// Map letter grades to numeric values for averaging
const GRADE_MAP: Record<string, number> = { A: 4, B: 3, C: 2, F: 0 };
const GRADE_LABELS: Record<number, string> = { 4: "A", 3: "B", 2: "C", 0: "F" };

function closestGradeLabel(avg: number): string {
  if (avg >= 3.5) return "A";
  if (avg >= 2.5) return "B";
  if (avg >= 1.0) return "C";
  return "F";
}

interface AgentPerformance {
  avg_grade: string | null;
  avg_grade_numeric: number | null;
  task_completion_pct: number | null;
  error_rate_pct: number;
  avg_turns: number | null;
  total_actions: number;
  insights: string[];
}

export async function GET(req: Request) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("company_id");

  const sql = getDb();

  // Get cycles from the last 30 days, capped at 10
  const cyclesQuery = companyId
    ? sql`
        SELECT id, company_id, cycle_number, ceo_review, started_at
        FROM cycles
        WHERE started_at > now() - INTERVAL '30 days'
          AND status IN ('completed', 'partial')
          AND company_id = ${companyId}
        ORDER BY started_at DESC
        LIMIT 10
      `
    : sql`
        SELECT id, company_id, cycle_number, ceo_review, started_at
        FROM cycles
        WHERE started_at > now() - INTERVAL '30 days'
          AND status IN ('completed', 'partial')
        ORDER BY started_at DESC
        LIMIT 10
      `;

  const cycles = await cyclesQuery;

  if (cycles.length === 0) {
    const emptyAgents: Record<string, AgentPerformance> = {};
    for (const agent of AGENTS) {
      emptyAgents[agent] = {
        avg_grade: null,
        avg_grade_numeric: null,
        task_completion_pct: null,
        error_rate_pct: 0,
        avg_turns: null,
        total_actions: 0,
        insights: ["No completed cycles in the last 30 days"],
      };
    }
    return json({ agents: emptyAgents, period: "last_30d", cycles_analyzed: 0 });
  }

  const cycleIds = cycles.map((c) => c.id as string);
  const companyIds = Array.from(new Set(cycles.map((c) => c.company_id as string)));

  // Query agent_actions for these cycles
  const actions = await sql`
    SELECT agent, status, retry_count, started_at, finished_at, error, cycle_id
    FROM agent_actions
    WHERE cycle_id = ANY(${cycleIds})
  `;

  // Query company_tasks linked to these cycles
  const tasks = await sql`
    SELECT category, status, cycle_id, company_id
    FROM company_tasks
    WHERE company_id = ANY(${companyIds})
      AND (cycle_id = ANY(${cycleIds}) OR (
        status IN ('proposed', 'approved', 'in_progress', 'done')
        AND created_at > now() - INTERVAL '30 days'
      ))
  `;

  // Extract agent grades from ceo_review JSONB
  // Expected structure: ceo_review.agent_grades = { engineer: "A", growth: "B", ... }
  const gradesByAgent: Record<string, number[]> = {};
  const scoresByCycle: { cycle_number: number; score: number; company_id: string }[] = [];

  for (const cycle of cycles) {
    const review = cycle.ceo_review as Record<string, unknown> | null;
    if (!review) continue;

    // Extract score
    const score = review.score as number | undefined;
    if (score != null) {
      scoresByCycle.push({
        cycle_number: cycle.cycle_number,
        score,
        company_id: cycle.company_id,
      });
    }

    // Extract agent grades - check multiple possible locations
    const grades =
      (review.agent_grades as Record<string, string>) ??
      (review.grades as Record<string, string>);
    if (grades && typeof grades === "object") {
      for (const [agent, grade] of Object.entries(grades)) {
        const normalized = agent.toLowerCase();
        if (!AGENTS.includes(normalized as AgentName)) continue;
        const numericGrade = GRADE_MAP[String(grade).toUpperCase()];
        if (numericGrade != null) {
          if (!gradesByAgent[normalized]) gradesByAgent[normalized] = [];
          gradesByAgent[normalized].push(numericGrade);
        }
      }
    }
  }

  // Map task categories to agents
  const CATEGORY_AGENT_MAP: Record<string, AgentName> = {
    engineering: "engineer",
    growth: "growth",
    research: "scout",
    qa: "ops",
    ops: "ops",
    strategy: "ceo",
  };

  // Group tasks by agent
  const tasksByAgent: Record<string, { total: number; done: number }> = {};
  for (const task of tasks) {
    const agent = CATEGORY_AGENT_MAP[task.category] || "ceo";
    if (!tasksByAgent[agent]) tasksByAgent[agent] = { total: 0, done: 0 };
    tasksByAgent[agent].total++;
    if (task.status === "done") tasksByAgent[agent].done++;
  }

  // Group actions by agent
  const actionsByAgent: Record<
    string,
    { total: number; failed: number; totalRetries: number; totalDurationMs: number; withDuration: number }
  > = {};
  for (const action of actions) {
    const agent = action.agent as string;
    if (!actionsByAgent[agent])
      actionsByAgent[agent] = { total: 0, failed: 0, totalRetries: 0, totalDurationMs: 0, withDuration: 0 };
    const a = actionsByAgent[agent];
    a.total++;
    if (action.status === "failed" || action.status === "escalated") a.failed++;
    a.totalRetries += action.retry_count ?? 0;
    if (action.started_at && action.finished_at) {
      const durationMs =
        new Date(action.finished_at).getTime() - new Date(action.started_at).getTime();
      if (durationMs > 0) {
        a.totalDurationMs += durationMs;
        a.withDuration++;
      }
    }
  }

  // Build per-agent performance
  const agentResults: Record<string, AgentPerformance> = {};

  for (const agent of AGENTS) {
    const grades = gradesByAgent[agent];
    const actionsData = actionsByAgent[agent];
    const tasksData = tasksByAgent[agent];
    const insights: string[] = [];

    // Average grade
    let avgGradeNumeric: number | null = null;
    let avgGradeLabel: string | null = null;
    if (grades && grades.length > 0) {
      avgGradeNumeric = parseFloat((grades.reduce((s, g) => s + g, 0) / grades.length).toFixed(2));
      avgGradeLabel = closestGradeLabel(avgGradeNumeric);
    }

    // Task completion
    let taskCompletionPct: number | null = null;
    if (tasksData && tasksData.total > 0) {
      taskCompletionPct = parseFloat(((tasksData.done / tasksData.total) * 100).toFixed(1));
    }

    // Error rate
    let errorRatePct = 0;
    let totalActions = 0;
    if (actionsData && actionsData.total > 0) {
      totalActions = actionsData.total;
      errorRatePct = parseFloat(((actionsData.failed / actionsData.total) * 100).toFixed(1));
    }

    // Average turns (using retry_count as proxy for turns/attempts)
    let avgTurns: number | null = null;
    if (actionsData && actionsData.total > 0) {
      avgTurns = parseFloat(
        ((actionsData.totalRetries / actionsData.total) + 1).toFixed(1)
      );
    }

    // Generate insights
    if (errorRatePct > 50) {
      insights.push(
        `${agent} has a critically high error rate (${errorRatePct}%) across ${totalActions} actions`
      );
    } else if (errorRatePct > 25) {
      insights.push(
        `${agent} error rate is elevated at ${errorRatePct}% — review recent failures`
      );
    }

    if (tasksData && tasksData.total > 0 && tasksData.done === 0 && tasksData.total >= 3) {
      insights.push(
        `${agent} has completed 0/${tasksData.total} tasks in the analysis period`
      );
    } else if (taskCompletionPct != null && taskCompletionPct < 30 && tasksData!.total >= 3) {
      insights.push(
        `${agent} task completion is low: ${tasksData!.done}/${tasksData!.total} (${taskCompletionPct}%)`
      );
    }

    if (avgGradeLabel === "F") {
      insights.push(`${agent} is consistently graded F by the CEO — needs immediate attention`);
    } else if (avgGradeLabel === "C") {
      insights.push(`${agent} is averaging a C grade — underperforming expectations`);
    }

    if (grades && grades.length >= 3) {
      const recent3 = grades.slice(0, 3);
      const older = grades.slice(3);
      if (older.length > 0) {
        const recentAvg = recent3.reduce((s, g) => s + g, 0) / recent3.length;
        const olderAvg = older.reduce((s, g) => s + g, 0) / older.length;
        if (recentAvg - olderAvg >= 1) {
          insights.push(`${agent} performance is trending upward (recent avg ${closestGradeLabel(recentAvg)} vs earlier ${closestGradeLabel(olderAvg)})`);
        } else if (olderAvg - recentAvg >= 1) {
          insights.push(`${agent} performance is declining (recent avg ${closestGradeLabel(recentAvg)} vs earlier ${closestGradeLabel(olderAvg)})`);
        }
      }
    }

    if (avgTurns != null && avgTurns > 2.5) {
      insights.push(`${agent} averaging ${avgTurns} attempts per action — high retry rate`);
    }

    if (totalActions === 0 && cycles.length >= 3) {
      insights.push(`${agent} had no recorded actions in ${cycles.length} analyzed cycles`);
    }

    agentResults[agent] = {
      avg_grade: avgGradeLabel,
      avg_grade_numeric: avgGradeNumeric,
      task_completion_pct: taskCompletionPct,
      error_rate_pct: errorRatePct,
      avg_turns: avgTurns,
      total_actions: totalActions,
      insights,
    };
  }

  // Cycle score correlation with agent grades
  const correlationInsights: string[] = [];
  if (scoresByCycle.length >= 3) {
    const avgScore = parseFloat(
      (scoresByCycle.reduce((s, c) => s + c.score, 0) / scoresByCycle.length).toFixed(1)
    );
    if (avgScore <= 4) {
      correlationInsights.push(
        `Average cycle score is ${avgScore}/10 across ${scoresByCycle.length} cycles — portfolio is underperforming`
      );
    }

    // Find agents whose grade correlates with low scores
    for (const agent of AGENTS) {
      const grades = gradesByAgent[agent];
      if (!grades || grades.length < 2) continue;
      const avgGrade = grades.reduce((s, g) => s + g, 0) / grades.length;
      if (avgGrade < 2 && avgScore < 5) {
        correlationInsights.push(
          `Low cycle scores may correlate with ${agent}'s poor grades (avg ${closestGradeLabel(avgGrade)})`
        );
      }
    }
  }

  return json({
    agents: agentResults,
    period: "last_30d",
    cycles_analyzed: cycles.length,
    avg_cycle_score: scoresByCycle.length > 0
      ? parseFloat(
          (scoresByCycle.reduce((s, c) => s + c.score, 0) / scoresByCycle.length).toFixed(1)
        )
      : null,
    correlation_insights: correlationInsights,
  });
}
