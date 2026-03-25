import { getDb } from "@/lib/db";
import { getSettingValue } from "@/lib/settings";
import { normalizeError, errorSimilarity } from "@/lib/error-normalize";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Extracted from Sentinel: HTTP-heavy company health checks that were causing timeouts.
// Sentinel fires this as non-blocking fetch. Each check logs results to agent_actions.
// Checks: 31 (stats endpoints), 32 (language), 33 (stale records), 36 (tests), 38 (PR merge), 30 (broken deploys)

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sql = getDb();
  const ghPat = await getSettingValue("github_token");
  const vercelToken = await getSettingValue("vercel_token");
  const cronSecret = process.env.CRON_SECRET;
  const baseUrl = process.env.NEXT_PUBLIC_URL || "https://hive-phi.vercel.app";

  const results: Record<string, unknown> = {};

  // --- Check 31: Stats endpoint health ---
  try {
    let statsEndpointsBroken = 0;
    const statsCompanies = await sql`
      SELECT c.id, c.slug, COALESCE('https://' || c.domain, c.vercel_url) as app_url, c.github_repo
      FROM companies c
      WHERE c.status IN ('mvp', 'active') AND c.vercel_url IS NOT NULL
    `;
    for (const sc of statsCompanies) {
      if (!sc.app_url) continue;
      const statsUrl = `${sc.app_url}/api/stats`;
      try {
        const res = await fetch(statsUrl, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!data.ok || typeof data.views !== "number") {
          throw new Error("Invalid response format: missing ok/views fields");
        }
      } catch (e: any) {
        statsEndpointsBroken++;
        const [existingTask] = await sql`
          SELECT id FROM company_tasks
          WHERE company_id = ${sc.id} AND title LIKE '%stats endpoint%'
          AND status IN ('proposed', 'in_progress')
          LIMIT 1
        `;
        if (!existingTask) {
          await sql`
            INSERT INTO company_tasks (company_id, title, description, category, priority, status)
            VALUES (
              ${sc.id},
              'Fix /api/stats endpoint for metrics collection',
              ${`The /api/stats endpoint at ${statsUrl} is broken (${e.message}). This endpoint must return JSON: { ok: true, views: number, pricing_clicks: number, affiliate_clicks: number }. Copy the boilerplate from templates/boilerplate/src/app/api/stats/route.ts. Ensure the page_views, pricing_clicks, and affiliate_clicks tables exist in the company DB. Also ensure middleware.ts tracks pageviews by POSTing to /api/stats on each page navigation.`},
              'engineering', 2, 'proposed'
            )
          `;
        }
      }
    }
    results.stats_endpoints_broken = statsEndpointsBroken;
  } catch (e: any) {
    console.warn("[company-health] Check 31 failed:", e.message);
  }

  // --- Check 32: Language consistency ---
  try {
    let languageMismatches = 0;
    const langCompanies = await sql`
      SELECT c.id, c.slug, c.content_language, COALESCE('https://' || c.domain, c.vercel_url) as app_url
      FROM companies c
      WHERE c.status IN ('mvp', 'active') AND c.vercel_url IS NOT NULL AND c.content_language IS NOT NULL
    `;
    for (const lc of langCompanies) {
      if (!lc.app_url) continue;
      try {
        const res = await fetch(lc.app_url as string, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) continue;
        const html = await res.text();
        const htmlLang = html.match(/<html[^>]*lang="([^"]+)"/)?.[1] || "";
        const expectedLang = lc.content_language as string;
        const langMismatch = htmlLang && !htmlLang.startsWith(expectedLang);
        const isExpectedPt = expectedLang === "pt";
        const hasEnglishPatterns = /\b(Get started|Learn more|Sign up|Features|How it works|Ready to get started)\b/i.test(html);
        const hasPortuguesePatterns = /\b(Começar|Saber mais|Funcionalidades|Como funciona|Pronto para começar)\b/i.test(html);
        const contentMismatch = isExpectedPt ? hasEnglishPatterns && !hasPortuguesePatterns : hasPortuguesePatterns && !hasEnglishPatterns;

        if (langMismatch || contentMismatch) {
          languageMismatches++;
          const issue = langMismatch ? `html lang="${htmlLang}" but expected "${expectedLang}"` : `content appears to be in wrong language (expected ${expectedLang})`;
          const [existingTask] = await sql`
            SELECT id FROM company_tasks
            WHERE company_id = ${lc.id} AND title LIKE '%language%consistency%'
            AND status IN ('proposed', 'in_progress')
            LIMIT 1
          `;
          if (!existingTask) {
            await sql`
              INSERT INTO company_tasks (company_id, title, description, category, priority, status)
              VALUES (${lc.id}, 'Fix language consistency — wrong content language detected',
                ${`The deployed site at ${lc.app_url} has a language issue: ${issue}. All user-facing content must be in ${isExpectedPt ? "Portuguese" : "English"}. Check: html lang attribute, page text, meta tags, button labels, headings, error messages.`},
                'engineering', 2, 'proposed')
            `;
          }
        }
      } catch {
        // Site may be down — other checks handle this
      }
    }
    results.language_mismatches = languageMismatches;
  } catch (e: any) {
    console.warn("[company-health] Check 32 failed:", e.message);
  }

  // --- Check 33: Stale record reconciliation ---
  try {
    let staleRecordsFixed = 0;
    if (vercelToken) {
      const teamId = await getSettingValue("vercel_team_id").catch(() => null);
      const teamParam = teamId ? `?teamId=${teamId}` : "";
      const reconCompanies = await sql`
        SELECT id, slug, vercel_project_id, vercel_url, github_repo
        FROM companies WHERE status IN ('mvp', 'active') AND vercel_project_id IS NOT NULL
      `;
      for (const rc of reconCompanies) {
        try {
          const vRes = await fetch(`https://api.vercel.com/v9/projects/${rc.vercel_project_id}${teamParam}`, {
            headers: { Authorization: `Bearer ${vercelToken}` },
            signal: AbortSignal.timeout(5000),
          });
          if (vRes.ok) {
            const vProject = await vRes.json();
            const actualName = vProject.name;
            const actualAlias = (vProject.alias || []).find((a: string) => a.endsWith(".vercel.app"));
            const actualUrl = actualAlias ? `https://${actualAlias}` : `https://${actualName}.vercel.app`;
            const storedUrl = rc.vercel_url as string;

            if (storedUrl && actualUrl !== storedUrl && !storedUrl.includes(actualName)) {
              await sql`UPDATE companies SET vercel_url = ${actualUrl}, updated_at = NOW() WHERE id = ${rc.id}`;
              staleRecordsFixed++;
              await sql`
                INSERT INTO agent_actions (agent, action_type, status, company_id, output)
                VALUES ('sentinel', 'stale_record_fix', 'success', ${rc.id},
                  ${JSON.stringify({ field: "vercel_url", old: storedUrl, new: actualUrl })}::jsonb)
              `;
            }
          }

          if (rc.github_repo && ghPat) {
            const ghRes = await fetch(`https://api.github.com/repos/${rc.github_repo}`, {
              headers: { Authorization: `Bearer ${ghPat}`, Accept: "application/vnd.github+json" },
              signal: AbortSignal.timeout(5000),
            });
            if (ghRes.status === 301 || ghRes.status === 404) {
              const findRes = await fetch(`https://api.github.com/repos/carloshmiranda/${rc.slug}`, {
                headers: { Authorization: `Bearer ${ghPat}`, Accept: "application/vnd.github+json" },
                signal: AbortSignal.timeout(5000),
              });
              if (findRes.ok) {
                const repoData = await findRes.json();
                const actualRepo = repoData.full_name;
                if (actualRepo !== rc.github_repo) {
                  await sql`UPDATE companies SET github_repo = ${actualRepo}, updated_at = NOW() WHERE id = ${rc.id}`;
                  await sql`UPDATE infra SET resource_id = ${actualRepo} WHERE resource_id = ${rc.github_repo} AND service = 'github'`;
                  staleRecordsFixed++;
                  await sql`
                    INSERT INTO agent_actions (agent, action_type, status, company_id, output)
                    VALUES ('sentinel', 'stale_record_fix', 'success', ${rc.id},
                      ${JSON.stringify({ field: "github_repo", old: rc.github_repo, new: actualRepo })}::jsonb)
                  `;
                }
              }
            }
          }
        } catch {
          // API errors — skip this company, will retry next run
        }
      }
    }
    results.stale_records_fixed = staleRecordsFixed;
  } catch (e: any) {
    console.warn("[company-health] Check 33 failed:", e.message);
  }

  // --- Check 36: Test coverage health ---
  try {
    let testCoverageIssues = 0;
    const testCompanies = await sql`
      SELECT c.id, c.slug, c.github_repo, c.capabilities,
        COALESCE((SELECT COUNT(*) FROM cycles cy WHERE cy.company_id = c.id AND cy.status = 'completed'), 0)::int as total_cycles
      FROM companies c
      WHERE c.status IN ('mvp', 'active') AND c.github_repo IS NOT NULL
    `;

    for (const tc of testCompanies) {
      const repo = tc.github_repo as string;
      const companyId = tc.id as string;
      const slug = tc.slug as string;
      const totalCycles = tc.total_cycles as number;

      let hasTestDir = false;
      let hasPlaywrightConfig = false;
      let hasTestFiles = false;
      let latestTestRun: { conclusion: string | null } | null = null;

      try {
        const testsRes = await fetch(`https://api.github.com/repos/${repo}/contents/tests`, {
          headers: { Authorization: `token ${ghPat}`, Accept: "application/vnd.github.v3+json" },
          signal: AbortSignal.timeout(5000),
        });
        if (testsRes.ok) { hasTestDir = true; hasTestFiles = true; }
      } catch { /* non-blocking */ }

      try {
        const playwrightRes = await fetch(`https://api.github.com/repos/${repo}/contents/playwright.config.ts`, {
          headers: { Authorization: `token ${ghPat}`, Accept: "application/vnd.github.v3+json" },
          signal: AbortSignal.timeout(5000),
        });
        if (playwrightRes.ok) { hasPlaywrightConfig = true; hasTestFiles = true; }
      } catch { /* non-blocking */ }

      if (!hasTestFiles) {
        try {
          const srcTestsRes = await fetch(`https://api.github.com/repos/${repo}/contents/src/__tests__`, {
            headers: { Authorization: `token ${ghPat}`, Accept: "application/vnd.github.v3+json" },
            signal: AbortSignal.timeout(5000),
          });
          if (srcTestsRes.ok) { hasTestFiles = true; }
        } catch { /* non-blocking */ }
      }

      if (hasTestFiles) {
        try {
          const runsRes = await fetch(
            `https://api.github.com/repos/${repo}/actions/workflows/post-deploy.yml/runs?per_page=1&status=completed`,
            {
              headers: { Authorization: `token ${ghPat}`, Accept: "application/vnd.github.v3+json" },
              signal: AbortSignal.timeout(5000),
            }
          );
          if (runsRes.ok) {
            const runsData = await runsRes.json();
            const latestRun = runsData.workflow_runs?.[0];
            if (latestRun) { latestTestRun = { conclusion: latestRun.conclusion }; }
          }
        } catch { /* non-blocking */ }
      }

      const testCapabilities = {
        smoke: hasPlaywrightConfig || hasTestDir,
        unit: false,
        e2e: hasPlaywrightConfig,
      };
      try {
        await sql`
          UPDATE companies SET
            capabilities = jsonb_set(COALESCE(capabilities, '{}'), '{tests}', ${JSON.stringify(testCapabilities)}::jsonb),
            updated_at = NOW()
          WHERE id = ${companyId}
        `;
      } catch { /* non-blocking */ }

      if (!hasTestFiles && totalCycles >= 3) {
        const taskTitle = `Add smoke tests for ${slug}`;
        const [existingTask] = await sql`
          SELECT id FROM company_tasks
          WHERE company_id = ${companyId} AND title = ${taskTitle}
          AND status NOT IN ('done', 'dismissed')
          LIMIT 1
        `;
        if (!existingTask) {
          await sql`
            INSERT INTO company_tasks (company_id, title, description, category, priority, status, source)
            VALUES (
              ${companyId}, ${taskTitle},
              ${"This company has no test files (no tests/ directory, no playwright.config.ts, no src/__tests__/). Add Playwright smoke tests that verify: 1) Homepage loads with 200 status, 2) Key pages return 200, 3) API routes respond correctly. Use the boilerplate pattern from templates/boilerplate/ as reference. Install @playwright/test as devDependency and add a post-deploy.yml workflow."},
              'qa', 2, 'proposed', 'sentinel'
            )
          `;
          testCoverageIssues++;
        }
      } else if (hasTestFiles && latestTestRun && latestTestRun.conclusion !== "success") {
        const taskTitle = `Fix failing tests for ${slug}`;
        const [existingTask] = await sql`
          SELECT id FROM company_tasks
          WHERE company_id = ${companyId} AND title = ${taskTitle}
          AND status NOT IN ('done', 'dismissed')
          LIMIT 1
        `;
        if (!existingTask) {
          await sql`
            INSERT INTO company_tasks (company_id, title, description, category, priority, status, source)
            VALUES (
              ${companyId}, ${taskTitle},
              ${"The post-deploy.yml test workflow is failing (conclusion: " + (latestTestRun.conclusion || "unknown") + "). Investigate and fix the test suite. Common issues: 1) Playwright not installed in CI, 2) Missing env vars in workflow, 3) Tests targeting removed/changed pages, 4) Timeout issues. Check the latest GitHub Actions run logs for details."},
              'qa', 1, 'proposed', 'sentinel'
            )
          `;
          testCoverageIssues++;
        }
      }
    }

    if (testCoverageIssues > 0) {
      await sql`
        INSERT INTO agent_actions (agent, action_type, description, status, started_at, finished_at)
        VALUES ('sentinel', 'test_coverage_check',
          ${`Test coverage check: ${testCoverageIssues} issues found across ${testCompanies.length} companies`},
          'success', NOW(), NOW())
      `.catch(() => {});
    }
    results.test_coverage_issues = testCoverageIssues;
  } catch (e: any) {
    console.warn("[company-health] Check 36 failed:", e.message);
  }

  // --- Check 38: Review and auto-merge open Hive PRs ---
  if (ghPat) try {
    const prListRes = await fetch("https://api.github.com/repos/carloshmiranda/hive/pulls?state=open&per_page=30", {
      headers: { Authorization: `token ${ghPat}`, Accept: "application/vnd.github.v3+json" },
    });
    if (prListRes.ok) {
      const openPRs = await prListRes.json();
      const hivePRs = openPRs.filter((pr: any) => pr.head?.ref?.startsWith("hive/"));
      let merged = 0, escalated = 0;

      for (const pr of hivePRs) {
        try {
          const { analyzePR: analyzeHivePR, autoMergePR: mergeHivePR } = await import("@/lib/pr-risk-scoring");
          const analysis = await analyzeHivePR("carloshmiranda", "hive", pr.number, ghPat!);

          if (analysis.decision === "auto_merge") {
            const result = await mergeHivePR("carloshmiranda", "hive", pr.number, ghPat!, "squash");
            if (result.success) {
              merged++;
              await sql`
                UPDATE hive_backlog SET status = 'done', notes = COALESCE(notes, '') || ${` [auto-merged] PR #${pr.number} merged by company-health check 38.`}
                WHERE status = 'pr_open'
                  AND (notes LIKE ${'%PR #' + pr.number + '%'} OR notes LIKE ${'%' + pr.head.ref + '%'})
              `.catch(() => {});

              try {
                await fetch(`${baseUrl}/api/notify`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", Authorization: `Bearer ${cronSecret}` },
                  body: JSON.stringify({ text: `✅ Auto-merged PR #${pr.number}: ${pr.title} (risk: ${analysis.riskScore})` }),
                });
              } catch {}
            }
          } else if (analysis.decision === "escalate") {
            const [existingApproval] = await sql`
              SELECT id FROM approvals WHERE gate_type = 'pr_review' AND status = 'pending'
                AND context->>'pr_number' = ${String(pr.number)}
            `;
            if (!existingApproval) {
              const issues = [...analysis.hardGateIssues, ...analysis.costFactors, ...analysis.riskFactors];
              await sql`
                INSERT INTO approvals (gate_type, title, description, context, status)
                VALUES ('pr_review', ${`PR #${pr.number}: ${pr.title}`},
                  ${`Risk score ${analysis.riskScore}. ${analysis.costImpact ? 'COST IMPACT: ' + analysis.costFactors.join(', ') + '. ' : ''}Issues: ${issues.join(", ")}`},
                  ${JSON.stringify({ pr_number: pr.number, risk_score: analysis.riskScore, hard_gates: analysis.hardGateIssues, cost_factors: analysis.costFactors, risk_factors: analysis.riskFactors })}::jsonb,
                  'pending')
              `;
              escalated++;
            }
          }
        } catch (prErr: any) {
          console.warn(`[company-health] PR #${pr.number} analysis failed: ${prErr.message}`);
        }
      }

      if (merged > 0 || escalated > 0) {
        await sql`
          INSERT INTO agent_actions (agent, action_type, description, status, started_at, finished_at)
          VALUES ('sentinel', 'pr_review_check',
            ${`PR review check 38: ${hivePRs.length} open PRs — ${merged} auto-merged, ${escalated} escalated`},
            'success', NOW(), NOW())
        `.catch(() => {});
      }
      results.prs_merged = merged;
      results.prs_escalated = escalated;
    }
  } catch (e: any) {
    console.warn("[company-health] Check 38 failed:", e.message);
  }

  // --- Check 30: Broken deploys + infra repair ---
  try {
    const companiesWithUrls = await sql`
      SELECT slug, COALESCE('https://' || domain, vercel_url) as check_url FROM companies
      WHERE status IN ('mvp', 'active') AND vercel_url IS NOT NULL AND github_repo IS NOT NULL
    `;
    const healthResults = await Promise.all(
      companiesWithUrls.map(async (c) => {
        try {
          const res = await fetch(c.check_url as string, {
            redirect: "follow",
            signal: AbortSignal.timeout(10000),
          });
          if (res.status >= 400) return { slug: c.slug as string, url: c.check_url as string, status: res.status };
          return null;
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : "unknown";
          return { slug: c.slug as string, url: c.check_url as string, status: 0, error: msg };
        }
      })
    );
    const brokenDeploys = healthResults.filter((r): r is NonNullable<typeof r> => r !== null);

    let infraRepairsAttempted = 0;
    let codeFixesDispatched = 0;
    for (const b of brokenDeploys) {
      // Step 1: Try infrastructure repair (free, no LLM)
      try {
        const repairRes = await fetch(`${baseUrl}/api/agents/repair-infra`, {
          method: "POST",
          headers: { Authorization: `Bearer ${cronSecret}`, "Content-Type": "application/json" },
          body: JSON.stringify({ company_slug: b.slug, repair_type: "stale_escalation" }),
          signal: AbortSignal.timeout(30000),
        });
        const repairData = await repairRes.json();
        infraRepairsAttempted++;

        const repaired = repairData.repairs?.vercel_duplicates?.action === "unlinked_duplicates"
          || repairData.repairs?.vercel_deploy?.action === "redeployed";

        if (repaired) continue;
      } catch (e: any) {
        console.warn(`[company-health] Infra repair failed for ${b.slug}: ${e.message}`);
      }

      // Step 2: Check circuit breaker before dispatching code fix
      const [failCount] = await sql`
        SELECT COUNT(*)::int as cnt FROM agent_actions
        WHERE company_id = (SELECT id FROM companies WHERE slug = ${b.slug})
          AND agent = 'engineer' AND status = 'failed'
          AND action_type IN ('error_fix', 'feature_request')
          AND started_at > NOW() - INTERVAL '24 hours'
      `;
      if ((failCount?.cnt || 0) >= 3) continue;

      // Step 3: Dispatch code fix to company repo
      const [co] = await sql`SELECT github_repo FROM companies WHERE slug = ${b.slug} LIMIT 1`;
      if (co?.github_repo && ghPat) {
        await fetch(`https://api.github.com/repos/${co.github_repo}/actions/workflows/hive-fix.yml/dispatches`, {
          method: "POST",
          headers: {
            Authorization: `token ${ghPat}`,
            Accept: "application/vnd.github.v3+json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            ref: "main",
            inputs: {
              company_slug: b.slug,
              error_summary: `Deploy broken (HTTP ${b.status}) — infra repair attempted, issue appears to be code-level`,
              source: "company-health",
            },
          }),
        });
        codeFixesDispatched++;
      }
    }
    results.broken_deploys = brokenDeploys.length;
    results.infra_repairs_attempted = infraRepairsAttempted;
    results.code_fixes_dispatched = codeFixesDispatched;
  } catch (e: any) {
    console.warn("[company-health] Check 30 failed:", e.message);
  }

  // Log overall run
  await sql`
    INSERT INTO agent_actions (agent, action_type, description, status, output, started_at, finished_at)
    VALUES ('sentinel', 'company_health_check',
      ${`Company health checks: ${JSON.stringify(results)}`},
      'success', ${JSON.stringify(results)}::jsonb, NOW(), NOW())
  `.catch(() => {});

  // Telegram notification if issues found
  try {
    const { notifyHive } = await import("@/lib/telegram");
    const parts: string[] = [];
    if (results.stats_endpoints_broken) parts.push(`${results.stats_endpoints_broken} broken stats`);
    if (results.language_mismatches) parts.push(`${results.language_mismatches} lang mismatches`);
    if (results.stale_records_fixed) parts.push(`${results.stale_records_fixed} stale records fixed`);
    if (results.test_coverage_issues) parts.push(`${results.test_coverage_issues} test issues`);
    if (results.prs_merged) parts.push(`${results.prs_merged} PRs merged`);
    if (results.broken_deploys) parts.push(`${results.broken_deploys} broken deploys`);
    if (parts.length > 0) {
      await notifyHive({
        agent: "sentinel",
        action: "company_health",
        status: "success",
        summary: parts.join(", "),
      });
    }
  } catch { /* Telegram not configured */ }

  return Response.json({ ok: true, ...results });
}
