import { getDb, json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { setSentryTags } from "@/lib/sentry-tags";

// Consolidated dashboard endpoint: 1 function invocation instead of 6
// GET /api/dashboard          → main dashboard data
// GET /api/dashboard?slug=x   → company detail data

export async function GET(req: Request) {
  setSentryTags({
    action_type: "admin",
    route: "/api/dashboard",
  });

  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const { searchParams } = new URL(req.url);
  const slug = searchParams.get("slug");
  const sql = getDb();

  if (slug) {
    return companyDetail(sql, slug);
  }
  return mainDashboard(sql);
}

async function mainDashboard(sql: ReturnType<typeof getDb>) {
  const [counts, revenue, pendingCount, todayTokens, lastCycle, companies, actions, approvals, playbook, cycles, evolverProposals, tasks] =
    await Promise.all([
      sql`
        SELECT
          count(*) FILTER (WHERE status IN ('active', 'mvp')) as live_companies,
          count(*) as total_companies,
          count(*) FILTER (WHERE status = 'killed') as killed_companies
        FROM companies
      `.then(r => r[0]),
      sql`
        SELECT
          COALESCE(SUM(m.mrr), 0) as total_mrr,
          COALESCE(SUM(m.revenue), 0) as total_revenue,
          COALESCE(SUM(m.customers), 0) as total_customers
        FROM (
          SELECT DISTINCT ON (company_id) * FROM metrics ORDER BY company_id, date DESC
        ) m
        JOIN companies c ON c.id = m.company_id
        WHERE c.status IN ('active', 'mvp')
      `.then(r => r[0]),
      sql`SELECT count(*) as count FROM approvals WHERE status = 'pending'`.then(r => r[0]),
      sql`
        SELECT COALESCE(SUM(tokens_used), 0) as total
        FROM agent_actions WHERE started_at >= CURRENT_DATE
      `.then(r => r[0]),
      sql`SELECT started_at FROM cycles ORDER BY started_at DESC LIMIT 1`.then(r => r[0] || null),
      // Companies with latest metrics + pending approvals + task stats
      sql`
        SELECT c.*,
          (SELECT row_to_json(m) FROM metrics m WHERE m.company_id = c.id ORDER BY m.date DESC LIMIT 1) as latest_metrics,
          (SELECT count(*) FROM approvals a WHERE a.company_id = c.id AND a.status = 'pending') as pending_approvals,
          (SELECT coalesce(json_agg(json_build_object('gate_type', a.gate_type, 'title', a.title) ORDER BY a.created_at), '[]'::json) FROM approvals a WHERE a.company_id = c.id AND a.status = 'pending') as pending_approval_details,
          (SELECT count(*) FROM company_tasks t WHERE t.company_id = c.id AND t.status = 'done') as tasks_done,
          (SELECT count(*) FROM company_tasks t WHERE t.company_id = c.id AND t.status NOT IN ('dismissed')) as tasks_total
        FROM companies c
        ORDER BY
          CASE c.status
            WHEN 'active' THEN 1 WHEN 'mvp' THEN 2 WHEN 'provisioning' THEN 3
            WHEN 'approved' THEN 4 WHEN 'idea' THEN 5 WHEN 'paused' THEN 6 WHEN 'killed' THEN 7
          END,
          c.created_at DESC
      `,
      // Actions — exclude large output/input JSONB columns (~50KB each)
      sql`
        SELECT a.id, a.company_id, a.cycle_id, a.agent, a.action_type, a.status,
          a.description, a.reflection, a.error, a.tokens_used, a.started_at, a.finished_at,
          c.slug as company_slug
        FROM agent_actions a
        LEFT JOIN companies c ON c.id = a.company_id
        ORDER BY a.started_at DESC LIMIT 50
      `,
      // Pending approvals
      sql`
        SELECT a.*, c.name as company_name, c.slug as company_slug
        FROM approvals a LEFT JOIN companies c ON c.id = a.company_id
        WHERE a.status = 'pending'
        ORDER BY a.created_at ASC
      `,
      // Playbook
      sql`
        SELECT p.*, c.name as source_company FROM playbook p
        LEFT JOIN companies c ON c.id = p.source_company_id
        WHERE p.superseded_by IS NULL
        ORDER BY p.confidence DESC LIMIT 50
      `,
      // Cycles — exclude ceo_plan JSONB (not needed for dashboard list view)
      sql`
        SELECT c.id, c.company_id, c.cycle_number, c.status, c.started_at, c.finished_at,
          co.name as company_name, co.slug as company_slug
        FROM cycles c JOIN companies co ON co.id = c.company_id
        ORDER BY c.started_at DESC LIMIT 20
      `,
      // Evolver proposals (pending) — exclude large prompt columns for list view
      sql`
        SELECT id, title, severity, status, created_at
        FROM evolver_proposals
        WHERE status = 'pending'
        ORDER BY
          CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
          created_at DESC
        LIMIT 20
      `.catch(() => []),
      sql`
        SELECT t.*, c.slug as company_slug, c.name as company_name
        FROM company_tasks t JOIN companies c ON c.id = t.company_id
        WHERE t.status NOT IN ('done', 'dismissed')
        ORDER BY t.priority ASC, t.created_at DESC
        LIMIT 100
      `.catch(() => []),
    ]);

  return json({
    portfolio: {
      live_companies: Number(counts.live_companies),
      total_companies: Number(counts.total_companies),
      killed_companies: Number(counts.killed_companies),
      total_mrr: Number(revenue.total_mrr),
      total_revenue: Number(revenue.total_revenue),
      total_customers: Number(revenue.total_customers),
      pending_approvals: Number(pendingCount.count),
      tokens_today: Number(todayTokens.total),
      last_cycle_at: lastCycle?.started_at || null,
    },
    companies,
    actions,
    approvals,
    playbook,
    cycles,
    evolverProposals,
    tasks,
  });
}

async function companyDetail(sql: ReturnType<typeof getDb>, slug: string) {
  const [company] = await sql`
    SELECT c.*,
      (SELECT row_to_json(m) FROM metrics m WHERE m.company_id = c.id ORDER BY m.date DESC LIMIT 1) as latest_metrics,
      (SELECT count(*) FROM approvals a WHERE a.company_id = c.id AND a.status = 'pending') as pending_approvals
    FROM companies c WHERE c.slug = ${slug}
  `;
  if (!company) return err("Company not found", 404);

  const [cycles, actions, metrics, approvals, research, tasks] = await Promise.all([
    sql`SELECT * FROM cycles WHERE company_id = ${company.id} ORDER BY cycle_number DESC LIMIT 20`,
    sql`
      SELECT a.id, a.company_id, a.cycle_id, a.agent, a.action_type, a.status,
        a.description, a.reflection, a.error, a.tokens_used, a.started_at, a.finished_at,
        c.slug as company_slug
      FROM agent_actions a
      LEFT JOIN companies c ON c.id = a.company_id
      WHERE a.company_id = ${company.id}
      ORDER BY a.started_at DESC LIMIT 50
    `,
    sql`
      SELECT * FROM metrics WHERE company_id = ${company.id}
      AND date >= CURRENT_DATE - 30 * INTERVAL '1 day'
      ORDER BY date DESC
    `,
    sql`
      SELECT a.*, c.name as company_name, c.slug as company_slug
      FROM approvals a LEFT JOIN companies c ON c.id = a.company_id
      WHERE (a.company_id = ${company.id} OR a.company_id IS NULL)
      ORDER BY a.created_at DESC LIMIT 50
    `,
    sql`
      SELECT r.*, c.name as company_name, c.slug as company_slug
      FROM research_reports r JOIN companies c ON c.id = r.company_id
      WHERE r.company_id = ${company.id}
      ORDER BY r.created_at DESC
    `,
    sql`
      SELECT * FROM company_tasks
      WHERE company_id = ${company.id} AND status NOT IN ('done', 'dismissed')
      ORDER BY priority ASC, created_at DESC
    `.catch(() => []),
  ]);

  return json({ company, cycles, actions, metrics, approvals, research, tasks });
}
