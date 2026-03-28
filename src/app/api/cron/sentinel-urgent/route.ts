/**
 * Sentinel-Urgent — ADR-031 Phase 2 Sentinel split
 *
 * Runs every 2 hours. Handles infrastructure repair and time-critical checks
 * that cannot wait for the 4-hour dispatch cycle.
 *
 * Checks included:
 *   9/9b/9c  — Stuck approved, orphaned MVPs, missing Neon DB
 *   13b2     — Task stealability (stale running actions)
 *   13c-pre  — Backfill NULL errors from GitHub Actions API
 *   13c      — Re-dispatch failed agent tasks
 *   14       — Rate-limited agent retries
 *   15       — Unverified provisions (HTTP health check)
 *   16       — Missing metrics trigger + company-health delegate
 *   40       — Phantom PR cleanup
 *   41       — PR verification against GitHub API
 *   deploy   — Deploy drift (Vercel SHA vs GitHub main SHA)
 */

import { getDb } from "@/lib/db";
import { getSettingValue } from "@/lib/settings";
import { verifyCronAuth } from "@/lib/qstash";
import { setSentryTags } from "@/lib/sentry-tags";
import {
  dispatchToActions,
  dispatchToCompanyWorkflow,
  checkDeployDrift,
  checkDeployHealth,
  isCircuitOpen,
  batchCheckCircuits,
  REPO,
  type SentinelContext,
  type Dispatch,
} from "@/lib/sentinel-helpers";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  setSentryTags({
    action_type: "cron",
    route: "/api/cron/sentinel-urgent",
  });

  // Auth check — verifyCronAuth returns { authorized: boolean, ... }
  const auth = await verifyCronAuth(request);
  if (!auth.authorized) {
    return Response.json({ error: auth.error }, { status: 401 });
  }

  try {
    // Build context using shared helpers (minus the broken auth in initSentinelContext)
    const sql = getDb();
    const ghPat = await getSettingValue("github_token").catch(() => null);
    const vercelToken = await getSettingValue("vercel_token").catch(() => null);
    const baseUrl = process.env.NEXT_PUBLIC_URL || "https://hive-phi.vercel.app";
    const cronSecret = process.env.CRON_SECRET || "";
    const traceId = `sentinel-urgent-${Date.now().toString(36)}`;

    // Import getActiveClaims to build dedup state
    const { getActiveClaims } = await import("@/lib/sentinel-helpers");
    const activeClaims = await getActiveClaims(ghPat);

    const ctx: SentinelContext = {
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

    if (ctx.activeClaims.size > 0) {
      console.log(`[sentinel-urgent] Active claims (${ctx.activeClaims.size}): ${[...ctx.activeClaims].join(", ")}`);
    }

    // =========================================================================
    // Check 9: Stuck in 'approved' status (>1h)
    // =========================================================================
    const stuckApproved = await ctx.sql`
      SELECT slug FROM companies
      WHERE status = 'approved' AND updated_at < NOW() - INTERVAL '1 hour'
    `;

    for (const r of stuckApproved) {
      await dispatchToActions(ctx, "new_company", { source: "sentinel-urgent", company: r.slug, trace_id: ctx.traceId });
      ctx.dispatches.push({ type: "brain", target: "new_company", payload: { company: r.slug } });
    }

    // =========================================================================
    // Check 9b: Orphaned MVPs (status=mvp but no infra)
    // =========================================================================
    const orphanedMvps = await ctx.sql`
      SELECT c.slug FROM companies c
      WHERE c.status = 'mvp'
      AND NOT EXISTS (SELECT 1 FROM infra i WHERE i.company_id = c.id)
    `;

    for (const r of orphanedMvps) {
      await dispatchToActions(ctx, "new_company", { source: "sentinel-urgent", company: r.slug, reason: "orphaned_mvp", trace_id: ctx.traceId });
      ctx.dispatches.push({ type: "brain", target: "new_company", payload: { company: r.slug, reason: "orphaned_mvp" } });
    }

    // =========================================================================
    // Check 9c: MVPs with missing Neon DB
    // Skip companies with Vercel-managed DBs (neon_project_id is always NULL)
    // Also dedup: skip if repair was attempted in last 24h
    // =========================================================================
    const missingNeonDb = await ctx.sql`
      SELECT c.slug FROM companies c
      WHERE c.status IN ('mvp', 'active')
      AND c.neon_project_id IS NULL
      AND c.github_repo IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM infra i WHERE i.company_id = c.id AND i.service = 'vercel'
      )
      AND NOT EXISTS (
        SELECT 1 FROM agent_actions aa
        WHERE aa.company_id = c.id
        AND aa.action_type = 'infra_repair'
        AND aa.started_at > NOW() - INTERVAL '24 hours'
      )
    `;

    for (const r of missingNeonDb) {
      // Dedup: track infra_repair dispatches through the shared claims system
      // Previously bypassed dispatchToActions (direct HTTP), causing 100+/24h loops
      const repairKey = `infra_repair:${r.slug}`;
      if (ctx.dispatchedThisRun.has(repairKey) || ctx.activeClaims.has(repairKey)) {
        ctx.dedupSkips++;
        console.log(`[sentinel-urgent] Dedup skip (infra_repair): ${repairKey}`);
        continue;
      }
      ctx.dispatchedThisRun.add(repairKey);

      try {
        const repairRes = await fetch(`${ctx.baseUrl}/api/agents/repair-infra`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${ctx.cronSecret}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ company_slug: r.slug }),
          signal: AbortSignal.timeout(30000),
        });
        const repairData = await repairRes.json();
        ctx.dispatches.push({ type: "internal", target: "infra_repair", payload: { company: r.slug, result: repairData } });
      } catch (e: any) {
        console.error(`[sentinel-urgent] Infra repair failed for ${r.slug}: ${e.message}`);
      }
    }

    // =========================================================================
    // Check 13b2: Task stealability — stale running agent_actions (stuck >1h)
    // If a GitHub Actions run crashes without writing failure to Neon, the action
    // stays 'running' forever. Mark as 'failed' so retry logic in 13c can pick it up.
    // =========================================================================
    const staleRunning = await ctx.sql`
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
      console.log(`[sentinel-urgent] Task stealability: marked ${staleRunning.length} stale running actions as failed`);
    }

    // =========================================================================
    // Check 13c-pre: Backfill NULL errors from GitHub Actions API before retrying
    // =========================================================================
    const failedWithPlanWork = await ctx.sql`
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

    for (const r of failedWithPlanWork) {
      if (!r.error && r.github_repo && ctx.ghPat) {
        try {
          const runsRes = await fetch(
            `https://api.github.com/repos/${r.github_repo}/actions/runs?per_page=5&status=failure`,
            { headers: { Authorization: `token ${ctx.ghPat}`, Accept: "application/vnd.github.v3+json" }, signal: AbortSignal.timeout(10000) }
          );
          if (runsRes.ok) {
            const runs = await runsRes.json();
            const latestFail = runs.workflow_runs?.[0];
            if (latestFail) {
              await ctx.sql`
                UPDATE agent_actions SET error = ${`GitHub Actions: ${latestFail.conclusion} — ${latestFail.name} (run ${latestFail.id})`}
                WHERE id = ${r.action_id} AND error IS NULL
              `;
            }
          }
        } catch (e: any) { console.warn(`[sentinel-urgent] check 13c-pre: backfill error failed: ${e?.message || e}`); }
      }
    }

    // =========================================================================
    // Check 13c: Failed agent tasks → re-dispatch directly to company repo (free Actions)
    // =========================================================================
    // Pre-fetch all open circuit breakers in one query (O(1) instead of O(N))
    const openCircuits = await batchCheckCircuits(ctx.sql);

    for (const r of failedWithPlanWork) {
      // Circuit breaker: skip if 3+ failures for this agent+company in 24h
      if (openCircuits.has(`${r.agent}:${r.company_id}`)) {
        await ctx.sql`
          INSERT INTO agent_actions (agent, company_id, action_type, status, description, started_at, finished_at)
          VALUES (${r.agent}, ${r.company_id}, 'circuit_breaker', 'success',
            ${"Circuit breaker open: skipping " + r.agent + " retry for " + r.slug + " (3+ failures in 24h)"},
            NOW(), NOW())
        `;
        ctx.circuitBreaks++;
        ctx.dispatches.push({ type: "circuit_breaker", target: r.agent as string, payload: { company: r.slug, reason: "3+_failures_24h" } });
        continue;
      }
      if (r.github_repo && r.agent === "engineer") {
        await dispatchToCompanyWorkflow(ctx, r.github_repo as string, "hive-build.yml", {
          company_slug: r.slug as string,
          trigger: "feature_request",
          task_summary: "Retry — previous build failed",
        });
        ctx.dispatches.push({ type: "company_actions", target: "feature_request", payload: { company: r.slug, reason: "failed_task_recovery" } });
      } else if (r.github_repo && r.agent === "growth") {
        await dispatchToCompanyWorkflow(ctx, r.github_repo as string, "hive-growth.yml", {
          company_slug: r.slug as string,
          trigger: "sentinel_retry",
          task_summary: "Retry — previous growth run failed",
        });
        ctx.dispatches.push({ type: "company_actions", target: "growth", payload: { company: r.slug, reason: "failed_task_recovery" } });
      } else {
        // Fallback to Hive repo dispatch if no company repo
        const eventType = r.agent === "engineer" ? "feature_request" : "growth_trigger";
        await dispatchToActions(ctx, eventType, {
          source: "sentinel_retry",
          company: r.slug,
          company_id: r.company_id,
          reason: "failed_task_recovery",
          trace_id: ctx.traceId,
        });
        ctx.dispatches.push({ type: "brain", target: eventType, payload: { company: r.slug, reason: "failed_task_recovery" } });
      }
      // Log the retry so we don't re-dispatch again for 6h
      await ctx.sql`
        INSERT INTO agent_actions (agent, company_id, action_type, status, description, started_at, finished_at)
        VALUES (${r.agent}, ${r.company_id}, 'sentinel_retry', 'success',
          ${"Sentinel-urgent re-dispatched " + r.agent + " for " + r.slug + " after failed task (plan work preserved in cycles table)"},
          NOW(), NOW())
      `;
    }

    // =========================================================================
    // Check 14: Rate-limited agents (0 turns) → re-dispatch
    // =========================================================================
    const rateLimited = await ctx.sql`
      SELECT aa.agent, aa.action_type, aa.company_id, c.slug, c.github_repo
      FROM agent_actions aa
      INNER JOIN companies c ON c.id = aa.company_id
      WHERE aa.status = 'failed'
      AND aa.company_id IS NOT NULL
      AND c.status IN ('mvp', 'active')
      AND c.github_repo IS NOT NULL
      AND aa.error ILIKE '%exhausted after 0 turns%'
      AND aa.finished_at > NOW() - INTERVAL '6 hours'
      AND NOT EXISTS (
        SELECT 1 FROM agent_actions aa2
        WHERE aa2.company_id = aa.company_id
        AND aa2.agent = aa.agent AND aa2.action_type = aa.action_type
        AND aa2.status = 'success' AND aa2.started_at > aa.finished_at
      )
    `;

    for (const r of rateLimited) {
      // Circuit breaker: skip if this agent+company has 3+ failures in 24h
      if (openCircuits.has(`${r.agent}:${r.company_id}`)) {
        await ctx.sql`
          INSERT INTO agent_actions (agent, company_id, action_type, status, description, started_at, finished_at)
          VALUES (${r.agent}, ${r.company_id}, 'circuit_breaker', 'success',
            ${"Circuit breaker open: skipping " + r.agent + " rate-limit retry for " + r.slug + " (3+ failures in 24h)"},
            NOW(), NOW())
        `;
        ctx.circuitBreaks++;
        ctx.dispatches.push({ type: "circuit_breaker", target: r.agent as string, payload: { company: r.slug, reason: "3+_failures_24h" } });
        continue;
      }
      let eventType = "feature_request";
      if (r.agent === "engineer" && ["scaffold_company", "provision_company"].includes(r.action_type as string)) {
        eventType = "new_company";
      } else if (r.agent === "scout") {
        eventType = "research_request";
      } else if (r.agent === "ceo") {
        eventType = "cycle_start";
      }

      // Engineer feature_request → direct to company repo (free Actions)
      if (r.github_repo && r.agent === "engineer" && eventType === "feature_request") {
        await dispatchToCompanyWorkflow(ctx, r.github_repo as string, "hive-build.yml", {
          company_slug: r.slug as string,
          trigger: "feature_request",
          task_summary: "Retry — previous run was rate-limited",
        });
        ctx.dispatches.push({ type: "company_actions", target: "feature_request", payload: { company: r.slug, reason: "rate_limited_retry" } });
      } else {
        // Brain agents (CEO, Scout, provision) must stay on Hive repo
        await dispatchToActions(ctx, eventType, {
          source: "sentinel_retry",
          company: r.slug,
          company_id: r.company_id,
          trace_id: ctx.traceId,
        });
        ctx.dispatches.push({ type: "brain", target: eventType, payload: { company: r.slug, reason: "rate_limited_retry" } });
      }
    }

    // =========================================================================
    // Check 15: Unverified provisions (provisioned in last 2h, no deploy_verified)
    // HTTP check to company health endpoints
    // =========================================================================
    const unverifiedProvisions = await ctx.sql`
      SELECT c.slug, c.id as company_id, c.vercel_url
      FROM companies c
      JOIN agent_actions aa ON aa.company_id = c.id
        AND aa.action_type = 'scaffold_company'
        AND aa.status = 'success'
        AND aa.finished_at > NOW() - INTERVAL '2 hours'
      WHERE c.status = 'mvp'
      AND NOT EXISTS (
        SELECT 1 FROM agent_actions aa2
        WHERE aa2.company_id = c.id
        AND aa2.action_type = 'deploy_verified'
        AND aa2.finished_at > aa.finished_at
      )
    `;

    for (const r of unverifiedProvisions) {
      if (r.vercel_url) {
        try {
          const res = await fetch(r.vercel_url as string, {
            redirect: "follow",
            signal: AbortSignal.timeout(10000),
          });
          if (res.status >= 400) {
            // Circuit breaker: skip healer dispatch if 3+ failures for this company in 48h
            const healerFailures = await ctx.sql`
              SELECT COUNT(*)::int as cnt FROM agent_actions
              WHERE agent = 'healer' AND status = 'failed'
              AND company_id = ${r.company_id}
              AND finished_at > NOW() - INTERVAL '48 hours'
            `.catch(() => [{ cnt: 0 }]);
            if ((healerFailures[0]?.cnt ?? 0) >= 3) {
              console.warn(`[sentinel-urgent] Healer circuit breaker: ${r.slug} has ${healerFailures[0].cnt} healer failures in 48h — skipping dispatch`);
              await ctx.sql`
                INSERT INTO agent_actions (agent, action_type, description, status, company_id, started_at, finished_at)
                VALUES ('sentinel', 'healer_circuit_breaker', ${`Healer skipped for ${r.slug}: ${healerFailures[0].cnt} failures in 48h`}, 'success', ${r.company_id}, NOW(), NOW())
              `.catch(() => {});
              ctx.dispatches.push({ type: "skipped", target: "healer_circuit_breaker", payload: { company: r.slug, failures: healerFailures[0].cnt } });
              continue;
            }

            // Dispatch fix directly to company repo if available
            const [co] = await ctx.sql`SELECT github_repo FROM companies WHERE slug = ${r.slug} LIMIT 1`;
            if (co?.github_repo) {
              await dispatchToCompanyWorkflow(ctx, co.github_repo as string, "hive-fix.yml", {
                company_slug: r.slug as string,
                error_summary: `Deploy broken after provision (HTTP ${res.status})`,
                source: "sentinel-urgent",
              });
              ctx.dispatches.push({ type: "company_actions", target: "ops_escalation", payload: { company: r.slug, status: res.status } });
            } else {
              await dispatchToActions(ctx, "ops_escalation", {
                source: "sentinel-urgent",
                company: r.slug,
                reason: "post_provision_deploy_broken",
                http_status: res.status,
                trace_id: ctx.traceId,
              });
              ctx.dispatches.push({ type: "brain", target: "ops_escalation", payload: { company: r.slug, status: res.status } });
            }
          }
        } catch {
          await dispatchToActions(ctx, "ops_escalation", {
            source: "sentinel-urgent",
            company: r.slug,
            reason: "post_provision_deploy_broken",
            http_status: 0,
            trace_id: ctx.traceId,
          });
          ctx.dispatches.push({ type: "brain", target: "ops_escalation", payload: { company: r.slug, status: 0 } });
        }
      } else {
        await dispatchToActions(ctx, "new_company", {
          source: "sentinel-urgent",
          company: r.slug,
          company_id: r.company_id,
          reason: "missing_url",
          trace_id: ctx.traceId,
        });
        ctx.dispatches.push({ type: "brain", target: "new_company", payload: { company: r.slug, reason: "missing_url" } });
      }
    }

    // =========================================================================
    // Check 16: Missing metrics → trigger metrics cron + company-health delegate
    // =========================================================================
    const missingMetrics = await ctx.sql`
      SELECT c.slug FROM companies c
      WHERE c.status IN ('mvp', 'active') AND c.github_repo IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM metrics m
        WHERE m.company_id = c.id AND m.date > CURRENT_DATE - INTERVAL '2 days'
      )
    `;

    if (missingMetrics.length > 0) {
      try {
        await fetch(`${ctx.baseUrl}/api/cron/metrics`, {
          headers: { Authorization: `Bearer ${ctx.cronSecret}` },
          signal: AbortSignal.timeout(10000),
        });
      } catch (e: any) {
        console.warn(`[sentinel-urgent] metrics cron trigger failed: ${e?.message || e}`);
      }
      ctx.dispatches.push({
        type: "internal",
        target: "metrics_cron",
        payload: { companies: missingMetrics.map((r) => r.slug as string) },
      });
    }

    // Fire company-health as non-blocking delegate
    fetch(`${ctx.baseUrl}/api/cron/company-health`, {
      headers: { Authorization: `Bearer ${ctx.cronSecret}` },
      signal: AbortSignal.timeout(5000),
    }).catch(() => { console.log("[sentinel-urgent] company-health fire-and-forget sent"); });

    // =========================================================================
    // Check 40: Phantom PR cleanup
    // Backlog items marked pr_open but with no pr_number are phantom completions.
    // Engineer marked them done but never created an actual PR. Reset to ready.
    // =========================================================================
    let phantomPrCount = 0;
    try {
      const phantomPrItems = await ctx.sql`
        UPDATE hive_backlog
        SET status = 'ready', dispatched_at = NULL,
            notes = COALESCE(notes, '') || ' [orphan-reset] No pr_number — phantom pr_open, reset to ready.'
        WHERE status = 'pr_open' AND pr_number IS NULL
        RETURNING id, title, github_issue_number
      `;
      phantomPrCount = phantomPrItems.length;
      if (phantomPrItems.length > 0) {
        console.log(`[sentinel-urgent] Check 40: Reset ${phantomPrItems.length} phantom pr_open items: ${phantomPrItems.map((i: any) => i.title.slice(0, 50)).join(", ")}`);
        // Sync GitHub Issues (fire-and-forget)
        for (const pi of phantomPrItems) {
          if (pi.github_issue_number) {
            import("@/lib/github-issues").then(({ syncBacklogStatus }) =>
              syncBacklogStatus(pi.github_issue_number, "ready")
            ).catch(() => {});
          }
        }
        await ctx.sql`
          INSERT INTO agent_actions (agent, action_type, description, status, started_at, finished_at)
          VALUES ('sentinel', 'phantom_pr_cleanup',
            ${`Check 40: Reset ${phantomPrItems.length} phantom pr_open items (no pr_number)`},
            'success', NOW(), NOW())
        `.catch(() => {});
      }
    } catch (check40Err: any) {
      console.warn(`[sentinel-urgent] Check 40 failed: ${check40Err.message}`);
    }

    // =========================================================================
    // Check 41: PR verification — verify pr_open items against GitHub API
    // Items with pr_number: if PR is merged → mark done,
    // if PR doesn't exist or is closed → reset to ready.
    // =========================================================================
    let prMerged = 0;
    let prReset = 0;
    let prVerified = 0;
    try {
      const prOpenItems = await ctx.sql`
        SELECT id, title, pr_number, pr_url, github_issue_number
        FROM hive_backlog
        WHERE status = 'pr_open' AND pr_number IS NOT NULL
        LIMIT 10
      `;
      if (prOpenItems.length > 0 && ctx.ghPat) {
        for (const item of prOpenItems) {
          try {
            const prRes = await fetch(`https://api.github.com/repos/${REPO}/pulls/${item.pr_number}`, {
              headers: { Authorization: `token ${ctx.ghPat}`, Accept: "application/vnd.github.v3+json" },
              signal: AbortSignal.timeout(5000),
            });
            if (!prRes.ok) {
              // PR doesn't exist — reset to ready
              await ctx.sql`
                UPDATE hive_backlog
                SET status = 'ready', dispatched_at = NULL, pr_number = NULL, pr_url = NULL,
                    notes = COALESCE(notes, '') || ${` [check-41] PR #${item.pr_number} not found (HTTP ${prRes.status}), reset to ready.`}
                WHERE id = ${item.id}
              `;
              prReset++;
              continue;
            }
            const pr = await prRes.json();
            if (pr.merged) {
              await ctx.sql`
                UPDATE hive_backlog
                SET status = 'done', completed_at = NOW(),
                    notes = COALESCE(notes, '') || ${` [check-41] PR #${item.pr_number} merged, marking done.`}
                WHERE id = ${item.id}
              `;
              // Sync GitHub Issue (fire-and-forget)
              if (item.github_issue_number) {
                import("@/lib/github-issues").then(({ syncBacklogStatus }) =>
                  syncBacklogStatus(item.github_issue_number, "done")
                ).catch(() => {});
              }
              prMerged++;
            } else if (pr.state === "closed") {
              await ctx.sql`
                UPDATE hive_backlog
                SET status = 'ready', dispatched_at = NULL, pr_number = NULL, pr_url = NULL,
                    notes = COALESCE(notes, '') || ${` [check-41] PR #${item.pr_number} closed without merge, reset to ready.`}
                WHERE id = ${item.id}
              `;
              prReset++;
            } else {
              // PR is open — check CI status
              prVerified++;
            }
          } catch {
            // Non-blocking per item
          }
        }
        if (prMerged > 0 || prReset > 0) {
          console.log(`[sentinel-urgent] Check 41: PR verification — ${prMerged} merged→done, ${prReset} invalid→reset, ${prVerified} still open`);
          await ctx.sql`
            INSERT INTO agent_actions (agent, action_type, description, status, started_at, finished_at)
            VALUES ('sentinel', 'pr_verification',
              ${`Check 41: Verified ${prOpenItems.length} pr_open items — ${prMerged} merged→done, ${prReset} reset, ${prVerified} still open`},
              'success', NOW(), NOW())
          `.catch(() => {});
        }
      }
    } catch (check41Err: any) {
      console.warn(`[sentinel-urgent] Check 41 failed: ${check41Err.message}`);
    }

    // =========================================================================
    // Check 42b: Stale task detection
    // Backlog items stuck in dispatched/in_progress for too long without progress.
    // dispatched > 6h → flag. in_progress > 24h → flag. Both get notes + log.
    // =========================================================================
    let staleDispatched = 0;
    let staleInProgress = 0;
    try {
      // Dispatched items stuck > 6 hours
      const stuckDispatched = await ctx.sql`
        UPDATE hive_backlog
        SET notes = COALESCE(notes, '') || ' [stale] Stuck in dispatched > 6h, reset to ready.',
            status = 'ready', dispatched_at = NULL
        WHERE status = 'dispatched'
        AND dispatched_at < NOW() - INTERVAL '6 hours'
        RETURNING id, title, github_issue_number
      `;
      staleDispatched = stuckDispatched.length;
      for (const item of stuckDispatched) {
        if (item.github_issue_number) {
          import("@/lib/github-issues").then(({ syncBacklogStatus }) =>
            syncBacklogStatus(item.github_issue_number, "ready")
          ).catch(() => {});
        }
      }

      // In-progress items stuck > 24 hours (flag but don't reset — agent may still be working)
      const stuckInProgress = await ctx.sql`
        UPDATE hive_backlog
        SET notes = COALESCE(notes, '') || ' [stale] In progress > 24h without PR.'
        WHERE status = 'in_progress'
        AND updated_at < NOW() - INTERVAL '24 hours'
        AND pr_number IS NULL
        AND notes NOT LIKE '%[stale]%'
        RETURNING id, title
      `;
      staleInProgress = stuckInProgress.length;

      if (staleDispatched > 0 || staleInProgress > 0) {
        console.log(`[sentinel-urgent] Check 42b: Stale tasks — ${staleDispatched} dispatched→ready, ${staleInProgress} in_progress flagged`);
        await ctx.sql`
          INSERT INTO agent_actions (agent, action_type, description, status, started_at, finished_at)
          VALUES ('sentinel', 'stale_task_detection',
            ${`Check 42b: ${staleDispatched} dispatched→ready (>6h), ${staleInProgress} in_progress flagged (>24h)`},
            'success', NOW(), NOW())
        `.catch(() => {});
      }
    } catch (check42bErr: any) {
      console.warn(`[sentinel-urgent] Check 42b failed: ${check42bErr?.message}`);
    }

    // =========================================================================
    // Deploy drift check — Vercel deploy SHA vs GitHub main SHA
    // =========================================================================
    const drift = await checkDeployDrift(ctx);
    if (drift.drifted) {
      await dispatchToActions(ctx, "deploy_drift", {
        source: "sentinel-urgent",
        main_sha: drift.mainSha,
        deploy_sha: drift.deploySha,
        trace_id: ctx.traceId,
      });
      ctx.dispatches.push({ type: "brain", target: "deploy_drift", payload: { main: drift.mainSha, deployed: drift.deploySha } });
    }

    // =========================================================================
    // Check 42: Deploy health — detect broken Vercel build pipeline
    // If 3+ consecutive deploys are ERROR, the pipeline is broken (e.g. Git
    // integration disconnected, build config invalid). Escalate immediately.
    // =========================================================================
    const deployHealth = await checkDeployHealth(ctx);
    if (!deployHealth.healthy) {
      console.error(
        `[sentinel-urgent] DEPLOY PIPELINE BROKEN: ${deployHealth.consecutiveErrors} consecutive errors. Last READY: ${deployHealth.lastReadyAt || "unknown"}`
      );
      // Log to agent_actions for visibility
      await ctx.sql`
        INSERT INTO agent_actions (agent, action_type, description, status, started_at, finished_at)
        VALUES ('sentinel', 'deploy_pipeline_broken',
          ${`CRITICAL: ${deployHealth.consecutiveErrors} consecutive Vercel deploy errors. Last READY: ${deployHealth.lastReadyAt || "unknown"}. Latest commit: ${deployHealth.latestError || "unknown"}`},
          'failed', NOW(), NOW())
      `.catch(() => {});
      // Telegram escalation
      try {
        const { notifyHive } = await import("@/lib/telegram");
        await notifyHive({
          agent: "sentinel-urgent",
          action: "deploy_pipeline_broken",
          status: "failed",
          summary: `🚨 ${deployHealth.consecutiveErrors} consecutive Vercel deploy failures — pipeline is broken`,
          details: `Last successful deploy: ${deployHealth.lastReadyAt || "unknown"}\nCheck Vercel dashboard for Git integration or build config issues.`,
        });
      } catch { /* Telegram not configured */ }
      ctx.dispatches.push({
        type: "escalation",
        target: "deploy_pipeline_broken",
        payload: {
          consecutive_errors: deployHealth.consecutiveErrors,
          last_ready: deployHealth.lastReadyAt,
        },
      });
    }

    // =========================================================================
    // Telegram notification if something interesting happened
    // =========================================================================
    try {
      const { notifyHive } = await import("@/lib/telegram");
      if (ctx.dispatches.length > 0) {
        const parts: string[] = [];
        parts.push(`${ctx.dispatches.length} dispatches`);
        if (stuckApproved.length > 0) parts.push(`${stuckApproved.length} stuck approved`);
        if (orphanedMvps.length > 0) parts.push(`${orphanedMvps.length} orphaned MVPs`);
        if (staleRunning.length > 0) parts.push(`${staleRunning.length} stale reclaimed`);
        if (failedWithPlanWork.length > 0) parts.push(`${failedWithPlanWork.length} failed tasks retried`);
        if (rateLimited.length > 0) parts.push(`${rateLimited.length} rate-limited retries`);
        if (drift.drifted) parts.push("deploy drift detected");
        if (!deployHealth.healthy) parts.push(`DEPLOY PIPELINE BROKEN (${deployHealth.consecutiveErrors} errors)`);

        await notifyHive({
          agent: "sentinel-urgent",
          action: "health_check",
          status: "success",
          summary: parts.join(", "),
          details: ctx.dispatches.map((d: Dispatch) => `${d.type}: ${d.target}`).join("\n"),
        });
      }
    } catch { /* Telegram not configured — silently skip */ }

    // =========================================================================
    // Response
    // =========================================================================
    return Response.json({
      ok: true,
      tier: "urgent",
      traceId: ctx.traceId,
      dispatches: ctx.dispatches,
      dedupSkips: ctx.dedupSkips,
      circuitBreaks: ctx.circuitBreaks,
      stuck_approved: stuckApproved.length,
      orphaned_mvps: orphanedMvps.length,
      missing_neon_db: missingNeonDb.length,
      stale_reclaimed: staleRunning.length,
      failed_task_retries: failedWithPlanWork.length,
      rate_limited_retries: rateLimited.length,
      unverified_provisions: unverifiedProvisions.length,
      missing_metrics: missingMetrics.length,
      phantom_pr_cleanup: phantomPrCount,
      pr_merged: prMerged,
      pr_reset: prReset,
      pr_verified: prVerified,
      deploy_drift: drift.drifted,
      deploy_pipeline_healthy: deployHealth.healthy,
      deploy_consecutive_errors: deployHealth.consecutiveErrors,
      company_health: "delegated",
    });

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    console.error("[sentinel-urgent] Failed:", message, stack);
    return Response.json({ ok: false, error: message, stack }, { status: 500 });
  }
}

// QStash sends POST — re-export GET handler for dual-mode auth
export { GET as POST };
