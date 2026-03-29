import { NextRequest } from "next/server";
import { getDb, json, err } from "@/lib/db";
import { pushFiles } from "@/lib/github";
import { getSettingValue } from "@/lib/settings";
import { getGitHubToken } from "@/lib/github-app";

/**
 * POST /api/agents/migrate-stats — deploy /api/stats endpoint and middleware to existing company repos.
 *
 * This fixes the "zero metrics across all companies" issue by pushing the correct
 * API endpoints and pageview tracking middleware from the boilerplate.
 * Callable by Sentinel via CRON_SECRET auth.
 */
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return err("Unauthorized", 401);
  }

  try {
    const body = await req.json();
    const { company_slug } = body;
    if (!company_slug) return err("company_slug required", 400);

    const sql = getDb();
    const [company] = await sql`
      SELECT id, slug, github_repo, neon_project_id, vercel_project_id
      FROM companies WHERE slug = ${company_slug} AND status IN ('mvp', 'active')
    `;
    if (!company) return err(`Company ${company_slug} not found or not active`, 404);
    if (!company.github_repo) return err(`Company ${company_slug} has no GitHub repo`, 400);

    const [owner, repo] = company.github_repo.split('/');
    const githubOwner = await getSettingValue("github_owner");
    if (!githubOwner) throw new Error("GitHub owner not configured");

    const results: Record<string, unknown> = { company_slug };

    // Files to deploy from the boilerplate
    const filesToDeploy = [
      // API stats endpoint
      {
        path: "src/app/api/stats/route.ts",
        content: `import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET /api/stats — returns today's pageview, pricing click, and affiliate click counts
// Called by Hive's metrics cron to collect validation metrics across companies
export async function GET() {
  const sql = getDb();
  const today = new Date().toISOString().split("T")[0];

  const [[views], [pricing], [affiliate]] = await Promise.all([
    sql\`SELECT COALESCE(SUM(views), 0) as total FROM page_views WHERE date = \${today}\`,
    sql\`SELECT COUNT(*)::int as total FROM pricing_clicks WHERE date = \${today}\`.catch(() => [{ total: 0 }]),
    sql\`SELECT COUNT(*)::int as total FROM affiliate_clicks WHERE date = \${today}\`.catch(() => [{ total: 0 }]),
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
  const sql = getDb();

  await sql\`
    INSERT INTO page_views (date, path, views)
    VALUES (CURRENT_DATE, \${path}, 1)
    ON CONFLICT (date, path) DO UPDATE SET views = page_views.views + 1
  \`;

  return Response.json({ ok: true });
}
`
      },
      // Pricing intent tracking endpoint
      {
        path: "src/app/api/pricing-intent/route.ts",
        content: `import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

// POST /api/pricing-intent — track fake-door pricing CTA clicks
export async function POST(req: Request) {
  const { tier, source_path = "/pricing" } = await req.json().catch(() => ({}));
  if (!tier) {
    return Response.json({ ok: false, error: "tier required" }, { status: 400 });
  }

  const sql = getDb();
  await sql\`
    INSERT INTO pricing_clicks (tier, source_path)
    VALUES (\${tier}, \${source_path})
  \`;

  return Response.json({ ok: true });
}
`
      },
      // Affiliate click tracking endpoint
      {
        path: "src/app/api/affiliate-click/route.ts",
        content: `import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

// POST /api/affiliate-click — track outbound affiliate link clicks
export async function POST(req: Request) {
  const { link_id, destination_url, source_path = "/" } = await req.json().catch(() => ({}));
  if (!link_id) {
    return Response.json({ ok: false, error: "link_id required" }, { status: 400 });
  }

  const sql = getDb();
  await sql\`
    INSERT INTO affiliate_clicks (link_id, destination_url, source_path)
    VALUES (\${link_id}, \${destination_url}, \${source_path})
  \`;

  return Response.json({ ok: true });
}
`
      },
      // Pageview tracking middleware
      {
        path: "src/middleware.ts",
        content: `import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const response = NextResponse.next();

  // Track pageviews (fire-and-forget)
  if (request.method === "GET" && !request.nextUrl.pathname.startsWith("/api/") && !request.nextUrl.pathname.startsWith("/_next/")) {
    // Async pageview tracking - don't await to avoid blocking the response
    fetch(\`\${request.nextUrl.origin}/api/stats\`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: request.nextUrl.pathname })
    }).catch(() => {
      // Silent fail - pageview tracking is non-critical
    });
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api (API routes)
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    '/((?!api|_next/static|_next/image|favicon.ico).*)',
  ],
};
`
      }
    ];

    // Push files to the company repo
    try {
      const commit = await pushFiles(githubOwner, repo, filesToDeploy,
        `feat: add stats tracking endpoints and middleware\n\nDeployed by Hive stats migration to fix zero metrics issue.`);

      results.github_deploy = {
        success: true,
        commit_sha: commit.sha,
        files_deployed: filesToDeploy.length
      };
    } catch (e: any) {
      results.github_deploy = {
        error: e.message,
        files_attempted: filesToDeploy.length
      };
    }

    // Log the migration action
    await sql`
      INSERT INTO agent_actions (company_id, agent, action_type, description, status, output, started_at, finished_at)
      VALUES (
        ${company.id}, 'sentinel', 'stats_migration',
        ${`Stats endpoints migration for ${company_slug}`},
        'success', ${JSON.stringify(results)}::jsonb,
        NOW(), NOW()
      )
    `;

    return json({ ok: true, results });

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("migrate-stats crashed:", msg);
    return err(`Internal error: ${msg}`, 500);
  }
}