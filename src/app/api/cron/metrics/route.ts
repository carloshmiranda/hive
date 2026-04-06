import { getDb } from "@/lib/db";
import { getSettingValue } from "@/lib/settings";
import { updateMetrics } from "@/lib/convergent";
import { verifyCronAuth } from "@/lib/qstash";
import { setSentryTags } from "@/lib/sentry-tags";

// Vercel Cron: runs at 8am and 6pm (configure in vercel.json)
// Collects page_views from each company's /api/stats endpoint
// Also checks latest post-deploy smoke test results via GitHub API
// Each company app tracks its own pageviews via middleware → page_views table
// Supports company_slug query/body param for targeted single-company refresh (e.g. post-merge)

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function collectMetrics(req: Request, companySlugs?: string[]) {
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

  // Get active/mvp companies — optionally filtered to specific slugs
  const companies = companySlugs?.length
    ? await sql`
        SELECT c.id, c.slug, COALESCE(c.domain, c.vercel_url) as app_url
        FROM companies c
        WHERE c.status IN ('active', 'mvp')
        AND c.slug = ANY(${companySlugs})
      `
    : await sql`
        SELECT c.id, c.slug, COALESCE(c.domain, c.vercel_url) as app_url
        FROM companies c
        WHERE c.status IN ('active', 'mvp')
      `;

  type MetricResult = { slug: string; views: number; pricing_clicks: number; affiliate_clicks: number; smoke_test_pass: boolean | null; source: string };

  // Process all companies in parallel — each is independent
  const settled = await Promise.all(companies.map(async (company): Promise<MetricResult | null> => {
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
              // Standard boilerplate format: { ok, views, pricing_clicks, affiliate_clicks }
              if (typeof data.views === "number") {
                views = data.views;
                pricingClicks = typeof data.pricing_clicks === "number" ? data.pricing_clicks : 0;
                affiliateClicks = typeof data.affiliate_clicks === "number" ? data.affiliate_clicks : 0;
                source = "company_api";
              }
              // Legacy format: { ok, data: { page_views, ... } }
              else if (data.data && typeof data.data.page_views === "number") {
                views = data.data.page_views;
                pricingClicks = 0;
                affiliateClicks = 0;
                source = "company_api";
              }
              // Extended stats format with no top-level views (e.g. Senhorio old format)
              // Still counts as success so we write 0 instead of skipping
              else {
                source = "company_api";
              }
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
        return { slug: company.slug, views: 0, pricing_clicks: 0, affiliate_clicks: 0, smoke_test_pass: null, source };
      }

      // Parallelize: DB write + GitHub smoke test check are independent
      const [, smokeTestResult] = await Promise.all([
        updateMetrics({
          company_id: company.id,
          date: today,
          page_views: views,
          pricing_cta_clicks: pricingClicks,
          affiliate_clicks: affiliateClicks,
        }),
        // Check latest smoke test result via GitHub API
        (async (): Promise<boolean | null> => {
          if (!company.slug || !ghToken) return null;
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
                return ghData.workflow_runs[0].conclusion === "success";
              }
            }
          } catch {
            // GitHub API not available or workflow doesn't exist — skip
          }
          return null;
        })(),
      ]);

      // After successful metrics write, trigger dispatch/work (fire-and-forget)
      // Metrics changes may affect company priority scores — let dispatcher re-evaluate
      const HIVE_URL = process.env.NEXT_PUBLIC_URL || "https://hive-phi.vercel.app";
      fetch(`${HIVE_URL}/api/dispatch/work`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.CRON_SECRET}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ company_slug: company.slug }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});

      return { slug: company.slug, views, pricing_clicks: pricingClicks, affiliate_clicks: affiliateClicks, smoke_test_pass: smokeTestResult, source };
    } catch (e) {
      console.error(`Failed to collect metrics for ${company.slug}:`, e);
      return null;
    }
  }));

  const results = settled.filter((r): r is MetricResult => r !== null);
  return Response.json({ ok: true, collected: results.length, results });
}

export async function GET(req: Request) {
  // Support ?company_slug=X for targeted refresh
  const { searchParams } = new URL(req.url);
  const slug = searchParams.get("company_slug");
  return collectMetrics(req, slug ? [slug] : undefined);
}

export async function POST(req: Request) {
  // QStash sends POST with optional JSON body { company_slug: "X" }
  let slug: string | undefined;
  try {
    const body = await req.json().catch(() => ({}));
    slug = body?.company_slug || undefined;
  } catch {
    // no body — full refresh
  }
  return collectMetrics(req, slug ? [slug] : undefined);
}
