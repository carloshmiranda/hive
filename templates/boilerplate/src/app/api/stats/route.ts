import { neon } from "@neondatabase/serverless";

export const dynamic = "force-dynamic";

// GET /api/stats — returns today's pageview count
// Called by Hive's metrics cron to collect views across companies
export async function GET() {
  const sql = neon(process.env.DATABASE_URL!);
  const today = new Date().toISOString().split("T")[0];

  const [row] = await sql`
    SELECT COALESCE(SUM(views), 0) as total_views
    FROM page_views WHERE date = ${today}
  `;

  return Response.json({ ok: true, date: today, views: Number(row.total_views) });
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
