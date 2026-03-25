import { NextRequest } from "next/server";
import { getDb, json, err } from "@/lib/db";

/**
 * POST /api/agents/fix-validation-system — comprehensive fix for the validation-gated build system.
 *
 * This implements the three-part fix:
 * 1. Provision Neon databases for all 4 companies
 * 2. Deploy /api/stats endpoint to company repos via boilerplate migration
 * 3. Verify metrics cron can reach company /api/stats endpoints
 *
 * Callable by Engineer agent or Sentinel via CRON_SECRET auth.
 */
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return err("Unauthorized", 401);
  }

  try {
    const sql = getDb();

    // Get all active companies that need fixing
    const companies = await sql`
      SELECT id, slug, github_repo, neon_project_id, vercel_project_id, vercel_url
      FROM companies
      WHERE status IN ('mvp', 'active')
      AND github_repo IS NOT NULL
      ORDER BY name
    `;

    if (companies.length === 0) {
      return json({ ok: true, message: "No active companies found that need fixing" });
    }

    const results: Record<string, unknown> = {
      companies_processed: companies.length,
      companies: []
    };

    // Process each company
    for (const company of companies) {
      const companyResult: Record<string, unknown> = {
        slug: company.slug,
        fixes_applied: []
      };

      // Step 1: Fix Neon database if missing
      if (!company.neon_project_id) {
        try {
          const repairRes = await fetch(`${process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000'}/api/agents/repair-infra`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${cronSecret}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ company_slug: company.slug }),
            signal: AbortSignal.timeout(60000),
          });

          if (repairRes.ok) {
            const repairData = await repairRes.json();
            companyResult.neon_repair = repairData.data?.repairs;
            (companyResult.fixes_applied as string[]).push("neon_database");
          } else {
            companyResult.neon_repair = { error: `HTTP ${repairRes.status}` };
          }
        } catch (e: any) {
          companyResult.neon_repair = { error: e.message };
        }
      } else {
        companyResult.neon_repair = { skipped: true, reason: "neon_project_id already exists" };
      }

      // Step 2: Deploy stats endpoints
      try {
        const migrateRes = await fetch(`${process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000'}/api/agents/migrate-stats`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${cronSecret}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ company_slug: company.slug }),
          signal: AbortSignal.timeout(60000),
        });

        if (migrateRes.ok) {
          const migrateData = await migrateRes.json();
          companyResult.stats_migration = migrateData.data?.results;
          (companyResult.fixes_applied as string[]).push("stats_endpoints");
        } else {
          companyResult.stats_migration = { error: `HTTP ${migrateRes.status}` };
        }
      } catch (e: any) {
        companyResult.stats_migration = { error: e.message };
      }

      // Step 3: Verify /api/stats endpoint is working (wait a moment for deploy)
      if (company.vercel_url) {
        try {
          // Wait 10 seconds for potential deploy to complete
          await new Promise(resolve => setTimeout(resolve, 10000));

          const statsRes = await fetch(`${company.vercel_url}/api/stats`, {
            method: "GET",
            headers: { "User-Agent": "Hive-Metrics-Verification/1.0" },
            signal: AbortSignal.timeout(10000),
          });

          if (statsRes.ok) {
            const statsData = await statsRes.json();
            if (statsData.ok && typeof statsData.views === 'number') {
              companyResult.stats_verification = {
                success: true,
                response: statsData,
                endpoint_url: `${company.vercel_url}/api/stats`
              };
              (companyResult.fixes_applied as string[]).push("stats_verification");
            } else {
              companyResult.stats_verification = {
                error: "Invalid response format",
                response: statsData,
                endpoint_url: `${company.vercel_url}/api/stats`
              };
            }
          } else {
            companyResult.stats_verification = {
              error: `HTTP ${statsRes.status}`,
              endpoint_url: `${company.vercel_url}/api/stats`
            };
          }
        } catch (e: any) {
          companyResult.stats_verification = {
            error: e.message,
            endpoint_url: `${company.vercel_url}/api/stats`
          };
        }
      } else {
        companyResult.stats_verification = { skipped: true, reason: "no vercel_url" };
      }

      (results.companies as Record<string, unknown>[]).push(companyResult);
    }

    // Log the comprehensive fix action
    await sql`
      INSERT INTO agent_actions (company_id, agent, action_type, description, status, output, started_at, finished_at)
      VALUES (
        NULL, 'engineer', 'fix_validation_system',
        'Three-part validation system fix: Neon databases + stats endpoints + verification',
        'success', ${JSON.stringify(results)}::jsonb,
        NOW(), NOW()
      )
    `;

    return json({ ok: true, results });

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("fix-validation-system crashed:", msg);
    return err(`Internal error: ${msg}`, 500);
  }
}