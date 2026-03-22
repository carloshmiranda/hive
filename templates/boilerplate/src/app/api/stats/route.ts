import { neon } from "@neondatabase/serverless";

export const dynamic = "force-dynamic";

// GET /api/stats — returns today's pageview, pricing click, and affiliate click counts
// Called by Hive's metrics cron to collect validation metrics across companies
export async function GET() {
  const sql = neon(process.env.DATABASE_URL!);
  const today = new Date().toISOString().split("T")[0];

  const [[views], [pricing], [affiliate]] = await Promise.all([
    sql`SELECT COALESCE(SUM(views), 0) as total FROM page_views WHERE date = ${today}`,
    sql`SELECT COUNT(*)::int as total FROM pricing_clicks WHERE date = ${today}`.catch(() => [{ total: 0 }]),
    sql`SELECT COUNT(*)::int as total FROM affiliate_clicks WHERE date = ${today}`.catch(() => [{ total: 0 }]),
  ]);

  return Response.json({
    ok: true,
    date: today,
    views: Number(views.total),
    pricing_clicks: Number(pricing.total),
    affiliate_clicks: Number(affiliate.total),
  });
}

// POST /api/stats — increment pageview counter (called from middleware)
export async function POST(req: Request) {
  const { path = "/" } = await req.json().catch(() => ({ path: "/" }));
  const sql = neon(process.env.DATABASE_URL!);

  await sql`
    INSERT INTO page_views (date, path, views)
    VALUES (CURRENT_DATE, ${path}, 1)
    ON CONFLICT (date, path) DO UPDATE SET views = page_views.views + 1
  `;

  return Response.json({ ok: true });
}
