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
      COALESCE(SUM(m.customers), 0) as total_customers
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

  const [lastCycle] = await sql`
    SELECT started_at FROM cycles ORDER BY started_at DESC LIMIT 1
  `;

  return json({
    live_companies: Number(counts.live_companies),
    total_companies: Number(counts.total_companies),
    killed_companies: Number(counts.killed_companies),
    total_mrr: Number(revenue.total_mrr),
    total_revenue: Number(revenue.total_revenue),
    total_customers: Number(revenue.total_customers),
    pending_approvals: Number(pendingCount.count),
    tokens_today: Number(todayTokens.total),
    last_cycle_at: lastCycle?.started_at || null,
  });
}
