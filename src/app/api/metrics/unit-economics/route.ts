import { getDb, json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { computeUnitEconomics } from "@/lib/unit-economics";

export async function GET(req: Request) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("company_id");
  const slug = searchParams.get("slug");

  if (!companyId && !slug) return err("company_id or slug required");

  const sql = getDb();

  // Resolve company
  let resolvedCompanyId = companyId;
  let companyCreatedAt: string;

  if (slug && !companyId) {
    const companies = await sql`
      SELECT id, created_at FROM companies WHERE slug = ${slug} LIMIT 1
    `;
    if (companies.length === 0) return err("Company not found", 404);
    resolvedCompanyId = companies[0].id;
    companyCreatedAt = companies[0].created_at;
  } else {
    const companies = await sql`
      SELECT created_at FROM companies WHERE id = ${resolvedCompanyId!} LIMIT 1
    `;
    if (companies.length === 0) return err("Company not found", 404);
    companyCreatedAt = companies[0].created_at;
  }

  // Fetch all metrics for this company (up to 365 days for cohort analysis)
  const metrics = await sql`
    SELECT date, revenue, mrr, customers, churn_rate, cac, ad_spend, signups
    FROM metrics
    WHERE company_id = ${resolvedCompanyId!}
      AND date >= CURRENT_DATE - INTERVAL '365 days'
    ORDER BY date ASC
  `;

  const result = computeUnitEconomics({
    metrics: metrics.map(m => ({
      date: typeof m.date === 'string' ? m.date : new Date(m.date).toISOString().split('T')[0],
      revenue: Number(m.revenue) || 0,
      mrr: Number(m.mrr) || 0,
      customers: Number(m.customers) || 0,
      churn_rate: Number(m.churn_rate) || 0,
      cac: Number(m.cac) || 0,
      ad_spend: Number(m.ad_spend) || 0,
      signups: Number(m.signups) || 0,
    })),
    companyCreatedAt,
  });

  return json(result);
}
