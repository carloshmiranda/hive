/**
 * Sentinel Dispatch Tier (ADR-031 Phase 2)
 *
 * Runs every 4 hours. Handles agent scheduling, cycle dispatch, and the core
 * business logic of deciding what work to do.
 *
 * Checks extracted from the monolithic sentinel/route.ts:
 *   - Approval expiry + orphaned idea cleanup
 *   - Pipeline low, stale content/leads, CEO review, unverified deploys
 *   - High failure rate → Healer dispatch
 *   - Chain dispatch gap detection
 *   - Stalled companies
 *   - Priority-ranked cycle dispatch (budget-gated)
 *   - Hive-first triage (auto-approve critical proposals, backlog dispatch, systemic healer)
 *   - Backlog dispatch (P0/P1 before company cycles)
 *   - Company cycle dispatch
 */

import * as Sentry from "@sentry/nextjs";
import { setSentryTags } from "@/lib/sentry-tags";
import {
  initSentinelContext,
  dispatchToActions,
  dispatchToWorker,
  dispatchToCompanyWorkflow,
  isCircuitOpen,
  batchCheckCircuits,
  checkHealerCompanyCircuitBreaker,
  batchCheckHealerCircuitBreakers,
  MAX_CYCLE_DISPATCHES,
  type SentinelContext,
  type Dispatch,
} from "@/lib/sentinel-helpers";
import { getDb } from "@/lib/db";
import { getSettingValue } from "@/lib/settings";
import { invalidateCompanyList } from "@/lib/redis-cache";
import { verifyCronAuth, qstashPublish } from "@/lib/qstash";
import { fetchRecentErrors, extractErrorPatterns, shouldDispatchHealer, createErrorSummary } from "@/lib/sentry-api";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  // Set Sentry tags for error triage and filtering
  setSentryTags({
    action_type: "cron",
    route: "/api/cron/sentinel-dispatch",
    agent: "sentinel"
  });

  // Auth check — handle directly since initSentinelContext auth may not match verifyCronAuth's return shape
  const auth = await verifyCronAuth(request);
  if (!auth.authorized) {
    return Response.json({ error: auth.error }, { status: 401 });
  }

  // Sentry cron monitoring - monitors the most critical 4h schedule that drives the entire dispatch chain
  const checkInId = Sentry.captureCheckIn({
    monitorSlug: "sentinel-dispatch",
    status: "in_progress",
  });

  try {
    const result = await executeSentinelDispatch(request);

    // Capture successful execution
    Sentry.captureCheckIn({
      checkInId,
      monitorSlug: "sentinel-dispatch",
      status: "ok",
    });

    return result;
  } catch (error) {
    // Capture failure
    Sentry.captureCheckIn({
      checkInId,
      monitorSlug: "sentinel-dispatch",
      status: "error",
    });
    throw error;
  }
}

async function executeSentinelDispatch(request: Request) {

  let ctx: SentinelContext;
  try {
    ctx = await initSentinelContext(request, "sentinel-dispatch");
  } catch {
    // initSentinelContext may throw on auth — we already verified above, so build ctx manually
    const sql = getDb();
    const ghPat = await getSettingValue("github_token").catch(() => null);
    const vercelToken = await getSettingValue("vercel_token").catch(() => null);
    const baseUrl = process.env.NEXT_PUBLIC_URL || "https://hive-phi.vercel.app";
    const cronSecret = process.env.CRON_SECRET || "";
    const traceId = `sentinel-dispatch-${Date.now().toString(36)}`;

    // Import getActiveClaims from helpers
    const { getActiveClaims } = await import("@/lib/sentinel-helpers");
    const activeClaims = await getActiveClaims(ghPat);

    ctx = {
      sql,
      ghPat,
      vercelToken,
      baseUrl,
      cronSecret,
      traceId,
      dispatches: [],
      activeClaims,
      dispatchedThisRun: new Set(),
      dedupSkips: 0,
      circuitBreaks: 0,
    };
  }

  const { sql, ghPat, baseUrl, cronSecret, traceId } = ctx;
  const dispatches = ctx.dispatches;
  let cycleDispatches = 0;

  try {
    // ========================================================================
    // QSTASH SCHEDULE HEALTH CHECK (self-healing)
    // ========================================================================
    // If Sentinel is running, QStash is working. But other schedules may have
    // been lost (redeployment, QStash purge). Verify and recreate if needed.
    // Only check every ~12h to avoid API spam (use a simple time-based gate).
    try {
      const [lastCheck] = await sql`
        SELECT value FROM settings WHERE key = 'qstash_schedule_check_at'
      `.catch(() => []);
      const lastCheckTime = lastCheck?.value ? new Date(lastCheck.value).getTime() : 0;
      const hoursSinceCheck = (Date.now() - lastCheckTime) / 3600000;

      if (hoursSinceCheck > 12) {
        const { getQStashClient } = await import("@/lib/qstash");
        const qClient = getQStashClient();
        const schedules = await qClient.schedules.list();
        const scheduleUrls = new Set(schedules.map((s: any) => s.destination));

        const EXPECTED = [
          "/api/cron/sentinel-urgent",
          "/api/cron/sentinel-dispatch",
          "/api/cron/sentinel-janitor",
          "/api/cron/metrics",
          "/api/cron/digest",
          "/api/cron/uptime-monitor",
        ];
        const missing = EXPECTED.filter(p => !scheduleUrls.has(`${baseUrl}${p}`));

        if (missing.length > 0) {
          console.warn(`[sentinel-dispatch] Missing QStash schedules: ${missing.join(", ")} — recreating`);
          // Trigger schedule recreation via the setup endpoint
          await fetch(`${baseUrl}/api/setup/qstash-schedules`, {
            method: "POST",
            headers: { Authorization: `Bearer ${cronSecret}` },
            signal: AbortSignal.timeout(15000),
          }).catch((e: any) => console.warn(`[sentinel-dispatch] QStash schedule recreation failed: ${e?.message}`));
          dispatches.push({ type: "qstash_heal", detail: `Recreated missing: ${missing.join(", ")}` } as any);
        }

        // Update the check timestamp
        await sql`
          INSERT INTO settings (key, value, is_secret) VALUES ('qstash_schedule_check_at', ${new Date().toISOString()}, false)
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
        `.catch(() => {});
      }
    } catch (qErr) {
      console.warn("[sentinel-dispatch] QStash health check failed (non-blocking):", qErr instanceof Error ? qErr.message : "unknown");
    }

    // ========================================================================
    // SENTRY ERROR SURGE DETECTION
    // ========================================================================

    try {
      // Check for Sentry error patterns every 2 hours (when hours since last check >= 2)
      const lastSentryCheck = await sql`
        SELECT value FROM settings WHERE key = 'sentry_error_check_at'
      `.then(rows => rows[0]);

      const lastSentryCheckTime = lastSentryCheck?.value ? new Date(lastSentryCheck.value).getTime() : 0;
      const hoursSinceSentryCheck = (Date.now() - lastSentryCheckTime) / 3600000;

      if (hoursSinceSentryCheck >= 2) {
        console.log("[sentinel-dispatch] Running Sentry error surge check");

        // Fetch recent unresolved errors from Sentry (last hour)
        const recentErrors = await fetchRecentErrors(3600);

        if (recentErrors.length > 0) {
          // Extract error patterns and check if we should dispatch Healer
          const errorPatterns = extractErrorPatterns(recentErrors);
          const shouldDispatch = shouldDispatchHealer(errorPatterns, 3);

          console.log(`[sentinel-dispatch] Sentry check: ${recentErrors.length} errors, ${errorPatterns.length} distinct patterns`);

          if (shouldDispatch) {
            const errorSummary = createErrorSummary(errorPatterns);
            console.log(`[sentinel-dispatch] Sentry error surge detected, dispatching Healer`);

            dispatches.push({
              type: "healer_trigger",
              target: "_hive",
              payload: {
                trigger: "sentry_error_surge",
                context: errorSummary,
                detail: `${errorPatterns.length} distinct error patterns detected`,
              },
            });
          }
        } else {
          console.log("[sentinel-dispatch] Sentry check: no recent errors found");
        }

        // Update the check timestamp
        await sql`
          INSERT INTO settings (key, value, is_secret) VALUES ('sentry_error_check_at', ${new Date().toISOString()}, false)
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
        `.catch(() => {});
      }
    } catch (sentryErr) {
      console.warn("[sentinel-dispatch] Sentry error surge check failed (non-blocking):", sentryErr instanceof Error ? sentryErr.message : "unknown");
    }

    // ========================================================================
    // CEO DECISION RETROSPECTIVE VALIDATION
    // ========================================================================
    // Monthly retrospective analysis of strategic decisions to validate CEO decision quality
    // and build institutional memory for strategic patterns

    try {
      // Check for decision retrospectives monthly (when days since last check >= 30)
      const [lastDecisionCheck] = await sql`
        SELECT value FROM settings WHERE key = 'decision_retrospective_check_at'
      `.catch(() => []);

      const lastDecisionCheckTime = lastDecisionCheck?.value ? new Date(lastDecisionCheck.value).getTime() : 0;
      const daysSinceDecisionCheck = (Date.now() - lastDecisionCheckTime) / 86400000; // days

      if (daysSinceDecisionCheck >= 30) {
        console.log("[sentinel-dispatch] Running CEO decision retrospective validation");

        // Find decisions >30 days old that haven't been validated yet
        const pendingDecisions = await sql`
          SELECT d.*, c.slug as company_slug, c.name as company_name
          FROM decision_log d
          JOIN companies c ON c.id = d.company_id
          WHERE d.was_correct IS NULL
          AND d.created_at < NOW() - INTERVAL '30 days'
          ORDER BY d.created_at ASC
          LIMIT 10
        `;

        console.log(`[sentinel-dispatch] Found ${pendingDecisions.length} decisions needing retrospective validation`);

        if (pendingDecisions.length > 0) {
          // Analyze each decision and validate it
          let correctDecisions = 0;
          let totalValidated = 0;

          for (const decision of pendingDecisions) {
            try {
              // Gather current metrics to compare against expected_outcome
              const [currentMetrics] = await sql`
                SELECT
                  c.status as current_status,
                  COALESCE(
                    (SELECT SUM(revenue) FROM metrics
                     WHERE company_id = ${decision.company_id}
                     AND date >= ${decision.created_at}::date),
                    0
                  ) as revenue_since_decision,
                  COALESCE(
                    (SELECT traffic FROM metrics
                     WHERE company_id = ${decision.company_id}
                     ORDER BY date DESC LIMIT 1),
                    0
                  ) as current_traffic,
                  COALESCE(
                    (SELECT signups FROM metrics
                     WHERE company_id = ${decision.company_id}
                     ORDER BY date DESC LIMIT 1),
                    0
                  ) as current_signups
                FROM companies c
                WHERE c.id = ${decision.company_id}
              `.catch(() => [{}]);

              // Simple validation logic based on decision type
              let wasCorrect = false;
              let actualOutcome = "No measurable change";

              // Extract metrics safely with defaults
              const status = (currentMetrics && 'current_status' in currentMetrics) ? currentMetrics.current_status : 'unknown';
              const revenue = (currentMetrics && 'revenue_since_decision' in currentMetrics) ? Number(currentMetrics.revenue_since_decision) || 0 : 0;
              const traffic = (currentMetrics && 'current_traffic' in currentMetrics) ? Number(currentMetrics.current_traffic) || 0 : 0;
              const signups = (currentMetrics && 'current_signups' in currentMetrics) ? Number(currentMetrics.current_signups) || 0 : 0;

              if (decision.decision_type === 'kill') {
                // Kill decision: correct if company is actually killed or performing very poorly
                wasCorrect = status === 'killed' || (revenue === 0 && traffic < 100);
                actualOutcome = status === 'killed'
                  ? "Company was killed as expected"
                  : `Company still active but low performance: ${traffic} traffic, €${revenue} revenue`;
              } else if (decision.decision_type === 'phase_change') {
                // Phase change: correct if there's measurable improvement in key metrics
                const hasImprovement = revenue > 0 || traffic > 1000 || signups > 50;
                wasCorrect = hasImprovement;
                actualOutcome = hasImprovement
                  ? `Metrics improved: €${revenue} revenue, ${traffic} traffic, ${signups} signups`
                  : `No significant improvement: €${revenue} revenue, ${traffic} traffic, ${signups} signups`;
              } else if (decision.decision_type === 'priority_shift' || decision.decision_type === 'pivot') {
                // Priority/pivot decisions: correct if there's any positive momentum
                const hasMomentum = revenue > 0 || traffic > 500;
                wasCorrect = hasMomentum;
                actualOutcome = hasMomentum
                  ? `Positive momentum: €${revenue} revenue, ${traffic} traffic`
                  : `Limited momentum: €${revenue} revenue, ${traffic} traffic`;
              }

              // Update the decision with validation results
              await sql`
                UPDATE decision_log
                SET was_correct = ${wasCorrect},
                    actual_outcome = ${actualOutcome},
                    validated_at = NOW()
                WHERE id = ${decision.id}
              `;

              if (wasCorrect) correctDecisions++;
              totalValidated++;

              console.log(`[sentinel-dispatch] Validated decision ${decision.id} (${decision.decision_type}): ${wasCorrect ? 'CORRECT' : 'INCORRECT'}`);

            } catch (validationError) {
              console.warn(`[sentinel-dispatch] Failed to validate decision ${decision.id}:`, validationError instanceof Error ? validationError.message : "unknown");
            }
          }

          // Create a summary for CEO feedback
          const successRate = totalValidated > 0 ? Math.round((correctDecisions / totalValidated) * 100) : 0;

          if (totalValidated > 0) {
            dispatches.push({
              type: "healer_trigger", // Using healer for now to log the analysis
              target: "_hive",
              payload: {
                trigger: "decision_retrospective",
                context: `CEO decision track record: ${correctDecisions}/${totalValidated} decisions validated as correct (${successRate}% success rate)`,
                detail: `Monthly retrospective completed. Analyzed decisions from ${pendingDecisions[0]?.company_slug || 'multiple companies'}.`,
                metadata: {
                  correct_decisions: correctDecisions,
                  total_validated: totalValidated,
                  success_rate: successRate,
                  analysis_period: "30+ days ago"
                }
              },
            });
          }
        }

        // Update the check timestamp
        await sql`
          INSERT INTO settings (key, value, is_secret) VALUES ('decision_retrospective_check_at', ${new Date().toISOString()}, false)
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
        `.catch(() => {});

      }
    } catch (decisionErr) {
      console.warn("[sentinel-dispatch] Decision retrospective check failed (non-blocking):", decisionErr instanceof Error ? decisionErr.message : "unknown");
    }

    // ========================================================================
    // APPROVAL EXPIRY + ORPHANED IDEA CLEANUP
    // ========================================================================

    const expiredApprovals = await sql`
      UPDATE approvals
      SET status = 'expired',
          decision_note = 'Auto-expired: not reviewed within expiry window',
          decided_at = NOW()
      WHERE status = 'pending'
      AND (
        (gate_type = 'new_company' AND created_at < NOW() - INTERVAL '7 days')
        OR (gate_type = 'growth_strategy' AND created_at < NOW() - INTERVAL '7 days')
        OR (gate_type = 'spend_approval' AND created_at < NOW() - INTERVAL '7 days')
        OR (gate_type = 'outreach_batch' AND created_at < NOW() - INTERVAL '7 days')
        OR (gate_type = 'prompt_upgrade' AND created_at < NOW() - INTERVAL '14 days')
        OR (gate_type = 'social_account' AND created_at < NOW() - INTERVAL '14 days')
        OR (gate_type = 'capability_migration' AND created_at < NOW() - INTERVAL '3 days')
        OR (gate_type IN ('escalation', 'ops_escalation') AND created_at < NOW() - INTERVAL '2 days')
      )
      RETURNING id, gate_type, title
    `;
    if (expiredApprovals.length > 0) {
      console.log(`[sentinel-dispatch] Auto-expired ${expiredApprovals.length} stale approvals: ${expiredApprovals.map((a: any) => `${a.gate_type}:${a.id}`).join(", ")}`);
    }

    // Clean up orphaned companies from expired new_company approvals
    const cleanedCompanies = await sql`
      UPDATE companies SET status = 'killed', updated_at = NOW()
      WHERE status = 'idea'
      AND id NOT IN (
        SELECT company_id FROM approvals WHERE gate_type = 'new_company' AND status = 'pending' AND company_id IS NOT NULL
      )
      RETURNING id, slug
    `;
    if (cleanedCompanies.length > 0) {
      await invalidateCompanyList();
      console.log(`[sentinel-dispatch] Cleaned ${cleanedCompanies.length} orphaned idea companies: ${cleanedCompanies.map((c: any) => c.slug).join(", ")}`);
    }

    // ========================================================================
    // CHECK 1: Pipeline low
    // ========================================================================

    const [pipeline] = await sql`
      SELECT COUNT(*) as cnt FROM companies
      WHERE status IN ('idea','approved','provisioning','mvp','active')
    `;
    const [pendingIdeas] = await sql`
      SELECT COUNT(*) as cnt FROM companies WHERE status = 'idea'
    `;
    const [pendingProposals] = await sql`
      SELECT COUNT(*) as cnt FROM approvals
      WHERE gate_type = 'new_company' AND status = 'pending'
    `;
    const [staleProposals] = await sql`
      SELECT COUNT(*) as cnt FROM approvals
      WHERE gate_type = 'new_company' AND status = 'pending'
      AND created_at < NOW() - INTERVAL '48 hours'
    `;
    const scoutBlocked = parseInt(pendingProposals.cnt) >= 5 || parseInt(staleProposals.cnt) > 0;
    const pipelineLow = parseInt(pipeline.cnt) < 3 && parseInt(pendingIdeas.cnt) === 0 && !scoutBlocked;

    // ========================================================================
    // CHECK 2: Stale content (no growth success in 7 days)
    // ========================================================================

    const staleContent = await sql`
      SELECT c.slug, c.github_repo FROM companies c
      WHERE c.status IN ('mvp','active') AND c.github_repo IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM agent_actions aa
        WHERE aa.company_id = c.id AND aa.agent = 'growth'
        AND aa.status = 'success' AND aa.finished_at > NOW() - INTERVAL '7 days'
      )
    `;

    // ========================================================================
    // CHECK 3: Stale leads (lead_list >5 days, no outreach)
    // ========================================================================

    const staleLeads = await sql`
      SELECT c.slug FROM companies c
      WHERE c.status IN ('mvp','active') AND c.github_repo IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM research_reports rr
        WHERE rr.company_id = c.id AND rr.report_type = 'lead_list'
        AND rr.updated_at < NOW() - INTERVAL '5 days'
      )
      AND NOT EXISTS (
        SELECT 1 FROM agent_actions aa
        WHERE aa.company_id = c.id AND aa.agent = 'outreach'
        AND aa.status = 'success' AND aa.finished_at > NOW() - INTERVAL '5 days'
      )
    `;

    // ========================================================================
    // CHECK 4: No CEO review in 48h
    // ========================================================================

    const noCeoReview = await sql`
      SELECT c.slug FROM companies c
      WHERE c.status IN ('mvp','active') AND c.github_repo IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM agent_actions aa
        WHERE aa.company_id = c.id AND aa.agent = 'ceo'
        AND aa.status = 'success' AND aa.finished_at > NOW() - INTERVAL '48 hours'
      )
    `;

    // ========================================================================
    // CHECK 5: Unverified deploys in 24h
    // ========================================================================

    const unverifiedDeploys = await sql`
      SELECT c.slug FROM companies c
      WHERE c.status IN ('mvp','active') AND c.github_repo IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM agent_actions aa
        WHERE aa.company_id = c.id AND aa.action_type = 'deploy'
        AND aa.finished_at > NOW() - INTERVAL '24 hours'
      )
      AND NOT EXISTS (
        SELECT 1 FROM agent_actions aa
        WHERE aa.company_id = c.id AND aa.agent = 'ops'
        AND aa.action_type = 'health_check'
        AND aa.finished_at > NOW() - INTERVAL '24 hours'
      )
    `;

    // ========================================================================
    // CHECK 6: Pending PR reviews → CEO brain
    // Combines two sources:
    //   a) approvals table (webhook-driven, high-risk PRs escalated by auto-merge)
    //   b) hive_backlog pr_open status (catches PRs the webhook missed)
    // ========================================================================

    const pendingPrReviews = await sql`
      SELECT a.id, a.company_id, a.title, a.context,
             COALESCE(c.slug, '_hive') as slug
      FROM approvals a
      LEFT JOIN companies c ON c.id = a.company_id
      WHERE a.gate_type = 'pr_review' AND a.status = 'pending'
      AND a.created_at > NOW() - INTERVAL '7 days'
      AND NOT EXISTS (
        SELECT 1 FROM agent_actions aa
        WHERE aa.agent = 'ceo' AND aa.action_type = 'pr_review'
        AND aa.status IN ('success', 'running')
        AND aa.started_at > a.created_at
      )
    `;

    // Also scan backlog for pr_open items not covered by the approvals table
    const backlogOpenPrs = await sql`
      SELECT b.id, b.company_id, b.title, b.pr_number, b.pr_url,
             COALESCE(c.slug, '_hive') as slug
      FROM hive_backlog b
      LEFT JOIN companies c ON c.id = b.company_id
      WHERE b.status = 'pr_open' AND b.pr_number IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM agent_actions aa
        WHERE aa.agent = 'ceo' AND aa.action_type = 'pr_review'
        AND aa.status IN ('success', 'running')
        AND aa.started_at > NOW() - INTERVAL '4 hours'
        AND (aa.output::text LIKE ${'%"pr_number":' + '%'} OR aa.description LIKE ${'%PR #%'})
      )
    `;

    // ========================================================================
    // CHECK 7/7b: High failure rate + error threshold → Healer
    // ========================================================================

    const [failureStats] = await sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'failed') as failed,
        COUNT(*) as total
      FROM agent_actions
      WHERE finished_at > NOW() - INTERVAL '48 hours'
        AND agent NOT IN ('healer', 'sentinel')
    `;
    const failRate = parseInt(failureStats.total) > 0
      ? parseInt(failureStats.failed) / parseInt(failureStats.total)
      : 0;
    const highFailureRate = failRate > 0.2 && parseInt(failureStats.total) >= 5;

    // ========================================================================
    // CHECK 11: Chain dispatch gaps
    // ========================================================================

    const chainGaps = await sql`
      SELECT aa.agent as source_agent, c.slug, c.github_repo
      FROM agent_actions aa
      JOIN companies c ON c.id = aa.company_id
      WHERE aa.status = 'success' AND aa.agent = 'ceo'
      AND aa.output::text ILIKE '%needs_feature%true%'
      AND aa.finished_at > NOW() - INTERVAL '48 hours'
      AND c.github_repo IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM agent_actions aa2
        WHERE aa2.agent = 'engineer' AND aa2.company_id = aa.company_id
        AND aa2.started_at > aa.finished_at
        AND aa2.started_at < aa.finished_at + INTERVAL '30 minutes'
      )
    `;

    // ========================================================================
    // CHECK 12: Stalled companies (72h no activity)
    // ========================================================================

    const stalledCompanies = await sql`
      SELECT c.slug, c.id as company_id, MAX(aa.finished_at) as last_activity
      FROM companies c
      LEFT JOIN agent_actions aa ON aa.company_id = c.id
      WHERE c.status IN ('mvp', 'active')
      AND EXISTS (SELECT 1 FROM infra i WHERE i.company_id = c.id)
      GROUP BY c.id, c.slug
      HAVING MAX(aa.finished_at) < NOW() - INTERVAL '72 hours'
        OR MAX(aa.finished_at) IS NULL
    `;

    // ========================================================================
    // CHECK 12c: Stale company tasks (approved but not worked on)
    // P0 stale after 24h, P1 after 3 days, P2 after 7 days
    // ========================================================================

    const staleTasks = await sql`
      SELECT c.slug, c.id as company_id, c.github_repo,
        ct.id as task_id, ct.title, ct.priority, ct.category,
        ct.created_at,
        EXTRACT(EPOCH FROM (NOW() - ct.created_at)) / 3600 as hours_old
      FROM company_tasks ct
      JOIN companies c ON c.id = ct.company_id
      WHERE ct.status IN ('approved', 'proposed')
      AND c.status IN ('mvp', 'active')
      AND (
        (ct.priority = 0 AND ct.created_at < NOW() - INTERVAL '24 hours')
        OR (ct.priority = 1 AND ct.created_at < NOW() - INTERVAL '3 days')
        OR (ct.priority = 2 AND ct.created_at < NOW() - INTERVAL '7 days')
      )
      ORDER BY ct.priority ASC, ct.created_at ASC
      LIMIT 10
    `;
    if (staleTasks.length > 0) {
      console.log(`[sentinel-dispatch] Stale tasks detected: ${staleTasks.length} tasks past SLA threshold`);
    }

    // ========================================================================
    // CHECK 12d: Company PR tracking — auto-complete tasks when PRs merge
    // Polls company repos for recently merged PRs with "Fixes #N" references
    // ========================================================================

    const companiesWithRepos = await ctx.sql`
      SELECT c.id, c.slug, c.github_repo FROM companies c
      WHERE c.status IN ('mvp', 'active') AND c.github_repo IS NOT NULL
    `.catch(() => []);

    for (const company of companiesWithRepos) {
      try {
        const { getRecentlyMergedPRs, extractFixesReferences } = await import("@/lib/github-issues");
        const mergedPRs = await getRecentlyMergedPRs(company.github_repo, 2);
        for (const pr of mergedPRs) {
          const fixedIssues = extractFixesReferences(pr.title + " " + pr.body);
          if (fixedIssues.length === 0) continue;

          // Find company_tasks linked to these issue numbers and mark done
          for (const issueNum of fixedIssues) {
            await ctx.sql`
              UPDATE company_tasks
              SET status = 'done', pr_number = ${pr.number},
                  pr_url = ${"https://github.com/" + company.github_repo + "/pull/" + pr.number},
                  updated_at = NOW()
              WHERE company_id = ${company.id}
              AND github_issue_number = ${issueNum}
              AND status != 'done'
            `.catch(() => {});
            // Sync company GitHub Issue (fire-and-forget)
            import("@/lib/github-issues").then(({ syncCompanyTaskStatus }) =>
              syncCompanyTaskStatus(company.github_repo, issueNum, "done")
            ).catch(() => {});
          }
        }

        // Also check Hive repo PRs for backlog items
        if (company.github_repo === "carloshmiranda/hive") {
          for (const pr of mergedPRs) {
            const fixedIssues = extractFixesReferences(pr.title + " " + pr.body);
            for (const issueNum of fixedIssues) {
              await ctx.sql`
                UPDATE hive_backlog
                SET status = 'done', pr_number = ${pr.number},
                    pr_url = ${"https://github.com/carloshmiranda/hive/pull/" + pr.number},
                    completed_at = NOW()
                WHERE github_issue_number = ${issueNum}
                AND status NOT IN ('done', 'rejected')
              `.catch(() => {});
              // Sync backlog GitHub Issue (fire-and-forget)
              import("@/lib/github-issues").then(({ syncBacklogStatus }) =>
                syncBacklogStatus(issueNum, "done")
              ).catch(() => {});
            }
          }
        }
      } catch (e: any) {
        console.warn(`[sentinel-dispatch] PR tracking for ${company.slug} failed: ${e?.message || e}`);
      }
    }

    // ========================================================================
    // CHECK 13: Companies needing new cycle — ranked by priority score
    // ========================================================================

    const needsCycle = await sql`
      WITH company_signals AS (
        SELECT
          c.slug,
          c.id as company_id,
          c.status,
          COALESCE((SELECT COUNT(*) FROM company_tasks ct
            WHERE ct.company_id = c.id AND ct.status IN ('proposed', 'approved')), 0) AS pending_tasks,
          COALESCE(EXTRACT(EPOCH FROM (NOW() - (
            SELECT MAX(cy.finished_at) FROM cycles cy
            WHERE cy.company_id = c.id AND cy.status = 'completed'
          ))) / 86400.0, 30) AS days_since_cycle,
          COALESCE((SELECT COUNT(*) FROM cycles cy
            WHERE cy.company_id = c.id AND cy.status = 'completed'), 0) AS total_cycles,
          (SELECT (cy.ceo_review->>'score')::int FROM cycles cy
            WHERE cy.company_id = c.id AND cy.ceo_review IS NOT NULL
            ORDER BY cy.finished_at DESC LIMIT 1) AS last_score,
          EXISTS(SELECT 1 FROM directives d
            WHERE d.company_id = c.id AND d.status = 'open') AS has_directive,
          EXISTS(SELECT 1 FROM metrics m
            WHERE m.company_id = c.id AND m.mrr > 0
            AND m.date > NOW() - INTERVAL '30 days') AS has_revenue,
          COALESCE((c.capabilities->'database'->>'exists')::boolean, false) AS database_exists
        FROM companies c
        WHERE c.status IN ('mvp', 'active')
        AND EXISTS (SELECT 1 FROM infra i WHERE i.company_id = c.id)
        AND NOT EXISTS (
          SELECT 1 FROM cycles cy
          WHERE cy.company_id = c.id
          AND cy.status IN ('running', 'completed')
          AND cy.started_at > NOW() - INTERVAL '24 hours'
        )
      )
      SELECT slug, company_id, database_exists,
        (
          (pending_tasks * 2)
          + (LEAST(days_since_cycle, 14) * 3)
          + (CASE WHEN total_cycles = 0 THEN 10 ELSE 0 END)
          + (CASE WHEN last_score IS NOT NULL AND last_score < 5 THEN 5 ELSE 0 END)
          + (CASE WHEN has_directive THEN 15 ELSE 0 END)
          + (CASE WHEN status = 'mvp' AND total_cycles < 3 THEN 8 ELSE 0 END)
          - (LEAST(total_cycles, 20) * 0.5)
        ) AS priority_score
      FROM company_signals
      WHERE database_exists = true
      ORDER BY priority_score DESC
    `;

    // ========================================================================
    // 13b2: Task stealability — stale running agent_actions (stuck >1h)
    // ========================================================================

    const staleRunning = await sql`
      UPDATE agent_actions
      SET status = 'failed',
          error = 'Stale: marked failed by Sentinel after 1h+ in running state (likely GitHub Actions crash/timeout)',
          finished_at = NOW()
      WHERE status = 'running'
      AND started_at < NOW() - INTERVAL '1 hour'
      AND agent IN ('engineer', 'growth', 'ceo', 'scout', 'healer', 'evolver')
      RETURNING id, agent, company_id
    `;
    if (staleRunning.length > 0) {
      console.log(`[sentinel-dispatch] Task stealability: marked ${staleRunning.length} stale running actions as failed`);
    }

    // ========================================================================
    // 13b: Stuck cycles (running >2h, auto-cleanup)
    // ========================================================================

    const stuckCycles = await sql`
      SELECT id, cycle_number, company_id
      FROM cycles
      WHERE status = 'running' AND started_at < NOW() - INTERVAL '2 hours'
    `;
    for (const cycle of stuckCycles) {
      try {
        const cleanupUrl = process.env.NEXT_PUBLIC_URL || 'https://hive-phi.vercel.app';
        const response = await fetch(`${cleanupUrl}/api/cycles/${cycle.id}/cleanup`, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${process.env.CRON_SECRET}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            cleanup_reason: 'Cycle stuck in running state >2h, cleaned up by Sentinel',
            status: 'failed'
          })
        });
        if (!response.ok) {
          console.error(`[sentinel-dispatch] Failed to cleanup cycle ${cycle.id}: ${response.status}`);
        }
      } catch (error) {
        console.error(`[sentinel-dispatch] Error cleaning up cycle ${cycle.id}:`, error);
      }
    }

    // ========================================================================
    // 13c-pre: Failed agent tasks with unfinished CEO plan work — detect for re-dispatch
    // ========================================================================

    const failedWithPlanWork = await sql`
      SELECT DISTINCT ON (aa.company_id, aa.agent)
        aa.id as action_id, aa.agent, aa.action_type, aa.error, aa.company_id, c.slug, c.github_repo
      FROM agent_actions aa
      JOIN companies c ON c.id = aa.company_id
      WHERE aa.status = 'failed'
      AND aa.agent IN ('engineer', 'growth')
      AND aa.finished_at > NOW() - INTERVAL '12 hours'
      AND c.status IN ('mvp', 'active')
      AND c.github_repo IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM agent_actions aa2
        WHERE aa2.company_id = aa.company_id
        AND aa2.agent = aa.agent
        AND aa2.status = 'success'
        AND aa2.started_at > aa.finished_at
      )
      AND NOT EXISTS (
        SELECT 1 FROM agent_actions aa3
        WHERE aa3.company_id = aa.company_id
        AND aa3.agent = aa.agent
        AND aa3.action_type = 'sentinel_retry'
        AND aa3.started_at > NOW() - INTERVAL '6 hours'
      )
      ORDER BY aa.company_id, aa.agent, aa.finished_at DESC
    `;

    // ========================================================================
    // DISPATCH LOGIC
    // ========================================================================

    // Pre-fetch all open circuit breakers in one query (O(1) instead of O(N))
    const openCircuits = await batchCheckCircuits(sql);

    // 1. Pipeline low → Scout (if not blocked by proposal backlog)
    if (pipelineLow) {
      await dispatchToActions(ctx, "pipeline_low", { source: "sentinel", trace_id: traceId });
      dispatches.push({ type: "brain", target: "pipeline_low", payload: { source: "sentinel" } });
    } else if (scoutBlocked) {
      console.log(`[sentinel-dispatch] Scout blocked: ${pendingProposals.cnt} pending, ${staleProposals.cnt} stale proposals`);
    }

    // 1b. Open PRs → CEO brain (highest priority — before growth/content/cycles)
    // Checks both the approvals table (webhook-driven) and backlog pr_open items (webhook-missed)
    const prToReview = pendingPrReviews[0] ?? null;
    const backlogPrToReview = backlogOpenPrs[0] ?? null;

    if (prToReview) {
      const prContext = typeof prToReview.context === 'string' ? JSON.parse(prToReview.context) : prToReview.context;
      await dispatchToActions(ctx, "ceo_review", {
        source: "sentinel_pr_review",
        company: prToReview.slug,
        pr_number: prContext?.pr_number,
        pr_url: prContext?.pr_url,
        approval_id: prToReview.id,
        trace_id: traceId,
      });
      dispatches.push({ type: "brain", target: "ceo_review", payload: { company: prToReview.slug, pr_number: prContext?.pr_number } });
    } else if (backlogPrToReview) {
      // PR exists in backlog but no approval record — dispatch CEO directly
      await dispatchToActions(ctx, "ceo_review", {
        source: "sentinel_backlog_pr",
        company: backlogPrToReview.slug,
        pr_number: backlogPrToReview.pr_number,
        pr_url: backlogPrToReview.pr_url,
        trace_id: traceId,
      });
      dispatches.push({ type: "brain", target: "ceo_review", payload: { company: backlogPrToReview.slug, pr_number: backlogPrToReview.pr_number } });
    }

    // 2. Stale content → Growth on company repo (free Actions) with Vercel fallback
    for (let i = 0; i < staleContent.length; i++) {
      const r = staleContent[i];
      // Circuit breaker: skip if growth has 3+ failures for this company in 24h
      const [staleCompany] = await sql`SELECT id FROM companies WHERE slug = ${r.slug} LIMIT 1`;
      if (staleCompany && openCircuits.has(`growth:${staleCompany.id}`)) {
        await sql`
          INSERT INTO agent_actions (agent, company_id, action_type, status, description, started_at, finished_at)
          VALUES ('growth', ${staleCompany.id}, 'circuit_breaker', 'success',
            ${"Circuit breaker open: skipping growth for " + r.slug + " (3+ failures in 24h)"},
            NOW(), NOW())
        `;
        ctx.circuitBreaks++;
        dispatches.push({ type: "circuit_breaker", target: "growth", payload: { company: r.slug, reason: "3+_failures_24h" } });
        continue;
      }
      if (r.github_repo) {
        try {
          await dispatchToCompanyWorkflow(ctx, r.github_repo as string, "hive-growth.yml", {
            company_slug: r.slug as string,
            trigger: "sentinel_stale_content",
            task_summary: `Content refresh for ${r.slug}`,
          });
          dispatches.push({ type: "company_actions", target: "growth", payload: { company: r.slug, repo: r.github_repo } });
          continue;
        } catch {
          // Fall through to Vercel serverless
        }
      }
      await dispatchToWorker(ctx, "growth", r.slug as string, "sentinel_stale_content");
      dispatches.push({ type: "worker", target: "growth", payload: { company: r.slug } });

      // Add 1-second stagger between Growth dispatches to avoid API rate limits
      if (i < staleContent.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // 3. Stale leads → Outreach worker
    for (let i = 0; i < staleLeads.length; i++) {
      const r = staleLeads[i];
      await dispatchToWorker(ctx, "outreach", r.slug as string, "sentinel_stale_leads");
      dispatches.push({ type: "worker", target: "outreach", payload: { company: r.slug } });

      // Add 1-second stagger between Outreach dispatches to avoid API rate limits
      if (i < staleLeads.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // 4. No CEO review → CEO brain
    if (noCeoReview.length > 0) {
      const slug = noCeoReview[0].slug;
      await dispatchToActions(ctx, "ceo_review", { source: "sentinel", company: slug, trace_id: traceId });
      dispatches.push({ type: "brain", target: "ceo_review", payload: { company: slug } });
    }

    // 5. Unverified deploys → Ops worker (staggered to avoid Groq rate limits)
    for (let i = 0; i < unverifiedDeploys.length; i++) {
      const r = unverifiedDeploys[i];
      await dispatchToWorker(ctx, "ops", r.slug as string, "sentinel_unverified_deploy");
      dispatches.push({ type: "worker", target: "health_check", payload: { company: r.slug } });

      // Add 2-second stagger between concurrent Ops dispatches to avoid Groq 429s
      if (i < unverifiedDeploys.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    // 7. High failure rate → Evolver brain (urgent) + Healer (fix code)
    const [lastEvolverDispatch] = await sql`
      SELECT MAX(started_at) as last_run FROM agent_actions
      WHERE agent = 'evolver' AND started_at > NOW() - INTERVAL '24 hours'
    `;
    if (highFailureRate && !lastEvolverDispatch?.last_run) {
      await dispatchToActions(ctx, "evolve_trigger", { source: "sentinel", reason: "high_failure_rate", trace_id: traceId });
      dispatches.push({ type: "brain", target: "evolve_trigger", payload: { reason: "high_failure_rate" } });

      const [lastHealerRun] = await sql`
        SELECT MAX(started_at) as last_run FROM agent_actions
        WHERE agent = 'healer' AND started_at > NOW() - INTERVAL '6 hours'
      `;

      if (!lastHealerRun?.last_run) {
        // NEW: Get companies with recent failures to check per-company circuit breaker
        const companiesWithFailures = await sql`
          SELECT DISTINCT company_id FROM agent_actions
          WHERE status = 'failed'
            AND finished_at > NOW() - INTERVAL '48 hours'
            AND agent NOT IN ('healer', 'sentinel')
            AND company_id IS NOT NULL
        `;

        // Check per-company healer circuit breakers
        let allCompaniesBlocked = true;
        let totalCompanies = 0;
        let blockedCompanies = 0;

        for (const row of companiesWithFailures) {
          totalCompanies++;
          const circuitCheck = await checkHealerCompanyCircuitBreaker(sql, row.company_id);
          if (circuitCheck.blocked) {
            blockedCompanies++;
            const [company] = await sql`SELECT slug FROM companies WHERE id = ${row.company_id} LIMIT 1`;
            console.warn(`[sentinel-dispatch] Healer circuit breaker (check 7, ${company?.slug || row.company_id}): ${circuitCheck.reason}`);
          } else {
            allCompaniesBlocked = false;
          }
        }

        // Only dispatch healer if at least one company is not blocked
        if (totalCompanies === 0 || !allCompaniesBlocked) {
          await dispatchToActions(ctx, "healer_trigger", { source: "sentinel", scope: "systemic", reason: "high_failure_rate", trace_id: traceId });
          dispatches.push({ type: "brain", target: "healer_trigger", payload: { reason: "high_failure_rate" } });
          if (blockedCompanies > 0) {
            console.log(`[sentinel-dispatch] Healer dispatched despite ${blockedCompanies}/${totalCompanies} companies blocked — others still need healing`);
          }
        } else {
          console.warn(`[sentinel-dispatch] Healer skipped (check 7): all ${blockedCompanies} companies with failures are circuit-breaker blocked`);
        }
      }
    }

    // 7b. Errors exist but below 20% threshold → Healer only (no Evolver)
    if (!highFailureRate && parseInt(failureStats.failed) >= 3) {
      const [lastHeal] = await sql`
        SELECT MAX(finished_at) as last_run FROM agent_actions
        WHERE agent = 'healer' AND finished_at > NOW() - INTERVAL '24 hours'
      `;

      if (!lastHeal?.last_run) {
        // NEW: Get companies with recent failures to check per-company circuit breaker
        const companiesWithFailures = await sql`
          SELECT DISTINCT company_id FROM agent_actions
          WHERE status = 'failed'
            AND finished_at > NOW() - INTERVAL '48 hours'
            AND agent NOT IN ('healer', 'sentinel')
            AND company_id IS NOT NULL
        `;

        // Check per-company healer circuit breakers
        let allCompaniesBlocked = true;
        let totalCompanies = 0;
        let blockedCompanies = 0;

        for (const row of companiesWithFailures) {
          totalCompanies++;
          const circuitCheck = await checkHealerCompanyCircuitBreaker(sql, row.company_id);
          if (circuitCheck.blocked) {
            blockedCompanies++;
            const [company] = await sql`SELECT slug FROM companies WHERE id = ${row.company_id} LIMIT 1`;
            console.warn(`[sentinel-dispatch] Healer circuit breaker (check 7b, ${company?.slug || row.company_id}): ${circuitCheck.reason}`);
          } else {
            allCompaniesBlocked = false;
          }
        }

        // Only dispatch healer if at least one company is not blocked
        if (totalCompanies === 0 || !allCompaniesBlocked) {
          await dispatchToActions(ctx, "healer_trigger", { source: "sentinel", scope: "systemic", reason: "errors_detected", trace_id: traceId });
          dispatches.push({ type: "brain", target: "healer_trigger", payload: { reason: "errors_detected" } });
          if (blockedCompanies > 0) {
            console.log(`[sentinel-dispatch] Healer dispatched despite ${blockedCompanies}/${totalCompanies} companies blocked — others still need healing`);
          }
        } else {
          console.warn(`[sentinel-dispatch] Healer skipped (check 7b): all ${blockedCompanies} companies with failures are circuit-breaker blocked`);
        }
      }
    }

    // 11. Chain dispatch gaps → dispatch directly to company repo (free Actions)
    for (const r of chainGaps) {
      const [gapCompany] = await sql`SELECT id FROM companies WHERE slug = ${r.slug} LIMIT 1`;
      if (gapCompany && openCircuits.has(`engineer:${gapCompany.id}`)) {
        await sql`
          INSERT INTO agent_actions (agent, company_id, action_type, status, description, started_at, finished_at)
          VALUES ('engineer', ${gapCompany.id}, 'circuit_breaker', 'success',
            ${"Circuit breaker open: skipping engineer chain gap recovery for " + r.slug + " (3+ failures in 24h)"},
            NOW(), NOW())
        `;
        ctx.circuitBreaks++;
        dispatches.push({ type: "circuit_breaker", target: "engineer", payload: { company: r.slug, reason: "3+_failures_24h" } });
        continue;
      }
      if (r.github_repo) {
        await dispatchToCompanyWorkflow(ctx, r.github_repo as string, "hive-build.yml", {
          company_slug: r.slug as string,
          trigger: "feature_request",
          task_summary: "Chain gap recovery — CEO planned features not yet built",
        });
        dispatches.push({ type: "company_actions", target: "feature_request", payload: { company: r.slug, repo: r.github_repo } });
      } else {
        await dispatchToActions(ctx, "feature_request", { source: "sentinel_recovery", company: r.slug, trace_id: traceId });
        dispatches.push({ type: "brain", target: "feature_request", payload: { company: r.slug } });
      }
    }

    // 12. Stalled companies → escalation approval + force cycle
    for (const r of stalledCompanies) {
      await sql`
        INSERT INTO approvals (company_id, gate_type, title, description, context)
        VALUES (
          ${r.company_id}, 'escalation',
          ${"Stalled: " + r.slug + " — no activity in 72h"},
          'Company has infrastructure but no agent has run successfully in 72+ hours. The dispatch chain may be broken.',
          ${JSON.stringify({ last_activity: r.last_activity, detected_by: "sentinel-dispatch" })}::jsonb
        )
        ON CONFLICT DO NOTHING
      `;
      await dispatchToActions(ctx, "research_request", {
        source: "sentinel_stalled",
        company: r.slug,
        company_id: r.company_id,
        trace_id: traceId,
      });
      dispatches.push({ type: "brain", target: "research_request", payload: { company: r.slug, reason: "stalled" } });
    }

    // 13c-pre. Backfill NULL errors from GitHub Actions API before retrying
    for (const r of failedWithPlanWork) {
      if (!r.error && r.github_repo && ghPat) {
        try {
          const runsRes = await fetch(
            `https://api.github.com/repos/${r.github_repo}/actions/runs?per_page=5&status=failure`,
            { headers: { Authorization: `Bearer ${ghPat}`, Accept: "application/vnd.github.v3+json" }, signal: AbortSignal.timeout(10000) }
          );
          if (runsRes.ok) {
            const runs = await runsRes.json();
            const latestFail = runs.workflow_runs?.[0];
            if (latestFail) {
              await sql`
                UPDATE agent_actions SET error = ${`GitHub Actions: ${latestFail.conclusion} — ${latestFail.name} (run ${latestFail.id})`}
                WHERE id = ${r.action_id} AND error IS NULL
              `;
            }
          }
        } catch (e: any) { console.warn(`[sentinel-dispatch] check 13c-pre: backfill error failed: ${e?.message || e}`); }
      }
    }

    // 13c. Failed agent tasks → re-dispatch directly to company repo (free Actions)
    for (const r of failedWithPlanWork) {
      // Circuit breaker: skip if 3+ failures for this agent+company in 24h
      if (openCircuits.has(`${r.agent}:${r.company_id}`)) {
        await sql`
          INSERT INTO agent_actions (agent, company_id, action_type, status, description, started_at, finished_at)
          VALUES (${r.agent}, ${r.company_id}, 'circuit_breaker', 'success',
            ${"Circuit breaker open: skipping " + r.agent + " retry for " + r.slug + " (3+ failures in 24h)"},
            NOW(), NOW())
        `;
        ctx.circuitBreaks++;
        dispatches.push({ type: "circuit_breaker", target: r.agent as string, payload: { company: r.slug, reason: "3+_failures_24h" } });
        continue;
      }
      if (r.github_repo && r.agent === "engineer") {
        await dispatchToCompanyWorkflow(ctx, r.github_repo as string, "hive-build.yml", {
          company_slug: r.slug as string,
          trigger: "feature_request",
          task_summary: "Retry — previous build failed",
        });
        dispatches.push({ type: "company_actions", target: "feature_request", payload: { company: r.slug, reason: "failed_task_recovery" } });
      } else if (r.github_repo && r.agent === "growth") {
        await dispatchToCompanyWorkflow(ctx, r.github_repo as string, "hive-growth.yml", {
          company_slug: r.slug as string,
          trigger: "sentinel_retry",
          task_summary: "Retry — previous growth run failed",
        });
        dispatches.push({ type: "company_actions", target: "growth", payload: { company: r.slug, reason: "failed_task_recovery" } });
      } else {
        const eventType = r.agent === "engineer" ? "feature_request" : "growth_trigger";
        await dispatchToActions(ctx, eventType, {
          source: "sentinel_retry",
          company: r.slug,
          company_id: r.company_id,
          reason: "failed_task_recovery",
          trace_id: traceId,
        });
        dispatches.push({ type: "brain", target: eventType, payload: { company: r.slug, reason: "failed_task_recovery" } });
      }
      // Log the retry so we don't re-dispatch again for 6h
      await sql`
        INSERT INTO agent_actions (agent, company_id, action_type, status, description, started_at, finished_at)
        VALUES (${r.agent}, ${r.company_id}, 'sentinel_retry', 'success',
          ${"Sentinel re-dispatched " + r.agent + " for " + r.slug + " after failed task (plan work preserved in cycles table)"},
          NOW(), NOW())
      `;
    }

    // ========================================================================
    // BUDGET CHECK + HIVE-FIRST PRIORITIZATION
    // ========================================================================

    const dailyUsage = await sql`
      SELECT COUNT(*) as action_count,
        COALESCE(SUM(tokens_used), 0) as total_turns
      FROM agent_actions
      WHERE agent IN ('ceo', 'scout', 'engineer', 'evolver', 'healer')
      AND started_at > NOW() - INTERVAL '5 hours'
    `;
    const turnsUsed = Number(dailyUsage[0]?.total_turns || 0);
    const budgetCeiling = 225; // Claude Max 5x ~225 messages per 5h window
    const budgetUsedPct = turnsUsed / budgetCeiling;

    // Throttle: >90% budget → skip all, >70% → max 1, otherwise max 2
    let remainingSlots = budgetUsedPct > 0.9 ? 0 : budgetUsedPct > 0.7 ? 1 : MAX_CYCLE_DISPATCHES;

    // ========================================================================
    // CHECK 13a: HIVE-FIRST TRIAGE
    // ========================================================================

    let hiveFixesDispatched = 0;
    try {
      // (A0) Auto-approve critical proposals pending >24h
      await sql`
        UPDATE evolver_proposals
        SET status = 'approved', decided_at = NOW(), notes = 'Auto-approved: critical severity pending >24h'
        WHERE status = 'pending'
          AND severity = 'critical'
          AND created_at < NOW() - INTERVAL '24 hours'
          AND created_at > NOW() - INTERVAL '14 days'
      `.catch((e: any) => { console.warn(`[sentinel-dispatch] check 13a: auto-approve critical proposals failed: ${e?.message || e}`); });

      // (A) Approved self-improvement proposals → route to hive_backlog
      const approvedImprovements = await sql`
        SELECT id, title, proposed_fix, severity
        FROM evolver_proposals
        WHERE status = 'approved'
          AND implemented_at IS NULL
          AND created_at > NOW() - INTERVAL '14 days'
        ORDER BY
          CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
          created_at ASC
        LIMIT 2
      `.catch((e: any) => { console.warn(`[sentinel-dispatch] check 13a: fetch approved improvements failed: ${e?.message || e}`); return []; });

      // (B) Systemic errors — same error in 2+ companies in last 48h
      const systemicErrors = await sql`
        SELECT error, agent, COUNT(DISTINCT company_id)::int as affected_companies,
          COUNT(*)::int as occurrences
        FROM agent_actions
        WHERE status = 'failed' AND error IS NOT NULL
          AND finished_at > NOW() - INTERVAL '48 hours'
          AND company_id IS NOT NULL
        GROUP BY error, agent
        HAVING COUNT(DISTINCT company_id) >= 2
        ORDER BY COUNT(*) DESC
        LIMIT 3
      `.catch((e: any) => { console.warn(`[sentinel-dispatch] check 13a: fetch systemic errors failed: ${e?.message || e}`); return []; });

      // (C) Agent failure rate — exclude 0-turn actions
      const failureRateResult = await sql`
        SELECT
          COUNT(*) FILTER (WHERE status = 'failed'
            AND NOT (
              (tokens_used = 0 OR tokens_used IS NULL)
              AND (error ILIKE '%unknown (0 turns)%'
                   OR error ILIKE '%exhausted after 0 turns%'
                   OR error ILIKE '%workflow file issue%'
                   OR error ILIKE '%syntax error%'
                   OR description ILIKE '%unknown (0 turns)%')
            )
          )::float /
          NULLIF(COUNT(*) FILTER (WHERE NOT (
            (tokens_used = 0 OR tokens_used IS NULL)
            AND (error ILIKE '%unknown (0 turns)%'
                 OR error ILIKE '%exhausted after 0 turns%'
                 OR error ILIKE '%workflow file issue%'
                 OR error ILIKE '%syntax error%'
                 OR description ILIKE '%unknown (0 turns)%')
          )), 0)::float as rate
        FROM agent_actions
        WHERE agent NOT IN ('sentinel', 'healer')
          AND finished_at > NOW() - INTERVAL '48 hours'
      `.catch((e: any) => { console.warn(`[sentinel-dispatch] check 13a: compute failure rate failed: ${e?.message || e}`); return [{ rate: 0 }]; });
      const overallFailureRate = Number(failureRateResult[0]?.rate || 0);

      const hiveFixNeeded = approvedImprovements.length > 0
        || (systemicErrors.length > 0 && overallFailureRate > 0.4);

      if (hiveFixNeeded && remainingSlots > 0) {
        // Route approved proposals through hive_backlog
        for (const proposal of approvedImprovements) {
          // Quality gate: reject vague proposals
          const proposalText = `${proposal.title} ${typeof proposal.proposed_fix === 'string' ? proposal.proposed_fix : JSON.stringify(proposal.proposed_fix)}`;
          const hasSpecificFile = /\b(src\/|\.ts|\.tsx|\.yml|\.json|route\.ts|page\.tsx)\b/.test(proposalText);
          const hasActionableVerb = /\b(add|remove|change|update|fix|replace|create|delete|move|rename|insert|wrap|extract)\b/i.test(proposalText);
          const isLongEnough = proposalText.length >= 80;
          if (!hasSpecificFile && !hasActionableVerb) {
            await sql`
              UPDATE evolver_proposals SET status = 'rejected',
                notes = COALESCE(notes, '') || ' | Auto-rejected: proposal lacks specific file paths or actionable implementation steps. Resubmit with concrete code changes.'
              WHERE id = ${proposal.id}
            `.catch((e: any) => { console.warn(`[sentinel-dispatch] reject vague proposal ${proposal.id} failed: ${e?.message || e}`); });
            console.log(`[sentinel-dispatch] Rejected vague evolver proposal ${proposal.id}: "${(proposal.title as string).slice(0, 60)}"`);
            continue;
          }
          if (!isLongEnough && !hasSpecificFile) {
            await sql`
              UPDATE evolver_proposals SET status = 'rejected',
                notes = COALESCE(notes, '') || ' | Auto-rejected: description too short and lacks file references. Need specific implementation details.'
              WHERE id = ${proposal.id}
            `.catch((e: any) => { console.warn(`[sentinel-dispatch] reject short proposal ${proposal.id} failed: ${e?.message || e}`); });
            console.log(`[sentinel-dispatch] Rejected short evolver proposal ${proposal.id}: "${(proposal.title as string).slice(0, 60)}"`);
            continue;
          }

          // Check if already in backlog (prevent duplicates)
          const [existing] = await sql`
            SELECT id FROM hive_backlog
            WHERE title ILIKE ${proposal.title.slice(0, 50) + "%"}
              AND status NOT IN ('done', 'rejected')
            LIMIT 1
          `.catch((e: any) => { console.warn(`[sentinel-dispatch] check backlog dedup for proposal ${proposal.id} failed: ${e?.message || e}`); return []; });
          if (existing) {
            await sql`
              UPDATE evolver_proposals SET implemented_at = NOW(),
                notes = COALESCE(notes, '') || ' | Already in hive_backlog, marked implemented'
              WHERE id = ${proposal.id}
            `.catch((e: any) => { console.warn(`[sentinel-dispatch] mark proposal ${proposal.id} as already in backlog failed: ${e?.message || e}`); });
            continue;
          }

          const priority = proposal.severity === "critical" ? "P0" : proposal.severity === "high" ? "P1" : "P2";
          await sql`
            INSERT INTO hive_backlog (title, description, priority, category, status)
            VALUES (
              ${(proposal.title as string).slice(0, 200)},
              ${`Source: evolver proposal ${proposal.id}\n${typeof proposal.proposed_fix === 'string' ? proposal.proposed_fix : JSON.stringify(proposal.proposed_fix)}`},
              ${priority}, 'infra', 'ready'
            )
          `.catch((e: any) => { console.warn(`[sentinel-dispatch] insert backlog item from proposal ${proposal.id} failed: ${e?.message || e}`); });
          await sql`
            UPDATE evolver_proposals SET implemented_at = NOW(),
              notes = COALESCE(notes, '') || ' | Routed to hive_backlog for planning + dispatch'
            WHERE id = ${proposal.id}
          `.catch((e: any) => { console.warn(`[sentinel-dispatch] mark proposal ${proposal.id} as routed to backlog failed: ${e?.message || e}`); });
          dispatches.push({
            type: "brain",
            target: "hive_self_fix",
            payload: { proposal_id: proposal.id, title: proposal.title, severity: proposal.severity, routed: "backlog" },
          });
          hiveFixesDispatched++;
        }

        // If high systemic failure rate and still have budget, dispatch healer
        const healerRecentFailures = await sql`
          SELECT COUNT(*)::int as cnt FROM agent_actions
          WHERE agent = 'healer' AND status = 'failed'
          AND finished_at > NOW() - INTERVAL '48 hours'
        `.catch(() => [{ cnt: 0 }]);
        const healerFailCount = healerRecentFailures[0]?.cnt ?? 0;

        if (systemicErrors.length > 0 && overallFailureRate > 0.4 && remainingSlots > 0 && healerFailCount < 3) {
          const errorSummary = systemicErrors
            .map((e: any) => `${e.agent}: "${(e.error as string).slice(0, 80)}" (${e.affected_companies} companies, ${e.occurrences}x)`)
            .join("; ");
          await dispatchToActions(ctx, "healer_trigger", {
            source: "sentinel_hive_triage",
            scope: "systemic",
            reason: `Systemic failures (${Math.round(overallFailureRate * 100)}% failure rate): ${errorSummary.slice(0, 500)}`,
            trace_id: traceId,
          });
          dispatches.push({
            type: "brain",
            target: "healer_systemic",
            payload: { failure_rate: overallFailureRate, systemic_errors: systemicErrors.length },
          });
          hiveFixesDispatched++;
          remainingSlots--;
        } else if (healerFailCount >= 3) {
          console.warn(`[sentinel-dispatch] Healer circuit breaker (systemic): ${healerFailCount} healer failures in 48h — skipping dispatch`);
          await sql`
            INSERT INTO agent_actions (agent, action_type, description, status, started_at, finished_at)
            VALUES ('sentinel', 'healer_circuit_breaker', ${`Systemic healer skipped: ${healerFailCount} failures in 48h (failure rate: ${Math.round(overallFailureRate * 100)}%)`}, 'success', NOW(), NOW())
          `.catch(() => {});
        }

        // ========================================================================
        // CHECK 13b: Cross-company task deduplication
        // ========================================================================

        try {
          const crossCompanyUrl = `${ctx.baseUrl}/api/agents/cross-company-tasks`;
          const crossCompanyResponse = await fetch(crossCompanyUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${ctx.cronSecret}`
            }
          });

          if (crossCompanyResponse.ok) {
            const crossCompanyResult = await crossCompanyResponse.json();
            if (crossCompanyResult.consolidated_tasks_created > 0) {
              console.log(`[sentinel-dispatch] Cross-company: created ${crossCompanyResult.consolidated_tasks_created} consolidated tasks`);
              await sql`
                INSERT INTO agent_actions (agent, action_type, description, status, started_at, finished_at)
                VALUES ('sentinel', 'cross_company_dedup', ${`Cross-company deduplication: created ${crossCompanyResult.consolidated_tasks_created} consolidated tasks from ${crossCompanyResult.detected_issues} patterns`}, 'success', NOW(), NOW())
              `;
              dispatches.push({
                type: "cross_company",
                target: "task_deduplication",
                payload: {
                  consolidated_tasks: crossCompanyResult.consolidated_tasks_created,
                  detected_issues: crossCompanyResult.detected_issues
                }
              });
            }
          }
        } catch (crossCompanyError: any) {
          console.warn(`[sentinel-dispatch] Cross-company deduplication failed: ${crossCompanyError?.message || crossCompanyError}`);
        }

        if (hiveFixesDispatched > 0) {
          await sql`
            INSERT INTO agent_actions (agent, action_type, description, status, started_at, finished_at)
            VALUES ('sentinel', 'hive_triage', ${`Hive-first: dispatched ${hiveFixesDispatched} fix(es) before company cycles. Failure rate: ${Math.round(overallFailureRate * 100)}%, approved proposals: ${approvedImprovements.length}, systemic errors: ${systemicErrors.length}`}, 'success', NOW(), NOW())
          `.catch((e: any) => { console.warn(`[sentinel-dispatch] log hive triage action failed: ${e?.message || e}`); });
        }
      }
    } catch (e: unknown) {
      console.warn("[sentinel-dispatch] Check 13a (hive-first triage) failed:", e instanceof Error ? e.message : String(e));
    }

    // ========================================================================
    // CHECK 13b: Backlog dispatch (with chain stall detection)
    // ========================================================================

    // Chain health check: if ready items exist but nothing dispatched recently
    // and no Engineer is running, the chain is stalled — restart it regardless
    // of remaining budget slots (Sentinel becomes a gap detector).
    let chainStalled = false;
    try {
      const [readyCount] = await sql`
        SELECT COUNT(*)::int as cnt FROM hive_backlog WHERE status IN ('ready', 'approved')
      `.catch(() => [{ cnt: 0 }]);
      const [runningEngineer] = await sql`
        SELECT id FROM agent_actions
        WHERE agent = 'engineer' AND status = 'running'
        AND action_type IN ('feature_request', 'self_improvement')
        AND company_id IS NULL
        AND started_at > NOW() - INTERVAL '1 hour'
        LIMIT 1
      `.catch(() => []);
      const [recentDispatch] = await sql`
        SELECT id FROM hive_backlog
        WHERE status = 'dispatched' AND dispatched_at > NOW() - INTERVAL '30 minutes'
        LIMIT 1
      `.catch(() => []);

      if (Number(readyCount?.cnt || 0) > 0 && !runningEngineer && !recentDispatch) {
        chainStalled = true;
        console.log(`[sentinel-dispatch] Chain stalled: ${readyCount.cnt} ready items, no Engineer running, no recent dispatch — restarting`);
      }
    } catch (e: unknown) {
      console.warn("[sentinel-dispatch] Chain health check failed:", e instanceof Error ? e.message : String(e));
    }

    let backlogDispatched = 0;
    try {
      if (remainingSlots > 0 || chainStalled) {
        const backlogUrl = `${process.env.NEXT_PUBLIC_URL || "https://hive-phi.vercel.app"}/api/backlog/dispatch`;
        const backlogRes = await fetch(backlogUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${cronSecret}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ source: "sentinel" }),
          signal: AbortSignal.timeout(60000),
        }).catch(() => null);

        if (backlogRes?.ok) {
          const backlogRaw = await backlogRes.json().catch(() => ({}));
          const backlogData = backlogRaw?.data ?? backlogRaw;
          if (backlogData?.dispatched) {
            dispatches.push({
              type: "brain",
              target: "hive_backlog_item",
              payload: {
                backlog_id: backlogData.item?.id,
                title: backlogData.item?.title,
                priority: backlogData.item?.priority,
                priority_score: backlogData.item?.priority_score,
              },
            });
            backlogDispatched++;
            remainingSlots--;
          }
        }
      }
    } catch (e: unknown) {
      console.warn("[sentinel-dispatch] Check 13b (backlog dispatch) failed:", e instanceof Error ? e.message : String(e));
    }

    // ========================================================================
    // CHECK 13c: Company cycle dispatch — remaining budget after Hive fixes + backlog
    // ========================================================================

    for (const r of needsCycle) {
      if (cycleDispatches >= remainingSlots) break;
      await dispatchToActions(ctx, "research_request", {
        source: "sentinel_cycle",
        company: r.slug,
        company_id: r.company_id,
        chain_to_ceo: true,
        trace_id: traceId,
      });
      dispatches.push({
        type: "brain",
        target: "cycle_start",
        payload: { company: r.slug, priority_score: r.priority_score },
      });
      cycleDispatches++;
    }

    // ========================================================================
    // RESPONSE
    // ========================================================================

    return Response.json({
      ok: true,
      tier: "dispatch",
      traceId,
      dispatches,
      dedupSkips: ctx.dedupSkips,
      circuitBreaks: ctx.circuitBreaks,
      budget: {
        turnsUsed,
        budgetCeiling,
        budgetUsedPct: Math.round(budgetUsedPct * 100),
        remainingSlots,
        cycleDispatches,
        backlogDispatched,
        hiveFixesDispatched,
      },
    });
  } catch (err: unknown) {
    console.error("[sentinel-dispatch] Fatal error:", err);
    return Response.json(
      {
        ok: false,
        tier: "dispatch",
        traceId,
        error: err instanceof Error ? err.message : String(err),
        dispatches,
        dedupSkips: ctx.dedupSkips,
        circuitBreaks: ctx.circuitBreaks,
      },
      { status: 500 }
    );
  }
}

export { GET as POST };
