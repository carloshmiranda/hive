import { getDb } from "@/lib/db";

// Vercel Cron: runs at 8am and 6pm (configure in vercel.json)
// Collects page_views from each company's /api/stats endpoint
// Each company app tracks its own pageviews via middleware → page_views table

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  // Verify this is a legit Vercel cron call
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sql = getDb();
  const today = new Date().toISOString().split("T")[0];

  // Get all active/mvp companies with their URLs
  const companies = await sql`
    SELECT c.id, c.slug, COALESCE(c.domain, c.vercel_url) as app_url
    FROM companies c
    WHERE c.status IN ('active', 'mvp')
  `;

  const results: Array<{ slug: string; views: number; pricing_clicks: number; affiliate_clicks: number; source: string }> = [];

  for (const company of companies) {
    try {
      let views = 0;
      let pricingClicks = 0;
      let affiliateClicks = 0;
      let source = "default";

      // Fetch metrics from the company's own /api/stats endpoint
      if (company.app_url) {
        const baseUrl = company.app_url.startsWith("http")
          ? company.app_url
          : `https://${company.app_url}`;

        try {
          const res = await fetch(`${baseUrl}/api/stats`, {
            signal: AbortSignal.timeout(5000),
          });

          if (res.ok) {
            const data = await res.json();
            if (data.ok) {
              views = typeof data.views === "number" ? data.views : 0;
              pricingClicks = typeof data.pricing_clicks === "number" ? data.pricing_clicks : 0;
              affiliateClicks = typeof data.affiliate_clicks === "number" ? data.affiliate_clicks : 0;
              source = "company_api";
            }
          }
        } catch {
          // Company app may not have /api/stats yet — that's fine
          console.log(`${company.slug}: /api/stats not available`);
        }
      }

      // Always ensure a metrics row exists for today (even with 0s)
      await sql`
        INSERT INTO metrics (company_id, date, page_views, pricing_cta_clicks, affiliate_clicks)
        VALUES (${company.id}, ${today}, ${views}, ${pricingClicks}, ${affiliateClicks})
        ON CONFLICT (company_id, date) DO UPDATE SET
          page_views = GREATEST(metrics.page_views, ${views}),
          pricing_cta_clicks = GREATEST(metrics.pricing_cta_clicks, ${pricingClicks}),
          affiliate_clicks = GREATEST(metrics.affiliate_clicks, ${affiliateClicks})
      `;

      results.push({ slug: company.slug, views, pricing_clicks: pricingClicks, affiliate_clicks: affiliateClicks, source });
    } catch (e) {
      console.error(`Failed to collect metrics for ${company.slug}:`, e);
    }
  }

  return Response.json({ ok: true, collected: results.length, results });
}
