import { getDb } from "@/lib/db";
import { getSettingValue } from "@/lib/settings";

// Vercel Cron: runs at 8am and 6pm (configure in vercel.json)
// Collects page_views from Vercel Analytics for all active companies
// Also ensures every MVP/active company has a metrics row for today

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
  const today = new Date().toISOString().split("T")[0];

  // Get all active/mvp companies — use infra table for Vercel project IDs
  // since companies.vercel_project_id may not be set
  const companies = await sql`
    SELECT c.id, c.slug,
      COALESCE(c.vercel_project_id, i.resource_id) as vercel_project_id
    FROM companies c
    LEFT JOIN infra i ON i.company_id = c.id AND i.service = 'vercel'
    WHERE c.status IN ('active', 'mvp')
  `;

  const results: Array<{ slug: string; views: number; source: string }> = [];

  for (const company of companies) {
    try {
      let views = 0;
      let source = "default";

      // Try Vercel Analytics if we have a project ID and token
      if (vercelToken && company.vercel_project_id) {
        const from = new Date();
        from.setHours(0, 0, 0, 0);

        const res = await fetch(
          `https://vercel.com/api/web/insights/stats?projectId=${company.vercel_project_id}&from=${from.toISOString()}&to=${new Date().toISOString()}`,
          { headers: { Authorization: `Bearer ${vercelToken}` } }
        );

        if (res.ok) {
          const data = await res.json();
          views = data.pageViews || data.totalPageViews || 0;
          source = "vercel_analytics";
        }
      }

      // Always ensure a metrics row exists for today (even with 0s)
      // This prevents the dashboard from showing "no data"
      await sql`
        INSERT INTO metrics (company_id, date, page_views)
        VALUES (${company.id}, ${today}, ${views})
        ON CONFLICT (company_id, date) DO UPDATE SET page_views = GREATEST(metrics.page_views, ${views})
      `;

      results.push({ slug: company.slug, views, source });
    } catch (e) {
      console.error(`Failed to collect metrics for ${company.slug}:`, e);
    }
  }

  return Response.json({ ok: true, collected: results.length, results });
}
