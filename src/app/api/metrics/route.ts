import { getDb, json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { invalidateCompanyMetrics } from "@/lib/redis-cache";

export async function GET(req: Request) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("company_id");
  const days = Math.min(parseInt(searchParams.get("days") || "30"), 365);

  const sql = getDb();

  if (companyId) {
    const metrics = await sql`
      SELECT * FROM metrics WHERE company_id = ${companyId} AND date >= CURRENT_DATE - ${days} * INTERVAL '1 day'
      ORDER BY date DESC
    `;
    return json(metrics);
  }

  // Portfolio-wide: latest metrics per company
  const metrics = await sql`
    SELECT DISTINCT ON (m.company_id) m.*, c.name as company_name, c.slug as company_slug
    FROM metrics m JOIN companies c ON c.id = m.company_id
    WHERE c.status IN ('active', 'mvp')
    ORDER BY m.company_id, m.date DESC
  `;
  return json(metrics);
}

export async function POST(req: Request) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const body = await req.json();
  const { company_id, date, ...data } = body;
  if (!company_id) return err("company_id required");

  const sql = getDb();
  const [metric] = await sql`
    INSERT INTO metrics (company_id, date, revenue, mrr, customers, page_views, signups, churn_rate, cac, ad_spend, emails_sent, social_posts, social_engagement)
    VALUES (
      ${company_id}, ${date || new Date().toISOString().split("T")[0]},
      ${data.revenue || 0}, ${data.mrr || 0}, ${data.customers || 0},
      ${data.page_views || 0}, ${data.signups || 0}, ${data.churn_rate || 0},
      ${data.cac || 0}, ${data.ad_spend || 0}, ${data.emails_sent || 0},
      ${data.social_posts || 0}, ${data.social_engagement || 0}
    )
    ON CONFLICT (company_id, date) DO UPDATE SET
      revenue = EXCLUDED.revenue, mrr = EXCLUDED.mrr, customers = EXCLUDED.customers,
      page_views = EXCLUDED.page_views, signups = EXCLUDED.signups, churn_rate = EXCLUDED.churn_rate,
      cac = EXCLUDED.cac, ad_spend = EXCLUDED.ad_spend, emails_sent = EXCLUDED.emails_sent,
      social_posts = EXCLUDED.social_posts, social_engagement = EXCLUDED.social_engagement
    RETURNING *
  `;

  // Invalidate metrics cache for this company
  try {
    const company = await sql`SELECT slug FROM companies WHERE id = ${company_id} LIMIT 1`;
    if (company.length > 0) {
      await Promise.all([
        invalidateCompanyMetrics(company[0].slug),
        invalidateCompanyMetrics(`${company[0].slug}:growth`),
      ]);
    }
  } catch (err) {
    // Cache invalidation failure should not break the metrics update
    console.warn(`Failed to invalidate metrics cache for company ${company_id}:`, err);
  }

  return json(metric, 201);
}
