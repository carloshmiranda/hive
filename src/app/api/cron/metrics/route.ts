import { getDb } from "@/lib/db";
import { getSettingValue } from "@/lib/settings";

// Vercel Cron: runs at 8am and 6pm (configure in vercel.json)
// Collects page_views from Vercel Analytics for all active companies
// The nightly loop still does full analysis — this keeps the dashboard current during the day

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  // Verify this is a legit Vercel cron call
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sql = getDb();
  const vercelToken = await getSettingValue("vercel_token");
  if (!vercelToken) return Response.json({ error: "Vercel token not configured" }, { status: 500 });

  const today = new Date().toISOString().split("T")[0];

  // Get all active companies with Vercel project IDs
  const companies = await sql`
    SELECT c.id, c.slug, c.vercel_project_id FROM companies c
    WHERE c.status IN ('active', 'mvp') AND c.vercel_project_id IS NOT NULL
  `;

  const results: Array<{ slug: string; views: number }> = [];

  for (const company of companies) {
    try {
      // Fetch page views from Vercel Web Analytics
      const from = new Date();
      from.setHours(0, 0, 0, 0);

      const res = await fetch(
        `https://vercel.com/api/web/insights/stats?projectId=${company.vercel_project_id}&from=${from.toISOString()}&to=${new Date().toISOString()}`,
        { headers: { Authorization: `Bearer ${vercelToken}` } }
      );

      if (res.ok) {
        const data = await res.json();
        const views = data.pageViews || data.totalPageViews || 0;

        await sql`
          INSERT INTO metrics (company_id, date, page_views)
          VALUES (${company.id}, ${today}, ${views})
          ON CONFLICT (company_id, date) DO UPDATE SET page_views = ${views}
        `;

        results.push({ slug: company.slug, views });
      }
    } catch (e) {
      // Non-critical — log and continue
      console.error(`Failed to fetch analytics for ${company.slug}:`, e);
    }
  }

  return Response.json({ ok: true, collected: results.length, results });
}
