import { getDb, json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { calculateHealthScore } from "@/lib/health-score";
import { invalidateCompanyList } from "@/lib/redis-cache";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const { id } = await params;
  const sql = getDb();
  const [company] = await sql`SELECT * FROM companies WHERE id = ${id} OR slug = ${id}`;
  if (!company) return err("Company not found", 404);

  const [metrics, infra, recentActions, cycles, health] = await Promise.all([
    sql`SELECT date, revenue, mrr, customers, page_views, signups, churn_rate, cac, ad_spend, emails_sent, social_posts, social_engagement, waitlist_signups FROM metrics WHERE company_id = ${company.id} ORDER BY date DESC LIMIT 30`,
    sql`SELECT id, company_id, service, resource_id, config, status, created_at FROM infra WHERE company_id = ${company.id} AND status = 'active'`,
    sql`SELECT id, company_id, cycle_id, agent, action_type, description, status, error, tokens_used, started_at, finished_at FROM agent_actions WHERE company_id = ${company.id} ORDER BY started_at DESC LIMIT 20`,
    sql`SELECT id, company_id, cycle_number, status, started_at, finished_at FROM cycles WHERE company_id = ${company.id} ORDER BY cycle_number DESC LIMIT 10`,
    calculateHealthScore(company.id, sql),
  ]);

  return json({ ...company, metrics, infra, recentActions, cycles, health });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const { id } = await params;
  const body = await req.json();
  const sql = getDb();

  const fields: string[] = [];
  const allowed = ["name", "description", "status", "vercel_project_id", "vercel_url", "github_repo", "neon_project_id", "stripe_account_id", "domain", "kill_reason"];

  // Build dynamic update — only set fields that are provided
  const setClauses = allowed
    .filter(f => body[f] !== undefined)
    .map(f => f);

  if (setClauses.length === 0) return err("No fields to update");

  // Use a simple approach: update each field
  const [company] = await sql`
    UPDATE companies SET
      name = COALESCE(${body.name ?? null}, name),
      description = COALESCE(${body.description ?? null}, description),
      status = COALESCE(${body.status ?? null}, status),
      vercel_project_id = COALESCE(${body.vercel_project_id ?? null}, vercel_project_id),
      vercel_url = COALESCE(${body.vercel_url ?? null}, vercel_url),
      github_repo = COALESCE(${body.github_repo ?? null}, github_repo),
      neon_project_id = COALESCE(${body.neon_project_id ?? null}, neon_project_id),
      stripe_account_id = COALESCE(${body.stripe_account_id ?? null}, stripe_account_id),
      domain = COALESCE(${body.domain ?? null}, domain),
      kill_reason = COALESCE(${body.kill_reason ?? null}, kill_reason),
      killed_at = CASE WHEN ${body.status ?? null} = 'killed' THEN now() ELSE killed_at END,
      updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `;
  if (!company) return err("Company not found", 404);
  await invalidateCompanyList();
  return json(company);
}
