import { NextRequest } from "next/server";
import { getDb, json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { getSettingValue } from "@/lib/settings";
import { isCapabilityRelevant } from "@/lib/business-types";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // Allow both session auth (dashboard) and cron secret (Sentinel auto-assess)
  const authHeader = req.headers.get("authorization");
  const isCron = authHeader === `Bearer ${process.env.CRON_SECRET}`;
  if (!isCron) {
    const session = await requireAuth();
    if (!session) return err("Unauthorized", 401);
  }

  const { id } = await params;
  const sql = getDb();

  const [company] = await sql`SELECT * FROM companies WHERE id = ${id} OR slug = ${id}`;
  if (!company) return err("Company not found", 404);

  const capabilities = company.capabilities || {};
  const updates: Record<string, unknown> = {};
  const issues: string[] = [];

  // 1. Check database — inspect which tables exist in the company's Neon project
  if (company.neon_project_id) {
    const [dbInfra] = await sql`
      SELECT config FROM infra
      WHERE company_id = ${company.id} AND service = 'neon' AND status = 'active'
    `;
    if (dbInfra?.config?.connection_string) {
      try {
        const { neon } = await import("@neondatabase/serverless");
        const companyDb = neon(dbInfra.config.connection_string);

        const tables = await companyDb`
          SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public'
        `;
        const tableNames = tables.map((t: any) => t.table_name as string);

        updates.database = { exists: true, provider: "neon", connection_verified: true };
        updates.email_sequences = { exists: tableNames.includes("email_sequences"), count: 0 };
        updates.email_log = { exists: tableNames.includes("email_log") };
        updates.waitlist = {
          exists: tableNames.includes("waitlist"),
          has_entries: false,
          total: 0,
          makes_sense: capabilities.waitlist?.makes_sense ?? true,
        };
        updates.visibility_metrics = { exists: tableNames.includes("visibility_metrics") };

        if (tableNames.includes("waitlist")) {
          const [wlCount] = await companyDb`SELECT COUNT(*) as total FROM waitlist`;
          (updates.waitlist as Record<string, unknown>).total = Number(wlCount.total);
          (updates.waitlist as Record<string, unknown>).has_entries = Number(wlCount.total) > 0;
        }

        if (tableNames.includes("email_sequences")) {
          const [seqCount] = await companyDb`SELECT COUNT(*) as total FROM email_sequences`;
          (updates.email_sequences as Record<string, unknown>).count = Number(seqCount.total);
        }

        if (tableNames.includes("customers")) {
          const [custCount] = await companyDb`SELECT COUNT(*) as total FROM customers`;
          updates.stripe = {
            ...(capabilities.stripe || {}),
            exists: true,
            has_customers: Number(custCount.total) > 0,
          };
        }
      } catch (e: any) {
        updates.database = { exists: true, provider: "neon", connection_verified: false };
        issues.push(`Database connection failed: ${e.message}`);
      }
    }
  } else {
    updates.database = {
      exists: capabilities.database?.exists || false,
      provider: capabilities.database?.provider || null,
      connection_verified: false,
    };
  }

  // 2. Check Vercel env vars if available
  const vercelToken = await getSettingValue("vercel_token").catch(() => null) || process.env.VERCEL_TOKEN;
  const vercelTeamId = await getSettingValue("vercel_team_id").catch(() => null) || process.env.VERCEL_TEAM_ID;
  if (company.vercel_project_id && vercelToken) {
    try {
      const teamParam = vercelTeamId ? `&teamId=${vercelTeamId}` : "";
      const envRes = await fetch(
        `https://api.vercel.com/v9/projects/${company.vercel_project_id}/env?${teamParam}`,
        { headers: { Authorization: `Bearer ${vercelToken}` } }
      );
      if (envRes.ok) {
        const envData = await envRes.json();
        const envKeys = envData.envs?.map((e: { key: string }) => e.key) || [];

        updates.stripe = {
          ...(updates.stripe || capabilities.stripe || {}),
          configured: envKeys.includes("STRIPE_SECRET_KEY"),
        };
        updates.email_provider = {
          exists: envKeys.includes("RESEND_API_KEY") || envKeys.includes("SENDGRID_API_KEY") || envKeys.includes("POSTMARK_API_KEY"),
          provider: envKeys.includes("RESEND_API_KEY") ? "resend" :
                   envKeys.includes("SENDGRID_API_KEY") ? "sendgrid" :
                   envKeys.includes("POSTMARK_API_KEY") ? "postmark" : null,
          configured: envKeys.includes("RESEND_API_KEY") || envKeys.includes("SENDGRID_API_KEY"),
        };
        updates.gsc_integration = {
          exists: envKeys.includes("GSC_CREDENTIALS"),
          configured: envKeys.includes("GSC_CREDENTIALS"),
        };
        updates.indexnow = {
          exists: envKeys.includes("INDEXNOW_KEY"),
          configured: envKeys.includes("INDEXNOW_KEY"),
        };

        const launchModeEnv = envData.envs?.find((e: { key: string }) => e.key === "LAUNCH_MODE" || e.key === "NEXT_PUBLIC_LAUNCH_MODE");
        if (launchModeEnv) {
          updates.launch_mode = { value: launchModeEnv.value || "unknown" };
        }
      }
    } catch {
      issues.push("Could not check Vercel environment variables");
    }
  }

  // 3. Check repo for key files
  const { getGitHubToken } = await import("@/lib/github-app");
  const ghPat = await getGitHubToken().catch(() => null) || process.env.GH_PAT;
  if (company.github_repo && ghPat) {
    try {
      const repoPath = company.github_repo;
      const headers = { Authorization: `Bearer ${ghPat}`, Accept: "application/vnd.github.v3+json" };

      const fileChecks = [
        { path: "src/app/api/webhooks/resend/route.ts", key: "resend_webhook" },
        { path: "public/llms.txt", key: "llms_txt" },
        { path: "src/app/sitemap.ts", key: "sitemap" },
        { path: "package.json", key: "framework" },
        // QA & monitoring
        { path: "src/app/api/health/route.ts", key: "health_endpoint" },
        { path: "playwright.config.ts", key: "smoke_tests" },
        { path: ".github/workflows/post-deploy.yml", key: "post_deploy" },
        // Data collection
        { path: "src/app/api/stats/route.ts", key: "stats_endpoint" },
        { path: "src/app/api/pricing-intent/route.ts", key: "pricing_intent" },
        { path: "src/app/api/affiliate-click/route.ts", key: "affiliate_tracking" },
      ];

      for (const check of fileChecks) {
        try {
          const fileRes = await fetch(
            `https://api.github.com/repos/${repoPath}/contents/${check.path}`,
            { headers }
          );
          if (check.key === "framework" && fileRes.ok) {
            const content = await fileRes.json();
            const decoded = atob(content.content);
            const framework = decoded.includes('"next"') ? "nextjs" :
                            decoded.includes('"@remix-run') ? "remix" :
                            decoded.includes('"astro"') ? "astro" : "other";
            updates.repo = {
              exists: true,
              provider: "github",
              url: `https://github.com/${repoPath}`,
              framework,
            };
          } else if (check.key !== "framework") {
            // Generic file-existence check for all other keys
            updates[check.key] = { exists: fileRes.ok };
          }
        } catch { /* individual file check — non-blocking */ }
      }

      // Check for JSON-LD
      try {
        const layoutRes = await fetch(
          `https://api.github.com/repos/${repoPath}/contents/src/app/layout.tsx`,
          { headers }
        );
        if (layoutRes.ok) {
          const content = await layoutRes.json();
          const decoded = atob(content.content);
          updates.json_ld = { exists: decoded.includes("application/ld+json") };
          updates.analytics = { exists: decoded.includes("@vercel/analytics") };
        }
      } catch { /* non-blocking */ }
    } catch {
      issues.push("Could not inspect repository");
    }
  }

  // 4. Apply compatibility matrix
  updates.waitlist = applyCompatibility("waitlist", updates.waitlist || capabilities.waitlist, company, updates);
  updates.referral_mechanics = applyCompatibility("referral", updates.referral_mechanics || capabilities.referral_mechanics, company, updates);

  // 5. Set hosting from existing company data
  if (company.vercel_url || company.vercel_project_id) {
    updates.hosting = {
      exists: true,
      provider: "vercel",
      url: company.vercel_url || null,
    };
  }

  const merged = { ...capabilities, ...updates };

  await sql`
    UPDATE companies
    SET capabilities = ${JSON.stringify(merged)}::jsonb,
        last_assessed_at = NOW()
    WHERE id = ${company.id}
  `;

  return json({
    ok: true,
    capabilities: merged,
    issues: issues.length > 0 ? issues : undefined,
    assessed_at: new Date().toISOString(),
  });
}

function applyCompatibility(
  capability: string,
  current: Record<string, unknown> | undefined,
  company: Record<string, unknown>,
  assessed: Record<string, unknown>
): Record<string, unknown> {
  const base = (current || { exists: false }) as Record<string, unknown>;
  const stripeData = (assessed.stripe || {}) as Record<string, unknown>;
  const hasCustomers = stripeData.has_customers === true;
  const companyType = company.company_type as string;

  // Use centralized type definitions to check relevance
  const relevant = isCapabilityRelevant(capability, companyType);
  if (!relevant) {
    return { ...base, makes_sense: false, reason: `Not applicable for ${companyType}` };
  }

  // Business-logic overrides that depend on runtime data
  if (capability === "waitlist" && hasCustomers) {
    return { ...base, makes_sense: false, reason: "Company already has paying customers" };
  }

  return { ...base, makes_sense: true };
}
