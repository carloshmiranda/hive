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

  // Single JOIN query — eliminates the company-lookup + metrics round-trip
  const rows = await sql`
    SELECT m.date, m.revenue, m.mrr, m.customers, m.churn_rate, m.cac, m.ad_spend, m.signups,
           c.id as resolved_id, c.created_at as company_created_at
    FROM companies c
    LEFT JOIN metrics m ON m.company_id = c.id
      AND m.date >= CURRENT_DATE - INTERVAL '365 days'
    WHERE c.id = ${companyId || null} OR c.slug = ${slug || null}
    ORDER BY m.date ASC NULLS LAST
  `;

  if (rows.length === 0 || rows[0].resolved_id === null) return err("Company not found", 404);
  const companyCreatedAt: string = rows[0].company_created_at;
  const metrics = rows.filter((r: Record<string, any>) => r.date !== null);

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
