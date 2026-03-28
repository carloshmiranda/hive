import { getDb } from "@/lib/db";
import { getSettingValue } from "@/lib/settings";
import { normalizeError, errorSimilarity } from "@/lib/error-normalize";
import { verifyCronAuth, qstashPublish } from "@/lib/qstash";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Extracted from Sentinel: HTTP-heavy company health checks that were causing timeouts.
// Sentinel fires this as non-blocking fetch. Each check logs results to agent_actions.
// Checks: 31 (stats endpoints), 32 (language), 33 (stale records), 36 (tests), 38 (Hive PR merge),
//         39 (CI fix loop), 30 (broken deploys), 43 (dispatch verification), 44 (stale cycle safety net),
//         45 (company PR auto-merge with risk scoring)

export async function GET(req: Request) {
  const auth = await verifyCronAuth(req);
  if (!auth.authorized) {
    return Response.json({ error: auth.error }, { status: 401 });
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
      } catch (e: any) {
        console.warn(`[company-health] language check fetch for ${lc.slug} failed: ${e?.message || e}`);
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
        } catch (e: any) {
          console.warn(`[company-health] stale record reconciliation for ${rc.slug} failed: ${e?.message || e}`);
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
      } catch (e: any) { console.warn(`[company-health] check tests/ dir for ${slug} failed: ${e?.message || e}`); }

      try {
        const playwrightRes = await fetch(`https://api.github.com/repos/${repo}/contents/playwright.config.ts`, {
          headers: { Authorization: `token ${ghPat}`, Accept: "application/vnd.github.v3+json" },
          signal: AbortSignal.timeout(5000),
        });
        if (playwrightRes.ok) { hasPlaywrightConfig = true; hasTestFiles = true; }
      } catch (e: any) { console.warn(`[company-health] check playwright config for ${slug} failed: ${e?.message || e}`); }

      if (!hasTestFiles) {
        try {
          const srcTestsRes = await fetch(`https://api.github.com/repos/${repo}/contents/src/__tests__`, {
            headers: { Authorization: `token ${ghPat}`, Accept: "application/vnd.github.v3+json" },
            signal: AbortSignal.timeout(5000),
          });
          if (srcTestsRes.ok) { hasTestFiles = true; }
        } catch (e: any) { console.warn(`[company-health] check src/__tests__ for ${slug} failed: ${e?.message || e}`); }
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
        } catch (e: any) { console.warn(`[company-health] check test workflow runs for ${slug} failed: ${e?.message || e}`); }
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
      } catch (e: any) { console.warn(`[company-health] update test capabilities for ${slug} failed: ${e?.message || e}`); }

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
      `.catch((e: any) => { console.warn(`[company-health] log test coverage check failed: ${e?.message || e}`); });
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
                UPDATE hive_backlog SET status = 'done', completed_at = NOW(),
                  notes = COALESCE(notes, '') || ${` [auto-merged] PR #${pr.number} merged by company-health check 38.`}
                WHERE status = 'pr_open' AND pr_number = ${pr.number}
              `.catch((e: any) => { console.warn(`[company-health] update backlog for merged PR #${pr.number} failed: ${e?.message || e}`); });

              try {
                await fetch(`${baseUrl}/api/notify`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", Authorization: `Bearer ${cronSecret}` },
                  body: JSON.stringify({ text: `✅ Auto-merged PR #${pr.number}: ${pr.title} (risk: ${analysis.riskScore})` }),
                });
              } catch (e: any) { console.warn(`[company-health] notify auto-merge PR #${pr.number} failed: ${e?.message || e}`); }
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
        `.catch((e: any) => { console.warn(`[company-health] log PR review check failed: ${e?.message || e}`); });
      }
      results.prs_merged = merged;
      results.prs_escalated = escalated;
    }
  } catch (e: any) {
    console.warn("[company-health] Check 38 failed:", e.message);
  }

  // --- Check 39: CI failure auto-fix loop ---
  // When a Hive PR has failing CI, fetch the error logs and re-dispatch the Engineer
  // to fix the issue on the same branch. This closes the loop so PRs don't sit with
  // failing CI waiting for human intervention.
  // Rate limit: 1 fix attempt per PR per 2 hours (tracked via agent_actions).
  if (ghPat) try {
    const prListRes39 = await fetch("https://api.github.com/repos/carloshmiranda/hive/pulls?state=open&per_page=30", {
      headers: { Authorization: `token ${ghPat}`, Accept: "application/vnd.github.v3+json" },
    });
    if (prListRes39.ok) {
      const openPRs39 = await prListRes39.json();
      const hivePRs39 = openPRs39.filter((pr: any) => pr.head?.ref?.startsWith("hive/"));
      let ciFixDispatched = 0;

      for (const pr of hivePRs39) {
        try {
          // Check CI status for this PR
          const checksRes = await fetch(`https://api.github.com/repos/carloshmiranda/hive/commits/${pr.head.sha}/check-runs`, {
            headers: { Authorization: `token ${ghPat}`, Accept: "application/vnd.github.v3+json" },
          });
          if (!checksRes.ok) continue;
          const checksData = await checksRes.json();
          const failedChecks = (checksData.check_runs || []).filter(
            (c: any) => c.conclusion === "failure" || c.conclusion === "cancelled"
          );
          if (failedChecks.length === 0) continue; // CI not failing — skip

          // Rate limit: check if we already dispatched a ci_fix for this PR recently
          const [recentFix] = await sql`
            SELECT id FROM agent_actions
            WHERE agent = 'engineer' AND action_type = 'ci_fix'
            AND description LIKE ${`%PR #${pr.number}%`}
            AND started_at > NOW() - INTERVAL '2 hours'
            LIMIT 1
          `.catch(() => []);
          if (recentFix) continue; // Already attempted recently

          // Also check: is an Engineer already running? Don't pile up.
          const [runningEng] = await sql`
            SELECT id FROM agent_actions
            WHERE agent = 'engineer' AND status = 'running'
            AND company_id IS NULL
            AND started_at > NOW() - INTERVAL '1 hour'
            LIMIT 1
          `.catch(() => []);
          if (runningEng) continue; // Engineer busy — will retry next health check

          // Fetch CI failure logs from the failed check runs
          const errorLines: string[] = [];
          for (const check of failedChecks.slice(0, 3)) {
            // Get the annotations (error messages) from the check run
            const annotationsRes = await fetch(`https://api.github.com/repos/carloshmiranda/hive/check-runs/${check.id}/annotations`, {
              headers: { Authorization: `token ${ghPat}`, Accept: "application/vnd.github.v3+json" },
            }).catch(() => null);
            if (annotationsRes?.ok) {
              const annotations = await annotationsRes.json();
              for (const a of annotations.slice(0, 10)) {
                errorLines.push(`${a.path || ""}:${a.start_line || ""} ${a.annotation_level}: ${a.message}`);
              }
            }

            // Also try to get the output summary (contains build errors)
            if (check.output?.summary) {
              errorLines.push(check.output.summary.slice(0, 500));
            }
            if (check.output?.text) {
              errorLines.push(check.output.text.slice(0, 500));
            }
          }

          // If no annotations, try fetching the workflow run logs
          if (errorLines.length === 0) {
            // Find the workflow run for this check suite
            const runsRes = await fetch(
              `https://api.github.com/repos/carloshmiranda/hive/actions/runs?head_sha=${pr.head.sha}&status=failure&per_page=3`,
              { headers: { Authorization: `token ${ghPat}`, Accept: "application/vnd.github.v3+json" } }
            ).catch(() => null);
            if (runsRes?.ok) {
              const runsData = await runsRes.json();
              for (const run of (runsData.workflow_runs || []).slice(0, 2)) {
                // Get failed jobs
                const jobsRes = await fetch(`${run.jobs_url}?filter=latest&per_page=10`, {
                  headers: { Authorization: `token ${ghPat}`, Accept: "application/vnd.github.v3+json" },
                }).catch(() => null);
                if (jobsRes?.ok) {
                  const jobsData = await jobsRes.json();
                  const failedJobs = (jobsData.jobs || []).filter((j: any) => j.conclusion === "failure");
                  for (const job of failedJobs.slice(0, 2)) {
                    const failedSteps = (job.steps || []).filter((s: any) => s.conclusion === "failure");
                    for (const step of failedSteps) {
                      errorLines.push(`Step "${step.name}" failed in job "${job.name}"`);
                    }
                  }
                }
              }
            }
          }

          const ciErrorContext = errorLines.length > 0
            ? errorLines.join("\n").slice(0, 2000)
            : `CI checks failed: ${failedChecks.map((c: any) => c.name).join(", ")}`;

          // Find the backlog item for this PR (if any)
          const [backlogItem] = await sql`
            SELECT id, title FROM hive_backlog
            WHERE pr_number = ${pr.number} AND status = 'pr_open'
            LIMIT 1
          `.catch(() => []);

          // Dispatch Engineer to fix CI on this branch
          await qstashPublish("/api/dispatch/chain-dispatch", {
            event_type: "ci_fix",
            source: "company_health_check_39",
            company: "",
            pr_number: pr.number,
            branch: pr.head.ref,
            ci_errors: ciErrorContext,
            backlog_id: backlogItem?.id || "",
            task: `Fix CI failures on PR #${pr.number}: ${pr.title}`,
          }, {
            retries: 2,
            deduplicationId: `ci-fix-${pr.number}-${Date.now().toString(36)}`,
          });

          // Log the dispatch
          await sql`
            INSERT INTO agent_actions (agent, action_type, status, description, started_at, finished_at)
            VALUES ('engineer', 'ci_fix', 'running',
              ${`CI fix dispatched for PR #${pr.number}: ${pr.title}. Errors: ${ciErrorContext.slice(0, 200)}`},
              NOW(), NOW())
          `.catch((e: any) => { console.warn(`[company-health] log CI fix dispatch for PR #${pr.number} failed: ${e?.message || e}`); });

          ciFixDispatched++;
          break; // Only dispatch one CI fix per health check cycle
        } catch (prErr: any) {
          console.warn(`[company-health] Check 39 PR #${pr.number} failed: ${prErr.message}`);
        }
      }

      if (ciFixDispatched > 0) {
        results.ci_fix_dispatched = ciFixDispatched;
      }
    }
  } catch (e: any) {
    console.warn("[company-health] Check 39 failed:", e.message);
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

  // --- Check 43: Dispatch verification — detect silent workflow failures ---
  if (ghPat) try {
    let silentFailures = 0;
    // Find recent dispatches that never produced an agent_action
    const unverifiedDispatches = await sql`
      SELECT aa.id, aa.agent, aa.action_type, aa.company_id, aa.started_at,
        c.slug as company_slug
      FROM agent_actions aa
      LEFT JOIN companies c ON c.id = aa.company_id
      WHERE aa.agent = 'sentinel'
        AND aa.action_type IN ('cycle_start_dispatch', 'feature_dispatch', 'research_dispatch')
        AND aa.status = 'success'
        AND aa.started_at > NOW() - INTERVAL '6 hours'
        AND aa.started_at < NOW() - INTERVAL '30 minutes'
    `;

    for (const d of unverifiedDispatches) {
      // Check if the target agent produced any action after the dispatch
      const targetAgent = (d.action_type as string).replace('_dispatch', '').replace('cycle_start', 'ceo');
      const [hasAction] = await sql`
        SELECT id FROM agent_actions
        WHERE agent = ${targetAgent}
          AND started_at > ${d.started_at}
          AND (company_id = ${d.company_id} OR company_id IS NULL)
        LIMIT 1
      `;
      if (!hasAction) {
        // Also check GitHub Actions for recent workflow runs
        const workflowMap: Record<string, string> = {
          ceo: 'hive-ceo.yml',
          engineer: 'hive-engineer.yml',
          scout: 'hive-scout.yml',
        };
        const workflowFile = workflowMap[targetAgent] || '';
        let runFound = false;
        if (workflowFile) {
          try {
            const runsRes = await fetch(
              `https://api.github.com/repos/carloshmiranda/hive/actions/workflows/${workflowFile}/runs?per_page=3&created=>=${new Date(d.started_at as string).toISOString().split('T')[0]}`,
              {
                headers: { Authorization: `token ${ghPat}`, Accept: "application/vnd.github.v3+json" },
                signal: AbortSignal.timeout(5000),
              }
            );
            if (runsRes.ok) {
              const runsData = await runsRes.json();
              runFound = (runsData.total_count || 0) > 0;
            }
          } catch (e: any) { console.warn(`[company-health] check workflow runs for dispatch verification failed: ${e?.message || e}`); }
        }

        if (!runFound) {
          silentFailures++;
          await sql`
            INSERT INTO agent_actions (agent, action_type, description, status, output, started_at, finished_at)
            VALUES ('sentinel', 'dispatch_verification',
              ${`Silent failure: ${d.action_type} for ${d.company_slug || 'unknown'} dispatched at ${d.started_at} — no workflow run or agent action found`},
              'failed',
              ${JSON.stringify({ original_dispatch: d.id, target_agent: targetAgent, company: d.company_slug })}::jsonb,
              NOW(), NOW())
          `.catch((e: any) => { console.warn(`[company-health] log silent dispatch failure for ${d.company_slug} failed: ${e?.message || e}`); });
        }
      }
    }
    results.silent_failures = silentFailures;
  } catch (e: any) {
    console.warn("[company-health] Check 43 failed:", e.message);
  }

  // --- Check 44: Stale company safety net — dispatch cycle_start for companies stale >6h ---
  try {
    let staleCyclesDispatched = 0;
    const staleCompanies = await sql`
      SELECT c.id, c.slug, c.status,
        (SELECT MAX(started_at) FROM cycles WHERE company_id = c.id) as last_cycle,
        (SELECT MAX(started_at) FROM agent_actions WHERE company_id = c.id AND agent = 'ceo') as last_ceo
      FROM companies c
      WHERE c.status IN ('mvp', 'active')
        AND c.github_repo IS NOT NULL
    `;

    for (const sc of staleCompanies) {
      const lastActivity = sc.last_ceo || sc.last_cycle;
      if (!lastActivity) continue;
      const hoursSinceActivity = (Date.now() - new Date(lastActivity as string).getTime()) / (1000 * 60 * 60);

      // Only dispatch if stale >6h AND no recent dispatch for this company
      if (hoursSinceActivity > 6) {
        const [recentDispatch] = await sql`
          SELECT id FROM agent_actions
          WHERE agent = 'sentinel'
            AND action_type = 'stale_cycle_dispatch'
            AND company_id = ${sc.id}
            AND started_at > NOW() - INTERVAL '6 hours'
          LIMIT 1
        `;
        if (recentDispatch) continue;

        // Check budget before dispatching
        const [recentCeoRuns] = await sql`
          SELECT COUNT(*)::int as cnt FROM agent_actions
          WHERE agent = 'ceo' AND started_at > NOW() - INTERVAL '4 hours'
        `;
        if ((recentCeoRuns?.cnt || 0) >= 3) continue; // Don't exceed budget

        // Dispatch via GitHub Actions
        if (ghPat) {
          await fetch("https://api.github.com/repos/carloshmiranda/hive/dispatches", {
            method: "POST",
            headers: {
              Authorization: `token ${ghPat}`,
              Accept: "application/vnd.github.v3+json",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              event_type: "cycle_start",
              client_payload: { source: "sentinel_stale", company: sc.slug },
            }),
          });

          await sql`
            INSERT INTO agent_actions (agent, action_type, description, status, company_id, started_at, finished_at)
            VALUES ('sentinel', 'stale_cycle_dispatch',
              ${`Safety net: dispatched cycle_start for ${sc.slug} (stale ${Math.round(hoursSinceActivity)}h)`},
              'success', ${sc.id}, NOW(), NOW())
          `.catch((e: any) => { console.warn(`[company-health] log stale cycle dispatch for ${sc.slug} failed: ${e?.message || e}`); });

          staleCyclesDispatched++;
        }
      }
    }
    results.stale_cycles_dispatched = staleCyclesDispatched;
  } catch (e: any) {
    console.warn("[company-health] Check 44 failed:", e.message);
  }

  // --- Check 45: Auto-merge company repo PRs with low risk scores and passing CI ---
  if (ghPat) try {
    let autoMerged = 0;
    let escalated = 0;
    const prCompanies = await sql`
      SELECT c.id, c.slug, c.github_repo
      FROM companies c
      WHERE c.status IN ('mvp', 'active') AND c.github_repo IS NOT NULL
    `;

    for (const pc of prCompanies) {
      try {
        const prListRes = await fetch(
          `https://api.github.com/repos/${pc.github_repo}/pulls?state=open&per_page=10`,
          {
            headers: { Authorization: `token ${ghPat}`, Accept: "application/vnd.github.v3+json" },
            signal: AbortSignal.timeout(5000),
          }
        );
        if (!prListRes.ok) continue;
        const openPRs = await prListRes.json();

        for (const pr of openPRs) {
          // Check if PR is old enough to be considered for action (>2h)
          const prAge = (Date.now() - new Date(pr.created_at).getTime()) / (1000 * 60 * 60);
          if (prAge < 2) continue;

          try {
            // Analyze PR using the existing risk scoring system
            const { analyzePR, autoMergePR } = await import("@/lib/pr-risk-scoring");
            const [owner, repo] = pc.github_repo.split('/');
            const analysis = await analyzePR(owner, repo, pr.number, ghPat!);

            if (analysis.decision === 'auto_merge') {
              // Auto-merge PRs with low risk scores and passing CI
              const mergeResult = await autoMergePR(owner, repo, pr.number, ghPat!, 'squash');

              if (mergeResult.success) {
                autoMerged++;
                await sql`
                  INSERT INTO agent_actions (agent, action_type, description, status, company_id, started_at, finished_at)
                  VALUES ('sentinel', 'pr_auto_merge',
                    ${`Auto-merged PR: ${pc.github_repo}#${pr.number} "${pr.title}" — risk score ${analysis.riskScore}, CI passed`},
                    'success', ${pc.id}, NOW(), NOW())
                `.catch((e: any) => { console.warn(`[company-health] log auto-merge for ${pc.slug}#${pr.number} failed: ${e?.message || e}`); });

                // Update any related company tasks to completed (extract task_id from branch name)
                const branchRef = pr.head?.ref || "";
                const taskIdMatch = branchRef.match(/^hive\/cycle-\d+-(.+)$/);
                if (taskIdMatch?.[1]) {
                  await sql`
                    UPDATE company_tasks SET status = 'done', updated_at = NOW()
                    WHERE id = ${taskIdMatch[1]} AND company_id = ${pc.id}
                    AND status IN ('proposed', 'in_progress')
                  `.catch((e: any) => { console.warn(`[company-health] update task ${taskIdMatch[1]} for merged PR #${pr.number} failed: ${e?.message || e}`); });
                }

                // Telegram notification for auto-merge
                try {
                  const { notifyHive } = await import("@/lib/telegram");
                  await notifyHive({
                    agent: 'sentinel',
                    action: 'pr_auto_merge',
                    company: pc.slug,
                    status: 'success',
                    summary: `Auto-merged PR #${pr.number}: ${pr.title}`,
                    details: `Risk score: ${analysis.riskScore}. Factors: ${analysis.riskFactors.length > 0 ? analysis.riskFactors.join(', ') : 'none'}`,
                    pr_number: pr.number,
                    pr_url: `https://github.com/${pc.github_repo}/pull/${pr.number}`,
                    pr_title: pr.title
                  });
                } catch (e: any) { console.warn(`[company-health] notify auto-merge PR #${pr.number} failed: ${e?.message || e}`); }
              } else {
                // Auto-merge failed - escalate for manual review
                escalated++;
                await fetch("https://api.github.com/repos/carloshmiranda/hive/dispatches", {
                  method: "POST",
                  headers: {
                    Authorization: `token ${ghPat}`,
                    Accept: "application/vnd.github.v3+json",
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({
                    event_type: "ceo_review",
                    client_payload: {
                      source: "sentinel_merge_failed",
                      company: pc.slug,
                      pr_number: pr.number,
                      merge_error: mergeResult.message,
                    },
                  }),
                });

                await sql`
                  INSERT INTO agent_actions (agent, action_type, description, status, company_id, started_at, finished_at)
                  VALUES ('sentinel', 'pr_merge_failed',
                    ${`PR merge failed: ${pc.github_repo}#${pr.number} "${pr.title}" — ${mergeResult.message}, escalated for CEO review`},
                    'escalated', ${pc.id}, NOW(), NOW())
                `.catch((e: any) => { console.warn(`[company-health] log merge failure for ${pc.slug}#${pr.number} failed: ${e?.message || e}`); });
              }
            } else {
              // High risk score or safety issues - escalate to CEO review
              escalated++;
              await fetch("https://api.github.com/repos/carloshmiranda/hive/dispatches", {
                method: "POST",
                headers: {
                  Authorization: `token ${ghPat}`,
                  Accept: "application/vnd.github.v3+json",
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  event_type: "ceo_review",
                  client_payload: {
                    source: "sentinel_high_risk_pr",
                    company: pc.slug,
                    pr_number: pr.number,
                    risk_score: analysis.riskScore,
                    risk_factors: analysis.riskFactors,
                    hard_gate_issues: analysis.hardGateIssues,
                  },
                }),
              });

              await sql`
                INSERT INTO agent_actions (agent, action_type, description, status, company_id, started_at, finished_at)
                VALUES ('sentinel', 'pr_escalated',
                  ${`High-risk PR: ${pc.github_repo}#${pr.number} "${pr.title}" — risk ${analysis.riskScore}, factors: ${analysis.riskFactors.join(', ')}, escalated for CEO review`},
                  'escalated', ${pc.id}, NOW(), NOW())
              `.catch((e: any) => { console.warn(`[company-health] log PR escalation for ${pc.slug}#${pr.number} failed: ${e?.message || e}`); });
            }
          } catch (prErr: any) {
            // PR analysis failed - log error and escalate
            escalated++;
            console.warn(`[company-health] PR #${pr.number} analysis failed: ${prErr.message}`);
            await sql`
              INSERT INTO agent_actions (agent, action_type, description, status, company_id, started_at, finished_at)
              VALUES ('sentinel', 'pr_analysis_error',
                ${`PR analysis error: ${pc.github_repo}#${pr.number} "${pr.title}" — ${prErr.message}, escalated for manual review`},
                'failed', ${pc.id}, NOW(), NOW())
            `.catch((e: any) => { console.warn(`[company-health] log PR analysis error for ${pc.slug}#${pr.number} failed: ${e?.message || e}`); });

            await fetch("https://api.github.com/repos/carloshmiranda/hive/dispatches", {
              method: "POST",
              headers: {
                Authorization: `token ${ghPat}`,
                Accept: "application/vnd.github.v3+json",
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                event_type: "ceo_review",
                client_payload: {
                  source: "sentinel_pr_analysis_error",
                  company: pc.slug,
                  pr_number: pr.number,
                  error: prErr.message,
                },
              }),
            });
          }
        }
      } catch (e: any) { console.warn(`[company-health] PR check for ${pc.slug} failed: ${e?.message || e}`); }
    }
    results.prs_auto_merged = autoMerged;
    results.prs_escalated = escalated;
  } catch (e: any) {
    console.warn("[company-health] Check 45 failed:", e.message);
  }

  // Log overall run
  await sql`
    INSERT INTO agent_actions (agent, action_type, description, status, output, started_at, finished_at)
    VALUES ('sentinel', 'company_health_check',
      ${`Company health checks: ${JSON.stringify(results)}`},
      'success', ${JSON.stringify(results)}::jsonb, NOW(), NOW())
  `.catch((e: any) => { console.warn(`[company-health] log overall health check run failed: ${e?.message || e}`); });

  // Telegram notification if issues found
  try {
    const { notifyHive } = await import("@/lib/telegram");
    const parts: string[] = [];
    if (results.stats_endpoints_broken) parts.push(`${results.stats_endpoints_broken} broken stats`);
    if (results.language_mismatches) parts.push(`${results.language_mismatches} lang mismatches`);
    if (results.stale_records_fixed) parts.push(`${results.stale_records_fixed} stale records fixed`);
    if (results.test_coverage_issues) parts.push(`${results.test_coverage_issues} test issues`);
    if (results.prs_merged) parts.push(`${results.prs_merged} Hive PRs merged`);
    if (results.prs_auto_merged) parts.push(`${results.prs_auto_merged} company PRs auto-merged`);
    if (results.prs_escalated) parts.push(`${results.prs_escalated} PRs escalated for review`);
    if (results.broken_deploys) parts.push(`${results.broken_deploys} broken deploys`);
    if (results.silent_failures) parts.push(`${results.silent_failures} silent dispatch failures`);
    if (results.stale_cycles_dispatched) parts.push(`${results.stale_cycles_dispatched} stale cycles dispatched`);
    if (parts.length > 0) {
      await notifyHive({
        agent: "sentinel",
        action: "company_health",
        status: "success",
        summary: parts.join(", "),
      });
    }
  } catch (e: any) { console.warn(`[company-health] Telegram notification failed: ${e?.message || e}`); }

  return Response.json({ ok: true, ...results });
}

// QStash sends POST — re-export GET handler for dual-mode auth
export { GET as POST };
