import { getDb } from "@/lib/db";
import { getSettingValue } from "@/lib/settings";
import { updateMetrics } from "@/lib/convergent";
import { verifyCronAuth } from "@/lib/qstash";
import { setSentryTags } from "@/lib/sentry-tags";

// Vercel Cron: runs at 8am and 6pm (configure in vercel.json)
// Collects page_views from each company's /api/stats endpoint
// Also checks latest post-deploy smoke test results via GitHub API
// Each company app tracks its own pageviews via middleware → page_views table

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  setSentryTags({
    action_type: "cron",
    route: "/api/cron/metrics",
  });

  const auth = await verifyCronAuth(req);
  if (!auth.authorized) {
    return Response.json({ error: auth.error }, { status: 401 });
  }

  const sql = getDb();
  const today = new Date().toISOString().split("T")[0];
  const ghToken = await getSettingValue("github_token").catch(() => null);

  // Get all active/mvp companies with their URLs
  const companies = await sql`
    SELECT c.id, c.slug, COALESCE(c.domain, c.vercel_url) as app_url
    FROM companies c
    WHERE c.status IN ('active', 'mvp')
  `;

  const results: Array<{ slug: string; views: number; pricing_clicks: number; affiliate_clicks: number; smoke_test_pass: boolean | null; source: string }> = [];

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
        } catch (fetchErr: any) {
          // Company app may not have /api/stats yet — log for debugging
          console.warn(`${company.slug}: /api/stats failed: ${fetchErr.message || "unknown"}`);
          source = "fallback_zeroes";
        }
      }

      // Only write to DB when we got real data from the company API
      if (source !== "company_api") {
        console.warn(`[metrics] ${company.slug}: skipping DB write (source: ${source})`);
        results.push({ slug: company.slug, views: 0, pricing_clicks: 0, affiliate_clicks: 0, smoke_test_pass: null, source });
        continue;
      }

      // Use convergent metrics update to handle concurrent writes
      await updateMetrics({
        company_id: company.id,
        date: today,
        page_views: views,
        pricing_cta_clicks: pricingClicks,
        affiliate_clicks: affiliateClicks
      });

      // Check latest smoke test result via GitHub API
      let smokeTestPass: boolean | null = null;
      if (company.slug && ghToken) {
        try {
          const ghRes = await fetch(
            `https://api.github.com/repos/carloshmiranda/${company.slug}/actions/workflows/post-deploy.yml/runs?per_page=1&status=completed`,
            {
              headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github+json" },
              signal: AbortSignal.timeout(5000),
            }
          );
          if (ghRes.ok) {
            const ghData = await ghRes.json();
            if (ghData.workflow_runs?.length > 0) {
              const latestRun = ghData.workflow_runs[0];
              smokeTestPass = latestRun.conclusion === "success";
            }
          }
        } catch {
          // GitHub API not available or workflow doesn't exist — skip
        }
      }

      results.push({ slug: company.slug, views, pricing_clicks: pricingClicks, affiliate_clicks: affiliateClicks, smoke_test_pass: smokeTestPass, source });
    } catch (e) {
      console.error(`Failed to collect metrics for ${company.slug}:`, e);
    }
  }

  return Response.json({ ok: true, collected: results.length, results });
}

// QStash sends POST — re-export GET handler for dual-mode auth
export { GET as POST };
