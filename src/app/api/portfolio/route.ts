import { getDb, json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

export async function GET() {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const sql = getDb();

  const [counts] = await sql`
    SELECT
      count(*) FILTER (WHERE status IN ('active', 'mvp')) as live_companies,
      count(*) as total_companies,
      count(*) FILTER (WHERE status = 'killed') as killed_companies
    FROM companies
  `;

  const [revenue] = await sql`
    SELECT
      COALESCE(SUM(m.mrr), 0) as total_mrr,
      COALESCE(SUM(m.revenue), 0) as total_revenue,
      COALESCE(SUM(m.customers), 0) as total_customers,
      COALESCE(SUM(m.waitlist_total), 0) as total_waitlist
    FROM (
      SELECT DISTINCT ON (company_id) * FROM metrics ORDER BY company_id, date DESC
    ) m
    JOIN companies c ON c.id = m.company_id
    WHERE c.status IN ('active', 'mvp')
  `;

  const [pendingCount] = await sql`SELECT count(*) as count FROM approvals WHERE status = 'pending'`;

  const [todayTokens] = await sql`
    SELECT COALESCE(SUM(tokens_used), 0) as total
    FROM agent_actions WHERE started_at >= CURRENT_DATE
  `;

  // Cost estimate: count actions per agent in last 24h, apply model cost rates
  const costByAgent = await sql`
    SELECT agent, COUNT(*) as actions
    FROM agent_actions
    WHERE started_at >= NOW() - INTERVAL '24 hours'
    GROUP BY agent
  `;
  const COST_PER_ACTION: Record<string, number> = {
    ceo: 0.15, scout: 0.15, evolver: 0.15, engineer: 0.03,
    growth: 0, outreach: 0, ops: 0,
  };
  const estCost24h = costByAgent.reduce((sum: number, row: any) =>
    sum + Number(row.actions) * (COST_PER_ACTION[row.agent] ?? 0.03), 0
  );

  // Budget utilization: turns in last 5h vs 225 max
  const [turns5h] = await sql`
    SELECT COUNT(*) as cnt FROM agent_actions
    WHERE started_at >= NOW() - INTERVAL '5 hours'
    AND agent IN ('ceo', 'scout', 'engineer', 'evolver')
  `;

  const [lastCycle] = await sql`
    SELECT started_at FROM cycles ORDER BY started_at DESC LIMIT 1
  `;

  // Roadmap theme progress
  const themeProgress = await sql`
    SELECT COALESCE(theme, 'uncategorized') as theme,
      count(*) FILTER (WHERE status = 'done')::int as done,
      count(*) FILTER (WHERE status NOT IN ('done', 'rejected'))::int as active
    FROM hive_backlog
    WHERE theme IS NOT NULL AND theme != 'uncategorized'
    GROUP BY theme ORDER BY active DESC
  `.catch(() => []);

  const roadmap = themeProgress.map((r: any) => ({
    theme: r.theme,
    done: r.done,
    active: r.active,
    pct: (r.done + r.active) > 0 ? Math.round(r.done / (r.done + r.active) * 100) : 0,
  }));

  return json({
    live_companies: Number(counts.live_companies),
    total_companies: Number(counts.total_companies),
    killed_companies: Number(counts.killed_companies),
    total_mrr: Number(revenue.total_mrr),
    total_revenue: Number(revenue.total_revenue),
    total_customers: Number(revenue.total_customers),
    total_waitlist: Number(revenue.total_waitlist),
    pending_approvals: Number(pendingCount.count),
    tokens_today: Number(todayTokens.total),
    est_cost_24h: Math.round(estCost24h * 100) / 100,
    budget_utilization_pct: Math.round((Number(turns5h.cnt) / 225) * 100),
    last_cycle_at: lastCycle?.started_at || null,
    roadmap,
  });
}
