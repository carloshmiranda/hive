import { getDb, json, err } from "@/lib/db";
import { getGitHubToken } from "@/lib/github-app";
import { computeBacklogScore, detectBlockedAgents, isHighPriority } from "@/lib/backlog-priority";
import type { BacklogItem } from "@/lib/backlog-priority";
import { trackFailedBacklogItem, resetBacklogItemCooldown } from "@/lib/dispatch";
import { flagProblemStatementsAsNeedingDecomposition, isCompanySpecific } from "@/lib/backlog-planner";
import { qstashPublish } from "@/lib/qstash";
import { queuePop, queueRebuild, queueSyncItem } from "@/lib/redis-cache";
import { sanitizeTaskInput, hasSuspiciousPatterns } from "@/lib/input-sanitizer";
import { setSentryTags, addDispatchBreadcrumb, withSpan } from "@/lib/sentry-tags";
import { writeCompletionReportByDispatchId, type CompletionReport } from "@/lib/completion-report";
import type { PRAnalysis } from "@/lib/pr-risk-scoring";
import { markTaskAsStealable, claimStealableTask, type WorkStealingResult } from "@/lib/work-stealing";
import { computeLineageFailures, blockLineageForManualSpec } from "@/lib/backlog-lineage";
import { checkRecentRateLimitFailures } from "@/lib/sentinel-helpers";

const HIVE_URL = process.env.NEXT_PUBLIC_URL || "https://hive-phi.vercel.app";

// Agent success rate weighting for dispatch optimization
interface AgentSuccessRate {
  agent: string;
  company_id: string | null;
  company_slug: string | null;
  success_rate: number;
  total_actions: number;
  recent_failures: number;
}

interface WeightedItem {
  [key: string]: any;
  success_rate_weight: number;
  company_slug?: string | null;
}

// Get agent success rates per company from agent_actions table
async function getAgentSuccessRates(sql: ReturnType<typeof getDb>): Promise<AgentSuccessRate[]> {
  try {
    const rates = await sql`
      SELECT
        a.agent,
        a.company_id,
        c.slug as company_slug,
        COUNT(CASE WHEN a.status = 'success' THEN 1 END)::int as successes,
        COUNT(CASE WHEN a.status = 'failed' THEN 1 END)::int as failures,
        COUNT(*)::int as total_actions,
        COALESCE(
          COUNT(CASE WHEN a.status = 'success' THEN 1 END)::numeric /
          NULLIF(COUNT(CASE WHEN a.status IN ('success', 'failed') THEN 1 END), 0),
          0.5
        ) as success_rate,
        COUNT(CASE WHEN a.status = 'failed' AND a.finished_at > NOW() - INTERVAL '24 hours' THEN 1 END)::int as recent_failures
      FROM agent_actions a
      LEFT JOIN companies c ON a.company_id = c.id
      WHERE a.agent = 'engineer'
        AND a.finished_at > NOW() - INTERVAL '7 days'
        AND a.status IN ('success', 'failed')
      GROUP BY a.agent, a.company_id, c.slug
      HAVING COUNT(CASE WHEN a.status IN ('success', 'failed') THEN 1 END) >= 2
    `;
    return rates as AgentSuccessRate[];
  } catch (error) {
    console.warn('[backlog] Failed to query agent success rates:', error);
    return [];
  }
}

// Apply success rate weighting to scored items
async function applySuccessRateWeighting(
  sql: ReturnType<typeof getDb>,
  scoredItems: any[],
  agentSuccessRates: AgentSuccessRate[]
): Promise<WeightedItem[]> {
  // Get company info for items that have companies
  const companyItemIds = scoredItems
    .filter(item => item.description && /company:|for \w+:/i.test(item.description))
    .map(item => item.id);

  let itemCompanyMap: Record<string, string> = {};
  if (companyItemIds.length > 0) {
    try {
      const itemCompanies = await sql`
        SELECT DISTINCT
          b.id as backlog_id,
          c.slug as company_slug
        FROM hive_backlog b
        CROSS JOIN companies c
        WHERE b.id = ANY(${companyItemIds})
          AND (
            b.description ILIKE '%company: ' || c.slug || '%'
            OR b.description ILIKE '%for ' || c.slug || ':%'
          )
      `;
      itemCompanyMap = Object.fromEntries(
        itemCompanies.map((ic: any) => [ic.backlog_id, ic.company_slug])
      );
    } catch (error) {
      console.warn('[backlog] Failed to map items to companies:', error);
    }
  }

  // Create success rate lookup
  const successRateMap = new Map<string, number>();
  for (const rate of agentSuccessRates) {
    const key = rate.company_slug || 'hive_internal';
    successRateMap.set(key, rate.success_rate);
  }

  return scoredItems.map(item => {
    const companySlug = itemCompanyMap[item.id] || null;
    let successRateWeight = 1.0;

    if (companySlug) {
      const successRate = successRateMap.get(companySlug);
      if (successRate !== undefined) {
        // Convert success rate to weight:
        // 0.0-0.2 success rate → 0.0 weight (filtered out)
        // 0.2-0.8 success rate → 0.2-0.8 weight (proportional penalty)
        // 0.8+ success rate → 1.0 weight (no penalty)
        if (successRate >= 0.8) {
          successRateWeight = 1.0;
        } else if (successRate >= 0.2) {
          successRateWeight = successRate;
        } else {
          successRateWeight = 0.0; // Will be filtered out
        }
      }
    }

    return {
      ...item,
      success_rate_weight: successRateWeight,
      company_slug: companySlug,
    };
  });
}

// Review and auto-merge all open hive/ PRs.
// Extracted as a helper so it can run on both completion callbacks AND fresh dispatches.
// This ensures existing PRs get merged even when the chain restarts from sentinel/manual kicks.
async function reviewAndMergeOpenPRs(sql: ReturnType<typeof getDb>): Promise<{ ciFixDispatched: boolean }> {
  try {
    const ghToken = await getGitHubToken();
    if (!ghToken) return { ciFixDispatched: false };
    const { analyzePR, autoMergePR } = await import("@/lib/pr-risk-scoring");
    const prListRes = await fetch("https://api.github.com/repos/carloshmiranda/hive/pulls?state=open&per_page=30", {
      headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github.v3+json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!prListRes.ok) return { ciFixDispatched: false };
    const openPRs = await prListRes.json();
    const hivePRs = openPRs.filter((pr: any) => pr.head?.ref?.startsWith("hive/"));
    console.log(`[backlog] PR review: found ${hivePRs.length} open hive/ PRs`);
    let ciFixDispatched = false;
    for (const pr of hivePRs) {
      try {
        const analysis = await analyzePR("carloshmiranda", "hive", pr.number, ghToken);
        console.log(`[backlog] PR #${pr.number}: decision=${analysis.decision}, gates=${analysis.hardGateIssues.join("; ") || "none"}, cost=${analysis.costImpact}`);
        if (analysis.decision === "auto_merge") {
          const result = await autoMergePR("carloshmiranda", "hive", pr.number, ghToken, "squash");
          if (result.success) {
            const mergedItems = await sql`
              UPDATE hive_backlog SET status = 'done', completed_at = NOW(),
                notes = COALESCE(notes, '') || ${` [auto-merged] PR #${pr.number} merged during dispatch.`}
              WHERE status = 'pr_open'
                AND pr_number = ${pr.number}
              RETURNING id
            `.catch(() => []);

            // Remove merged items from dispatch queue
            for (const item of mergedItems) {
              await queueSyncItem(item.id, 'done').catch(() => {});
            }
            for (const merged of mergedItems || []) {
              syncIssueForBacklog(sql, merged.id, "done");
            }
            console.log(`[backlog] Auto-merged PR #${pr.number}: ${pr.title}`);
          } else {
            console.log(`[backlog] Auto-merge failed for PR #${pr.number}: ${result.message}`);
          }
        } else {
          // PR escalated — classify why and attempt auto-fix for automatable issues
          const dispatched = await handleEscalatedPR(sql, pr, analysis, ghToken);
          if (dispatched) ciFixDispatched = true;
        }
      } catch (prAnalysisErr) {
        console.warn(`[backlog] PR #${pr.number} analysis error:`, prAnalysisErr instanceof Error ? prAnalysisErr.message : "unknown");
      }
    }
    return { ciFixDispatched };
  } catch (prErr) {
    console.warn("[backlog] PR review failed:", prErr instanceof Error ? prErr.message : "unknown");
    return { ciFixDispatched: false };
  }
}

// Handle PRs that failed risk analysis — auto-fix CI/conflict issues, escalate true safety concerns.
// Mirrors the Check 39 pattern from company-health but runs inline during dispatch.
// Returns true if a ci_fix Engineer was dispatched (caller should skip new backlog work).
async function handleEscalatedPR(
  sql: ReturnType<typeof getDb>,
  pr: any,
  analysis: PRAnalysis,
  ghToken: string,
): Promise<boolean> {
  const { hardGateIssues, costImpact, costFactors } = analysis;

  // Classify: is this fixable (CI failure, merge conflicts) or a true safety/cost concern?
  const hasCIFailure = hardGateIssues.some(i => i.includes("CI checks"));
  const hasConflicts = hardGateIssues.some(i => i.includes("merge conflicts"));
  const hasSecrets = hardGateIssues.some(i => i.includes("secrets"));
  const hasDestructiveSQL = hardGateIssues.some(i => i.includes("Destructive DB"));
  const hasHugeDiff = hardGateIssues.some(i => i.includes("Large diff"));

  const isFixable = (hasCIFailure || hasConflicts) && !hasSecrets && !hasDestructiveSQL && !hasHugeDiff && !costImpact;

  if (!isFixable) {
    // True safety/cost concern — create approval gate
    const reasons = [...hardGateIssues, ...(costFactors || [])].join("; ");
    await sql`
      INSERT INTO approvals (gate_type, title, context, status)
      VALUES ('pr_review',
        ${`PR #${pr.number} needs review: ${pr.title}`},
        ${JSON.stringify({ pr_number: pr.number, branch: pr.head?.ref, reasons, risk_score: analysis.riskScore })}::jsonb,
        'pending')
      ON CONFLICT DO NOTHING
    `.catch(() => {});
    console.log(`[backlog] PR #${pr.number} escalated for review: ${reasons.slice(0, 150)}`);
    return false;
  }

  // Rate-limit Engineer dispatches: skip if we already dispatched one in the last 2 hours.
  // Branch-update attempts use a separate, shorter cooldown (30 min).
  const [recentEngineerDispatch] = await sql`
    SELECT id FROM agent_actions
    WHERE agent = 'engineer' AND action_type = 'ci_fix' AND status IN ('running', 'success')
    AND description LIKE ${`%PR #${pr.number}%`}
    AND started_at > NOW() - INTERVAL '2 hours'
    LIMIT 1
  `.catch(() => []);
  if (recentEngineerDispatch) return false;

  // Step 1: Try updating the branch (merges main into PR branch).
  // Resolves "behind main" CI failures and simple merge conflicts.
  // Only skip for 30 min after a branch-update attempt — short enough that if CI re-fails
  // the Engineer dispatch path runs on the next cycle.
  // 'skipped' status = branch was updated, waiting for CI re-run (30-min cooldown)
  const [recentBranchUpdate] = await sql`
    SELECT id FROM agent_actions
    WHERE agent = 'engineer' AND action_type = 'ci_fix' AND status = 'skipped'
    AND description LIKE ${`%branch update%PR #${pr.number}%`}
    AND started_at > NOW() - INTERVAL '30 minutes'
    LIMIT 1
  `.catch(() => []);

  if (!recentBranchUpdate) {
    try {
      const updateRes = await fetch(
        `https://api.github.com/repos/carloshmiranda/hive/pulls/${pr.number}/update-branch`,
        {
          method: "PUT",
          headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github.v3+json" },
          body: JSON.stringify({ expected_head_sha: pr.head.sha }),
        }
      );
      if (updateRes.ok || updateRes.status === 202) {
        // Branch was behind main — merged and CI will re-run. Wait one cycle.
        await sql`
          INSERT INTO agent_actions (agent, action_type, status, description, started_at, finished_at)
          VALUES ('engineer', 'ci_fix', 'skipped',
            ${`branch update PR #${pr.number}: ${pr.title} — merged main, CI will re-run`},
            NOW(), NOW())
        `.catch(() => {});
        console.log(`[backlog] Updated branch for PR #${pr.number} — waiting for CI re-run`);
        return false;
      }
      // 422 = branch already up-to-date with main. CI failure is a code bug — fall through to Engineer.
      // Any other non-2xx also falls through.
    } catch { /* fall through to Engineer dispatch */ }
  }

  // Step 2: Branch update failed — dispatch Engineer to fix the PR
  const [runningEng] = await sql`
    SELECT id FROM agent_actions
    WHERE agent = 'engineer' AND status = 'running'
    AND company_id IS NULL
    AND started_at > NOW() - INTERVAL '1 hour'
    LIMIT 1
  `.catch(() => []);
  if (runningEng) return false; // Engineer busy — will retry next dispatch cycle

  const ciErrorSummary = hardGateIssues.join("; ");
  const [backlogItem] = await sql`
    SELECT id, title FROM hive_backlog
    WHERE pr_number = ${pr.number} AND status = 'pr_open'
    LIMIT 1
  `.catch(() => []);

  await qstashPublish("/api/dispatch/chain-dispatch", {
    event_type: "ci_fix",
    source: "dispatch_pr_review",
    company: "",
    pr_number: pr.number,
    branch: pr.head.ref,
    ci_errors: ciErrorSummary,
    backlog_id: backlogItem?.id || "",
    task: `Fix CI failures on PR #${pr.number}: ${pr.title}`,
  }, {
    retries: 2,
    deduplicationId: `ci-fix-dispatch-${pr.number}-${Date.now().toString(36)}`,
  });

  await sql`
    INSERT INTO agent_actions (agent, action_type, status, description, started_at, finished_at)
    VALUES ('engineer', 'ci_fix', 'running',
      ${`CI fix dispatched for PR #${pr.number}: ${pr.title}. Issues: ${ciErrorSummary.slice(0, 200)}`},
      NOW(), NOW())
  `.catch(() => {});
  console.log(`[backlog] Dispatched Engineer to fix PR #${pr.number}: ${ciErrorSummary.slice(0, 100)}`);
  return true; // ci_fix engineer dispatched — caller should skip new backlog work
}

// Fire-and-forget GitHub Issue sync for backlog status transitions
function syncIssueForBacklog(sql: ReturnType<typeof getDb>, itemId: string, newStatus: string) {
  sql`SELECT github_issue_number FROM hive_backlog WHERE id = ${itemId}`
    .then(([row]) => {
      if (!row?.github_issue_number) return;
      return import("@/lib/github-issues").then(({ syncBacklogStatus }) =>
        syncBacklogStatus(row.github_issue_number, newStatus)
      );
    })
    .catch(() => {});
}

// Dispatch free-tier workers when Claude budget is blocked
async function dispatchFreeWorkers(cronSecret: string, sql: ReturnType<typeof getDb>) {
  const workers: { company: string; agent: string }[] = [];
  const companies = await sql`
    SELECT slug FROM companies WHERE status IN ('mvp', 'active')
  `.catch((e: any) => { console.warn(`[backlog] fetch companies for free workers failed: ${e?.message || e}`); return []; });

  for (const c of companies) {
    for (const agent of ["growth", "ops"] as const) {
      const [recent] = await sql`
        SELECT id FROM agent_actions
        WHERE agent = ${agent} AND status = 'success'
        AND company_id = (SELECT id FROM companies WHERE slug = ${c.slug})
        AND started_at > NOW() - INTERVAL '12 hours'
        LIMIT 1
      `.catch((e: any) => { console.warn(`[backlog] check recent ${agent} for ${c.slug} failed: ${e?.message || e}`); return []; });
      if (!recent) workers.push({ company: c.slug, agent });
    }
  }

  const dispatched: string[] = [];
  for (const w of workers) {
    await qstashPublish("/api/agents/dispatch", {
      company_slug: w.company,
      agent: w.agent,
      trigger: "cascade_free_worker",
    }, {
      deduplicationId: `backlog-worker-${w.agent}-${w.company}-${new Date().toISOString().slice(0, 13)}`,
    }).catch((e: any) => { console.warn(`[backlog] qstash free worker dispatch ${w.agent}:${w.company} failed: ${e?.message || e}`); });
    dispatched.push(`${w.agent}:${w.company}`);
  }
  return dispatched;
}

// POST /api/backlog/dispatch — score and dispatch the next backlog item
// Called by: Engineer workflow after completing a Hive fix (chain dispatch)
//            Sentinel as part of triage (existing flow)
//            Manual trigger from dashboard
// Auth: CRON_SECRET or OIDC
export async function POST(req: Request) {
  // Set Sentry tags for error triage and filtering
  setSentryTags({
    action_type: "backlog_dispatch",
    route: "/api/backlog/dispatch"
  });

  addDispatchBreadcrumb({
    message: "Backlog dispatch started",
    category: "dispatch",
  });

  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (authHeader !== `Bearer ${cronSecret}`) {
    const { validateOIDC } = await import("@/lib/oidc");
    const result = await validateOIDC(req);
    if (result instanceof Response) return result;
  }

  const sql = getDb();

  // Global kill switch — check before ANY dispatch logic
  const [pauseSetting] = await sql`
    SELECT value FROM settings WHERE key = 'dispatch_paused' LIMIT 1
  `.catch(() => []);
  if (pauseSetting?.value === 'true') {
    return json({ dispatched: false, reason: "dispatch_paused", message: "All dispatches halted by kill switch" });
  }

  const body = await req.json().catch(() => ({}));
  let { completed_id, completed_status, pr_number, branch, changed_files, force_respec } = body;

  // Handle structured status codes from Engineer callbacks (ADR-032)
  const { status_code, concerns, context_needed, blocking_issue } = body;

  // Map structured status codes to routing behavior
  if (status_code) {
    console.log(`[backlog] Structured status code received: ${status_code}`);

    switch (status_code) {
      case "DONE":
        // Continue with normal success processing
        break;
      case "DONE_WITH_CONCERNS":
        // Log concerns but don't block dispatch
        if (concerns) {
          console.warn(`[backlog] Engineer concerns (non-blocking): ${concerns}`);
        }
        break;
      case "NEEDS_CONTEXT":
        // Treat as partial completion, may need follow-up
        if (context_needed) {
          console.log(`[backlog] Context needed for completion: ${context_needed}`);
        }
        break;
      case "BLOCKED":
        // Escalation trigger - blocking issue prevents completion
        if (blocking_issue) {
          console.warn(`[backlog] Engineer blocked - escalation needed: ${blocking_issue}`);
          // TODO: Implement escalation logic for BLOCKED status
        }
        break;
      default:
        console.warn(`[backlog] Unknown status_code: ${status_code}`);
    }
  }

  // PR tracking: only trust pr_number explicitly provided by the Engineer callback.
  // Previously auto-extracted from recent open PRs, but this caused wrong PR attribution
  // when multiple Engineer runs overlapped (grabbed most recent hive/* PR, not the right one).

  // Cooldown is now SQL-based (no in-memory cleanup needed)

  // If a completed item was passed, update its status
  if (completed_id && completed_status) {
    // Close the corresponding agent_actions record so the engineer_busy gate unblocks.
    // Without this, the action stays 'running' forever (zombie) and blocks all future dispatches.
    // Uses dispatch_id from hive_backlog (set at dispatch time) for reliable linking.
    // Falls back to closing the most recent running engineer action if no dispatch_id found.
    if (completed_status !== "in_progress") {
      // "partial" = max_turns reached but progress was made — treat as success for agent_actions
      const actionStatus = (completed_status === "success" || completed_status === "partial") ? "success" : "failed";
      const errorDetail = body.error || null;

      // Look up the dispatch_id that links this backlog item to its agent_action
      const [backlogItem] = await sql`
        SELECT dispatch_id FROM hive_backlog WHERE id = ${completed_id}
      `.catch(() => []);

      if (backlogItem?.dispatch_id) {
        await sql`
          UPDATE agent_actions
          SET status = ${actionStatus},
              finished_at = COALESCE(finished_at, NOW()),
              error = CASE WHEN ${errorDetail}::text IS NOT NULL THEN ${errorDetail} ELSE error END
          WHERE id = ${backlogItem.dispatch_id} AND status = 'running'
        `.catch((e: any) => { console.warn(`[backlog] close agent_action ${backlogItem.dispatch_id} failed: ${e?.message || e}`); });

        // Write failure completion report so other agents know what went wrong
        if (actionStatus === 'failed') {
          const failReport: CompletionReport = {
            summary: `Failed: ${errorDetail?.slice(0, 120) || 'unknown error'}`,
            blockers: [errorDetail || 'Unknown failure'].slice(0, 3),
          };
          await writeCompletionReportByDispatchId(sql, backlogItem.dispatch_id, failReport);
        }
      } else {
        // Fallback: close the most recent running engineer action (best-effort)
        await sql`
          UPDATE agent_actions
          SET status = ${actionStatus},
              finished_at = COALESCE(finished_at, NOW()),
              error = CASE WHEN ${errorDetail}::text IS NOT NULL THEN ${errorDetail} ELSE error END
          WHERE id = (
            SELECT id FROM agent_actions
            WHERE agent = 'engineer' AND status = 'running'
              AND company_id IS NULL
              AND started_at > NOW() - INTERVAL '2 hours'
            ORDER BY started_at DESC LIMIT 1
          )
        `.catch((e: any) => { console.warn(`[backlog] close most recent engineer action failed: ${e?.message || e}`); });
      }
    }

    // Agent acknowledges work started — transition to in_progress
    if (completed_status === "in_progress") {
      await sql`
        UPDATE hive_backlog
        SET status = 'in_progress',
            notes = COALESCE(notes, '') || ${` [in_progress] Agent started working at ${new Date().toISOString().slice(0, 19)}`}
        WHERE id = ${completed_id} AND status = 'dispatched'
      `.catch((e: any) => { console.warn(`[backlog] mark item ${completed_id} in_progress failed: ${e?.message || e}`); });
      syncIssueForBacklog(sql, completed_id, "in_progress");
      // Don't return — let the dispatch chain continue (this is just a status update)
    }

    if (completed_status === "success") {
      // Update parent's decomposition_context when a sub-task completes (ADR-031 Phase 2)
      const [completedItem] = await sql`
        SELECT parent_id, title, description FROM hive_backlog WHERE id = ${completed_id}
      `.catch(() => []);
      if (completedItem?.parent_id) {
        // Update sub_tasks status + summary in parent's decomposition_context
        await sql`
          UPDATE hive_backlog
          SET decomposition_context = jsonb_set(
            COALESCE(decomposition_context, '{}'::jsonb),
            '{sub_tasks}',
            (
              SELECT COALESCE(jsonb_agg(
                CASE
                  WHEN elem->>'title' = ${completedItem.title}
                  THEN elem || jsonb_build_object('status', 'done', 'summary', ${`Completed${pr_number ? ` (PR #${pr_number})` : ''}`})
                  ELSE elem
                END
              ), '[]'::jsonb)
              FROM jsonb_array_elements(COALESCE(decomposition_context->'sub_tasks', '[]'::jsonb)) elem
            )
          )
          WHERE id = ${completedItem.parent_id}
        `.catch((e: any) => { console.warn(`[backlog] update parent decomposition_context failed: ${e?.message || e}`); });

        // Also propagate to sibling sub-tasks so they see latest state
        await sql`
          UPDATE hive_backlog
          SET decomposition_context = (SELECT decomposition_context FROM hive_backlog WHERE id = ${completedItem.parent_id})
          WHERE parent_id = ${completedItem.parent_id} AND id != ${completed_id} AND status IN ('ready', 'approved', 'planning')
        `.catch(() => {});
      }

      // Engineer "success" means work completed. If PR was created, track it.
      // pr_open requires pr_number — without it, mark as done (prevents phantom pr_open).
      if (pr_number) {
        const fileCount = changed_files ? (Array.isArray(changed_files) ? changed_files.length : 0) : 0;
        const prInfo = ` PR #${pr_number} on ${branch || 'unknown'} (${fileCount} files) — awaiting merge.`;
        await sql`
          UPDATE hive_backlog
          SET status = 'pr_open', dispatched_at = NOW(),
              pr_number = ${parseInt(pr_number, 10)},
              pr_url = ${`https://github.com/carloshmiranda/hive/pull/${pr_number}`},
              notes = COALESCE(notes, '') || ${prInfo}
          WHERE id = ${completed_id} AND status IN ('dispatched', 'in_progress')
        `.catch((e: any) => { console.warn(`[backlog] update item ${completed_id} to pr_open failed: ${e?.message || e}`); });
        syncIssueForBacklog(sql, completed_id, "pr_open");
        // Chain dispatch: don't wait for PR to merge — continue with next backlog item.
        // PRs are merged asynchronously by company-health Check 38. This prevents the
        // loop from stalling when PRs are open but there's more work to do.
        await qstashPublish("/api/backlog/dispatch", {
          trigger: "pr_open_chain",
          completed_id,
          pr_number,
        }, {
          deduplicationId: `pr-open-chain-${completed_id}`,
          delay: 10, // 10 second delay to let Engineer finish cleanup
        }).catch((e: any) => { console.warn(`[backlog] chain dispatch after pr_open failed: ${e?.message || e}`); });
      } else {
        // No PR number — Engineer completed via direct commit or the PR info was lost.
        // Mark as done to prevent phantom pr_open items.
        await sql`
          UPDATE hive_backlog
          SET status = 'done', completed_at = NOW(),
              notes = COALESCE(notes, '') || ' Completed via chain dispatch (no PR created — direct commit or PR info missing).'
          WHERE id = ${completed_id} AND status IN ('dispatched', 'in_progress')
        `.catch((e: any) => { console.warn(`[backlog] mark item ${completed_id} done failed: ${e?.message || e}`); });
        syncIssueForBacklog(sql, completed_id, "done");
        // Chain dispatch: continue processing backlog even without a PR.
        // Without this, the chain stalls when Engineer completes via direct commit.
        await qstashPublish("/api/backlog/dispatch", {
          trigger: "done_chain",
          completed_id,
        }, {
          deduplicationId: `done-chain-${completed_id}`,
          delay: 10,
        }).catch((e: any) => { console.warn(`[backlog] chain dispatch after done failed: ${e?.message || e}`); });
      }

      // Store completion report in the agent_actions record for handoff visibility
      const [dispatchLink] = await sql`
        SELECT dispatch_id FROM hive_backlog WHERE id = ${completed_id}
      `.catch(() => []);
      if (dispatchLink?.dispatch_id) {
        const completionReport: CompletionReport = {
          summary: `${completedItem?.title || completed_id}: ${pr_number ? `PR #${pr_number}` : 'direct commit'}`,
          files_changed: Array.isArray(changed_files) ? changed_files : undefined,
          pr_number: pr_number ? parseInt(pr_number, 10) : undefined,
          branch: branch || undefined,
        };
        await writeCompletionReportByDispatchId(sql, dispatchLink.dispatch_id, completionReport);
      }
      if (pr_number && branch) {
        await sql`
          UPDATE agent_actions
          SET output = CASE
            WHEN output IS NULL THEN
              ${JSON.stringify({ pr_tracking: { pr_number, branch, changed_files } })}
            ELSE
              jsonb_set(
                COALESCE(output, '{}'),
                '{pr_tracking}',
                ${JSON.stringify({ pr_number, branch, changed_files })}
              )
          END
          WHERE agent = 'engineer'
          AND action_type = 'feature_request'
          AND status = 'success'
          AND company_id IS NULL
          AND started_at > NOW() - INTERVAL '1 hour'
          AND (output::text ILIKE ${'%' + completed_id + '%'} OR description ILIKE ${'%' + completed_id + '%'})
        `.catch((e: any) => { console.warn(`[backlog] store PR tracking for ${completed_id} failed: ${e?.message || e}`); });
      }

    } else if (completed_status === "partial") {
      // Partial: max_turns reached but commits exist on branch — continue, don't penalize
      const turnsUsed = body.turns_used || 0;
      const maxTurns = body.max_turns || 50;
      const lastCommit = body.last_commit || "";
      const branchName = body.branch || "";
      const continuationTurns = Math.min(Math.ceil(maxTurns * 1.5), 75);

      console.log(`[backlog] Partial completion for "${completed_id}" — ${turnsUsed}/${maxTurns} turns, continuing with ${continuationTurns}. Last commit: ${lastCommit}`);

      // Mark as in_progress (not failed) — this is a continuation, not a retry.
      // Use in_progress (not dispatched) so the 30-min stale dispatch cleanup doesn't
      // reset this item while the continuation is still running.
      await sql`
        UPDATE hive_backlog
        SET status = 'in_progress', dispatched_at = NOW(),
            notes = COALESCE(notes, '') || ${` [partial] Graceful exit at ${turnsUsed}/${maxTurns} turns — progress preserved${branchName ? ` on ${branchName}` : ''}. Last: ${lastCommit.slice(0, 80)}. Continuing with ${continuationTurns} turns.`}
        WHERE id = ${completed_id} AND status IN ('dispatched', 'in_progress')
      `.catch((e: any) => { console.warn(`[backlog] mark ${completed_id} as partial failed: ${e?.message || e}`); });

      // Dispatch continuation with more turns
      const [item] = await sql`
        SELECT id, title, description, priority, category, spec, github_issue_number FROM hive_backlog WHERE id = ${completed_id}
      `.catch(() => []);

      if (item) {
        try {
          const ghPat = await getGitHubToken().catch(() => null) || process.env.GH_PAT;
          if (ghPat) {
            const contRes = await fetch("https://api.github.com/repos/carloshmiranda/hive/dispatches", {
              method: "POST",
              headers: { Authorization: `token ${ghPat}`, Accept: "application/vnd.github.v3+json", "Content-Type": "application/json" },
              body: JSON.stringify({
                event_type: "feature_request",
                client_payload: {
                  task: item.description || item.title,
                  company: "_hive",
                  backlog_id: item.id,
                  github_issue: item.github_issue_number || undefined,
                  priority: item.priority,
                  chain_next: true,
                  spec: item.spec || undefined,
                  max_turns: continuationTurns,
                  meta: {
                    title: item.title,
                    model: "claude-sonnet-4-20250514",
                    github_issue: item.github_issue_number || undefined,
                    priority_score: 14,
                    continuation: true,
                    previous_branch: branchName,
                    previous_turns: turnsUsed,
                  },
                },
              }),
              signal: AbortSignal.timeout(10000),
            });

            if (contRes.ok || contRes.status === 204) {
              console.log(`[backlog] Continuation dispatched for "${item.title}" with ${continuationTurns} turns`);
              // Create an agent_actions record so the engineer_busy gate blocks concurrent
              // dispatches during the continuation. Without this, the gate sees no running
              // record and allows a second item to be dispatched in parallel.
              const [contAction] = await sql`
                INSERT INTO agent_actions (agent, action_type, status, description, started_at)
                VALUES ('engineer', 'feature_request', 'running',
                  ${`Continuation: "${item.title}" (${item.priority}, ${continuationTurns} turns)`},
                  NOW())
                RETURNING id
              `.catch(() => [{ id: null }]);
              if (contAction?.id) {
                await sql`
                  UPDATE hive_backlog SET dispatch_id = ${contAction.id} WHERE id = ${completed_id}
                `.catch(() => {});
              }
            }
          }
        } catch (e) {
          console.warn("[backlog] Partial continuation dispatch failed:", e instanceof Error ? e.message : "unknown");
        }
      }

      // Don't fall through to normal dispatch — continuation takes the slot
      return json({ dispatched: true, status: "continued_partial", item_id: completed_id, continuation_turns: continuationTurns });

    } else if (completed_status !== "in_progress" && completed_status !== "success") {
      // Failed: learn from it. Track attempts, decompose if too big.
      const [item] = await sql`
        SELECT id, title, description, notes, priority, category, spec FROM hive_backlog WHERE id = ${completed_id}
      `.catch((e: any) => { console.warn(`[backlog] fetch item ${completed_id} for failure handling failed: ${e?.message || e}`); return []; });
      const prevAttempts = (item?.notes || "").match(/\[attempt \d+\] (Failed|Auto-blocked|\[)/g)?.length || 0;
      const attempt = prevAttempts + 1;
      const errorMsg = body.error || "";

      // Infra crashes (GitHub Actions runner never started — no execution output file, OIDC failure)
      // get a short 30-min retry, not the standard 2–6h cooldown for code failures.
      // We detect them by the "workflow_crash" prefix set in hive-engineer.yml and track them
      // separately with [infra-crash N] so they don't increment the code-failure attempt counter.
      if (errorMsg.startsWith("workflow_crash") && item) {
        const prevInfraCrashes = ((item.notes || "").match(/\[infra-crash \d+\]/g) || []).length;
        const infraAttempt = prevInfraCrashes + 1;
        // Cap at 5 infra retries before treating like a real failure and letting normal cooldown take over
        if (infraAttempt <= 5) {
          await sql`
            UPDATE hive_backlog
            SET status = 'ready',
                dispatched_at = NOW() - INTERVAL '90 minutes',
                notes = COALESCE(notes, '') || ${` [infra-crash ${infraAttempt}] GitHub Actions infra failure — retrying after ~30 min. Error: ${errorMsg.slice(0, 120)}`}
            WHERE id = ${completed_id} AND status IN ('dispatched', 'in_progress')
          `.catch((e: any) => { console.warn(`[backlog] infra-crash reset failed: ${e?.message || e}`); });
          console.log(`[backlog] infra-crash ${infraAttempt} for "${item.title}" — reset to ready with 30-min cooldown`);
          return json({ dispatched: false, status: "infra_crash_retry_scheduled", item_id: completed_id, infra_attempt: infraAttempt });
        }
        console.log(`[backlog] infra-crash ${infraAttempt} for "${item.title}" — exceeded retry cap, falling through to normal failure handling`);
      }

      const turnsMatch = errorMsg.match(/\((\d+) turns\)/);
      const turnsUsed = turnsMatch ? parseInt(turnsMatch[1]) : 0;
      // Detect max_turns failures — use spec.estimated_turns as baseline (80% threshold)
      const specTurns = item?.spec?.estimated_turns || 50;
      const isMaxTurns = errorMsg.includes("max_turns") || errorMsg.includes("error_max_turns") || turnsUsed >= Math.floor(specTurns * 0.8);

      // Continuation dispatch: if max_turns + partial progress + not already continued,
      // give the agent another shot with 1.5x turns instead of decomposing.
      const progressClass = body.progress_class || "";
      const lastCommit = body.last_commit || "";
      const alreadyContinued = (item?.notes || "").includes("[continued]");
      let continued = false;
      if (isMaxTurns && item && progressClass === "partial_progress" && !alreadyContinued) {
        try {
          const continuationTurns = Math.min(Math.ceil(turnsUsed * 1.5), 75);
          console.log(`[backlog] Continuation dispatch for "${item.title}" — partial progress detected (${turnsUsed} turns used, granting ${continuationTurns}). Last commit: ${lastCommit}`);

          const ghPat = await getGitHubToken().catch(() => null) || process.env.GH_PAT;
          if (ghPat) {
            const contRes = await fetch("https://api.github.com/repos/carloshmiranda/hive/dispatches", {
              method: "POST",
              headers: { Authorization: `Bearer ${ghPat}`, Accept: "application/vnd.github.v3+json" },
              body: JSON.stringify({
                event_type: "feature_request",
                client_payload: {
                  source: "backlog_continuation",
                  company: "_hive",
                  title: `[cont] ${item.title}`,
                  task: `CONTINUATION — pick up where the previous session left off.\n\nOriginal task: ${item.title}\n${item.description}\n\n⚠️ Previous session made progress but ran out of turns.\nLast commit: ${lastCommit}\n\nInstructions:\n1. Check the current branch state: git log --oneline origin/main..HEAD\n2. Review what was done and what remains\n3. Continue from the existing work — do NOT restart from scratch\n4. Focus on completing remaining acceptance criteria`,
                  backlog_id: item.id,
                  github_issue: item.github_issue_number || undefined,
                  priority: item.priority,
                  chain_next: true,
                  spec: item.spec || undefined,
                  max_turns: continuationTurns,
                },
              }),
              signal: AbortSignal.timeout(10000),
            });

            if (contRes.ok || contRes.status === 204) {
              // Use in_progress (not dispatched) so the 30-min stale dispatch cleanup doesn't
              // reset this item while the continuation is still running.
              await sql`
                UPDATE hive_backlog
                SET status = 'in_progress', dispatched_at = NOW(),
                    notes = COALESCE(notes, '') || ${` [continued] Continuation dispatch after partial progress (${turnsUsed} turns → ${continuationTurns} turns). Last: ${lastCommit.slice(0, 80)}`}
                WHERE id = ${completed_id}
              `.catch((e: any) => { console.warn(`[backlog] mark ${completed_id} as continued failed: ${e?.message || e}`); });
              // Create an agent_actions record so the engineer_busy gate blocks concurrent
              // dispatches during the continuation.
              const [contAction] = await sql`
                INSERT INTO agent_actions (agent, action_type, status, description, started_at)
                VALUES ('engineer', 'feature_request', 'running',
                  ${`Continuation (failed handler): "${item.title}" (${item.priority}, ${continuationTurns} turns)`},
                  NOW())
                RETURNING id
              `.catch(() => [{ id: null }]);
              if (contAction?.id) {
                await sql`
                  UPDATE hive_backlog SET dispatch_id = ${contAction.id} WHERE id = ${completed_id}
                `.catch(() => {});
              }
              continued = true;
              console.log(`[backlog] Continuation dispatched for "${item.title}" with ${continuationTurns} turns`);
            }
          }
        } catch (e) {
          console.warn("[backlog] Continuation dispatch failed:", e instanceof Error ? e.message : "unknown");
        }
      }

      // Track this item as failed for cooldown purposes (unless continued or will be auto-blocked)
      // max_turns = immediate decompose (1 attempt) — retrying same item with same turn budget fails identically
      const maxAttempts = isMaxTurns ? 1 : 3;
      if (item && attempt < maxAttempts && !continued) {
        await trackFailedBacklogItem(item.id, attempt);
      }

      // On max_turns failure: LLM-assisted decompose if complexity is M or L
      // Depth limit: allow up to 3 levels of LLM decomposition before blocking
      const MAX_DECOMPOSE_DEPTH = 3;
      const depthMatch = (item?.notes || "").match(/\[decompose-depth:(\d+)\]/);
      const parentDepth = depthMatch ? parseInt(depthMatch[1]) : 0;
      const atMaxDepth = parentDepth >= MAX_DECOMPOSE_DEPTH;
      let decomposed = false;
      if (isMaxTurns && item && atMaxDepth && !continued) {
        console.log(`[backlog] Skipping decomposition for "${item.title}" — at max depth ${parentDepth}. Blocking instead.`);
      }
      if (isMaxTurns && item && !atMaxDepth && !continued) {
        try {
          const { generateSpec, decomposeTask } = await import("@/lib/backlog-planner");
          let spec = item.spec;

          // (1) Call the planner to get a spec if none exists
          if (!spec || !spec.approach) {
            spec = await generateSpec(
              { id: item.id, title: item.title, description: item.description, priority: item.priority, category: item.category, notes: item.notes },
              sql
            );
          }

          // (2) LLM-assisted decomposition — produces independent, testable sub-tasks
          // No complexity gate: max_turns is empirical proof the task is too large, regardless of spec estimate.
          if (spec && Array.isArray(spec.approach) && spec.approach.length >= 1) {
            const subTasks = await decomposeTask(
              { id: item.id, title: item.title, description: item.description, priority: item.priority, category: item.category, notes: item.notes },
              spec,
              `max_turns failure after ${attempt} attempt(s) — task too large for single session`,
              sql
            );

            if (subTasks.length >= 2) {
              const depthNote = `[decompose-depth:${parentDepth + 1}]`;

              // Build decomposition context document (ADR-031 Phase 2)
              const { createDecompositionContext } = await import("@/lib/github-issues");
              const decompCtx = createDecompositionContext(
                { title: item.title, description: item.description, notes: item.notes, spec: item.spec },
                subTasks.map((s, i) => ({ id: `pending-${i}`, title: s.title }))
              );

              // Insert sub-tasks with parent_id and shared decomposition_context
              const insertedSubTasks: Array<{ id: string; title: string }> = [];
              for (const sub of subTasks) {
                const [inserted] = await sql`
                  INSERT INTO hive_backlog (title, description, priority, category, status, source, spec, notes, parent_id, decomposition_context)
                  VALUES (
                    ${sub.title.slice(0, 200)}, ${sub.description.slice(0, 2000)},
                    ${item.priority}, ${item.category || "feature"}, 'ready', 'auto_decompose',
                    ${JSON.stringify({
                      complexity: sub.complexity,
                      estimated_turns: sub.estimated_turns,
                      acceptance_criteria: sub.acceptance_criteria,
                      affected_files: sub.affected_files,
                      approach: [sub.description],
                      risks: []
                    })},
                    ${depthNote},
                    ${completed_id},
                    ${JSON.stringify(decompCtx)}
                  )
                  RETURNING id, title
                `.catch((e: any) => { console.warn(`[backlog] insert decomposed sub-item failed: ${e?.message || e}`); return []; });
                if (inserted) insertedSubTasks.push({ id: inserted.id, title: inserted.title });
              }

              // Store decomposition context on parent too
              await sql`
                UPDATE hive_backlog
                SET status = 'blocked', dispatched_at = NULL,
                    decomposition_context = ${JSON.stringify(decompCtx)},
                    notes = COALESCE(notes, '') || ${` [attempt ${attempt}] [auto-decomposed] LLM split into ${subTasks.length} independent sub-tasks.`}
                WHERE id = ${completed_id}
              `.catch((e: any) => { console.warn(`[backlog] mark ${completed_id} as auto-decomposed failed: ${e?.message || e}`); });

              // Link GitHub sub-issues (fire-and-forget)
              if (item.github_issue_number && insertedSubTasks.length > 0) {
                import("@/lib/github-issues").then(async ({ createBacklogIssue, linkSubIssue, getIssueInternalId }) => {
                  const HIVE_REPO = "carloshmiranda/hive";
                  for (const sub of insertedSubTasks) {
                    // Create GitHub Issue for sub-task
                    const subItem = await sql`SELECT id, title, description, priority, category, theme FROM hive_backlog WHERE id = ${sub.id}`.catch(() => []);
                    if (!subItem[0]) continue;
                    const si = subItem[0];
                    const issueResult = await createBacklogIssue({ id: si.id, title: si.title, description: si.description || "", priority: si.priority || "P2", category: si.category || "feature", theme: si.theme });
                    if (issueResult) {
                      // Store issue number on sub-task
                      await sql`UPDATE hive_backlog SET github_issue_number = ${issueResult.number} WHERE id = ${sub.id}`.catch(() => {});
                      // Link as sub-issue to parent
                      await linkSubIssue(HIVE_REPO, item.github_issue_number, issueResult.id);
                    }
                  }
                }).catch(() => {});
              }

              decomposed = true;
              console.log(`[backlog] LLM-decomposed "${item.title}" → ${insertedSubTasks.length} sub-tasks: ${subTasks.map(s => s.title).join(", ")}`);
            }
          }

          // (3) If LLM decomposition failed, block for human review.
          // Decomposition requires reasoning — mechanical text splitting produces garbage titles.
          if (!decomposed) {
            console.log(`[backlog] LLM decomposition failed for "${item.title}" — blocking for human review`);
            await sql`
              UPDATE hive_backlog
              SET status = 'blocked', dispatched_at = NULL,
                  notes = COALESCE(notes, '') || ${` [attempt ${attempt}] [decompose-failed] LLM decomposition produced no sub-tasks. Needs human review or better spec.`}
              WHERE id = ${completed_id}
            `.catch((e: any) => { console.warn(`[backlog] mark ${completed_id} as decompose-failed: ${e?.message || e}`); });
          }
        } catch (e) {
          console.warn("[backlog] Auto-decompose on max_turns failure failed:", e instanceof Error ? e.message : "unknown");
        }
      }

      // After successful decomposition, dispatch the first sub-task immediately.
      // Don't fall through to normal selection — call ourselves recursively so the
      // fresh sub-tasks get picked up by the scoring/dispatch flow without delay.
      if (decomposed) {
        console.log(`[backlog] Post-decompose: triggering immediate dispatch of first sub-task`);
        try {
          // Trigger a new dispatch cycle via QStash (guaranteed delivery)
          // so the fresh sub-tasks get dispatched without waiting for Sentinel.
          await qstashPublish("/api/backlog/dispatch", {
            trigger: "post_decompose",
            parent_id: completed_id,
          }, {
            deduplicationId: `post-decompose-${completed_id}-${Date.now().toString(36)}`,
          });
          console.log(`[backlog] Post-decompose dispatch triggered for sub-tasks of ${completed_id}`);
        } catch (e) {
          console.warn("[backlog] Post-decompose dispatch trigger failed:", e instanceof Error ? e.message : "unknown");
        }
      }

      if (!decomposed && !continued) {
        // Work stealing: after 2 failures, mark task as stealable
        if (attempt >= 2 && !isMaxTurns) { // Don't apply work stealing to max_turns failures (they need decomposition)
          try {
            const failingAgent = body.agent || 'engineer';
            await markTaskAsStealable(sql, completed_id, failingAgent);
            console.log(`[backlog] Marked "${item?.title || completed_id}" as stealable after ${attempt} failures by ${failingAgent}`);
          } catch (e) {
            console.warn(`[backlog] Failed to mark item ${completed_id} as stealable: ${e}`);
          }
        }

        // Auto-block: 1 attempt for max_turns errors (decompose immediately), 3 for others
        const blockThreshold = isMaxTurns ? 1 : 3;
        if (attempt >= blockThreshold) {
          await sql`
            UPDATE hive_backlog
            SET status = 'blocked', dispatched_at = NULL,
                notes = COALESCE(notes, '') || ${` [attempt ${attempt}] Auto-blocked after ${attempt} ${isMaxTurns ? 'max_turns' : ''} failures — needs decomposition or manual review.`}
            WHERE id = ${completed_id} AND status IN ('dispatched', 'in_progress')
          `.catch((e: any) => { console.warn(`[backlog] block item ${completed_id} after ${attempt} failures failed: ${e?.message || e}`); });
        } else {
          // Back to ready with attempt context.
          // Keep dispatched_at = NOW() so the 2h SQL cooldown filter works
          // even across Vercel restarts (persistent, not in-memory).
          await sql`
            UPDATE hive_backlog
            SET status = 'ready', dispatched_at = NOW(),
                notes = COALESCE(notes, '') || ${` [attempt ${attempt}] Failed — will retry with more context.`}
            WHERE id = ${completed_id} AND status IN ('dispatched', 'in_progress')
          `.catch((e: any) => { console.warn(`[backlog] reset item ${completed_id} to ready after attempt ${attempt} failed: ${e?.message || e}`); });
        }
      }

      // Notify on continuation, decomposition or repeated failures
      if (continued || decomposed || attempt >= 3) {
        await qstashPublish("/api/notify", {
          agent: "backlog",
          action: continued ? "continuation" : decomposed ? "auto_decomposed" : "repeated_failure",
          company: "hive",
          status: continued ? "continued" : decomposed ? "decomposed" : "failed",
          summary: (() => {
            const issueRef = item?.github_issue_number ? ` #${item.github_issue_number}` : "";
            const name = `"${item?.title || completed_id}"${issueRef}`;
            return continued
              ? `${name} hit max_turns with partial progress — continuing with more turns.`
              : decomposed
              ? `${name} hit max_turns — auto-decomposed into smaller tasks. Dispatching first sub-task.`
              : `${name} has failed ${attempt} times. Still retrying but may need a different approach.`;
          })(),
        }, { retries: 2 }).catch(() => {});
      }
    }
  }

  // Event-driven PR review on completion callbacks
  if (completed_id) {
    await reviewAndMergeOpenPRs(sql);
  }

  // Helper: schedule a chain retry via QStash when dispatch is temporarily blocked.
  // This ensures the loop self-sustains instead of dying on transient blocks.
  const scheduleChainRetry = async (reason: string, delayMinutes: number) => {
    try {
      await qstashPublish("/api/backlog/dispatch", {
        trigger: "chain_retry",
        retry_reason: reason,
      }, {
        deduplicationId: `chain-retry-${reason}-${Date.now().toString(36)}`,
        delay: delayMinutes * 60, // QStash delay is in seconds
      });
      console.log(`[backlog] Chain retry scheduled in ${delayMinutes}m (reason: ${reason})`);
    } catch (e) {
      console.warn(`[backlog] Chain retry scheduling failed:`, e instanceof Error ? e.message : "unknown");
    }
  };

  // Check budget — don't dispatch if Claude budget is exhausted
  const [usage] = await sql`
    SELECT COALESCE(SUM(tokens_used), 0)::int as turns
    FROM agent_actions
    WHERE agent IN ('ceo', 'scout', 'engineer', 'evolver', 'healer')
    AND started_at > NOW() - INTERVAL '5 hours'
  `.catch(() => [{ turns: 0 }]);
  const budgetUsedPct = Number(usage?.turns || 0) / 225;
  if (budgetUsedPct > 0.85) {
    const freeWorkers = await dispatchFreeWorkers(cronSecret!, sql).catch(() => []);
    await scheduleChainRetry("budget_exhausted", 30);
    return json({ dispatched: false, reason: "budget_exhausted", budget_pct: Math.round(budgetUsedPct * 100), free_workers_dispatched: freeWorkers, chain_retry: true });
  }

  // Rate-limit check: if the most recent rate-limit failure was <30 min ago,
  // pause brain-agent dispatch but still dispatch free workers.
  // Time-based (not count-based) so we resume as soon as the limit resets.
  const [rateLimitRow] = await sql`
    SELECT MAX(finished_at) as last_rate_limit
    FROM agent_actions
    WHERE agent IN ('ceo', 'scout', 'engineer', 'evolver', 'healer')
    AND status = 'failed'
    AND (error ILIKE '%rate limit%' OR error ILIKE '%session limit%'
      OR error ILIKE '%usage cap%' OR error ILIKE '%too many%'
      OR error ILIKE '%quota%' OR error ILIKE '%limit reached%'
      OR error ILIKE '%max_tokens%' OR error ILIKE '%capacity%')
    AND finished_at > NOW() - INTERVAL '2 hours'
  `.catch(() => [{ last_rate_limit: null }]);
  const lastRateLimit = rateLimitRow?.last_rate_limit ? new Date(rateLimitRow.last_rate_limit) : null;
  const rateLimitCooldownActive = lastRateLimit && (Date.now() - lastRateLimit.getTime()) < 30 * 60 * 1000;
  if (rateLimitCooldownActive) {
    const freeWorkers = await dispatchFreeWorkers(cronSecret!, sql).catch(() => []);
    const minutesRemaining = Math.round(30 - (Date.now() - lastRateLimit!.getTime()) / 60000);
    await scheduleChainRetry("rate_limit_cooldown", minutesRemaining + 1);
    return json({ dispatched: false, reason: "rate_limit_cooldown", cooldown_remaining_minutes: minutesRemaining, free_workers_dispatched: freeWorkers, chain_retry: true });
  }

  // Hive-specific rate limit check: if recent Hive engineer failures are all rate limits, skip dispatch
  const recentHiveFailures = await sql`
    SELECT description, error, finished_at
    FROM agent_actions
    WHERE agent = 'engineer'
      AND company_id IS NULL  -- Hive work only
      AND status = 'failed'
      AND finished_at > NOW() - INTERVAL '3 hours'
    ORDER BY finished_at DESC
    LIMIT 5
  `.catch(() => []);

  if (recentHiveFailures.length >= 2) {
    const rateLimitPatterns = [
      /rate limit/i, /session limit/i, /usage cap/i, /too many/i, /quota/i,
      /limit reached/i, /max_tokens/i, /capacity/i, /you've hit your limit/i
    ];

    let consecutiveRateLimits = 0;
    for (const failure of recentHiveFailures) {
      const errorText = `${failure.description || ''} ${failure.error || ''}`.toLowerCase();
      const isRateLimit = rateLimitPatterns.some(pattern => pattern.test(errorText));
      if (isRateLimit) {
        consecutiveRateLimits++;
      } else {
        break; // Stop counting if we hit a non-rate-limit failure
      }
    }

    if (consecutiveRateLimits >= 2 && consecutiveRateLimits >= Math.min(recentHiveFailures.length, 3)) {
      const freeWorkers = await dispatchFreeWorkers(cronSecret!, sql).catch(() => []);
      console.log(`[backlog] Rate limit skip: last ${consecutiveRateLimits} Hive engineer failures were Claude API rate limits`);
      await scheduleChainRetry("hive_rate_limit_skip", 60); // Wait 1 hour
      return json({
        dispatched: false,
        reason: "hive_rate_limit_skip",
        consecutive_rate_limit_failures: consecutiveRateLimits,
        free_workers_dispatched: freeWorkers,
        chain_retry: true
      });
    }
  }

  // Clean up ghost locks: running engineer actions >30 min old with no completion callback.
  // Our engineer jobs complete in 5-15 min. 30 min is a safe threshold that catches
  // callback failures without risk of clearing genuinely running jobs.
  await sql`
    UPDATE agent_actions
    SET status = 'failed', finished_at = NOW(),
        error = 'Ghost lock: auto-cleanup — action ran >30 min without completion callback'
    WHERE agent = 'engineer' AND status = 'running'
    AND company_id IS NULL
    AND started_at < NOW() - INTERVAL '30 minutes'
  `.catch(() => {});

  // PR review runs on every dispatch call — even when Engineer is busy.
  // If a ci_fix Engineer was dispatched for a failing PR, skip new backlog work this cycle.
  // PRs must be fixed before piling on new work to avoid compounding merge conflicts.
  if (!completed_id) {
    const { ciFixDispatched } = await reviewAndMergeOpenPRs(sql);
    if (ciFixDispatched) {
      await scheduleChainRetry("ci_fix_dispatched", 15);
      return json({ dispatched: false, reason: "ci_fix_dispatched", chain_retry: true });
    }
  }

  // Check for running Hive Engineer jobs (dedup) — includes ci_fix so a running PR fix
  // also blocks new feature work from starting in parallel.
  const [running] = await sql`
    SELECT id FROM agent_actions
    WHERE agent = 'engineer' AND status = 'running'
    AND action_type IN ('feature_request', 'self_improvement', 'ci_fix')
    AND company_id IS NULL
    AND started_at > NOW() - INTERVAL '1 hour'
    LIMIT 1
  `.catch(() => []);
  if (running) {
    // Don't retry — the running engineer will chain-dispatch when it finishes
    return json({ dispatched: false, reason: "engineer_busy", running_id: running.id });
  }

  // Per-agent hourly rate limit: prevent dispatch burst patterns
  // Brain agents: 3/hr, Workers: 8/hr (defense-in-depth on top of specific dedup guards)
  const agentToDispatch = 'engineer'; // This route dispatches engineer for Hive work
  const isWorkerAgent = ['growth', 'outreach', 'ops'].includes(agentToDispatch);
  const hourlyThreshold = isWorkerAgent ? 8 : 10; // Workers: 8/hr, Brain agents: 10/hr (raised from 3 to drain Hive backlog)

  const [hourlyCount] = await sql`
    SELECT COUNT(*)::int as dispatch_count FROM agent_actions
    WHERE agent = ${agentToDispatch}
    AND company_id IS NULL  -- Hive work only
    AND started_at > NOW() - INTERVAL '1 hour'
    AND status IN ('running', 'success', 'failed')  -- All dispatch attempts
  `.catch(() => [{ dispatch_count: 0 }]);

  if (hourlyCount.dispatch_count >= hourlyThreshold) {
    // Log the rate limit hit for debugging
    await sql`
      INSERT INTO agent_actions (agent, action_type, status, description, started_at, finished_at)
      VALUES (${agentToDispatch}, 'dispatch_attempt', 'skipped',
        ${`Per-agent hourly rate limit exceeded: ${hourlyCount.dispatch_count}/${hourlyThreshold} dispatches in last hour`},
        NOW(), NOW())
    `.catch(() => {});

    console.log(`[backlog] Rate limit: ${agentToDispatch} blocked - ${hourlyCount.dispatch_count}/${hourlyThreshold} dispatches in last hour`);
    return json({
      dispatched: false,
      reason: "rate_limited",
      agent: agentToDispatch,
      hourly_count: hourlyCount.dispatch_count,
      threshold: hourlyThreshold
    });
  }

  // Stale dispatch cleanup: items stuck in 'dispatched' for >30 min
  // with no Engineer run picking them up — reset to ready so they can be retried.
  // This prevents items from blocking the cascade indefinitely.
  await sql`
    UPDATE hive_backlog
    SET status = 'ready', dispatched_at = NULL,
        notes = COALESCE(notes, '') || ' [stale] Dispatch expired after 30min with no callback — reset to ready.'
    WHERE status = 'dispatched'
    AND dispatched_at < NOW() - INTERVAL '30 minutes'
  `.catch(() => {});

  // PR queue gate: don't pile up PRs that increase merge conflict risk.
  // If 3+ PRs are still open after review, force the system to clear its queue first.
  const [prQueue] = await sql`
    SELECT COUNT(*)::int as open_prs FROM hive_backlog
    WHERE status = 'pr_open' AND pr_number IS NOT NULL
  `.catch(() => [{ open_prs: 0 }]);
  const openPRCount = Number(prQueue?.open_prs || 0);
  if (openPRCount >= 2) {
    // Actively try to clear the PR queue by triggering a health check (Check 38 merges PRs)
    await qstashPublish("/api/cron/company-health", {
      trigger: "pr_queue_flush",
      open_prs: openPRCount,
    }, {
      deduplicationId: `pr-flush-${Date.now().toString(36)}`,
    }).catch(() => {});
    const freeWorkers = await dispatchFreeWorkers(cronSecret!, sql).catch(() => []);
    await scheduleChainRetry("pr_queue_full", 10);
    return json({ dispatched: false, reason: "pr_queue_full", open_prs: openPRCount, free_workers_dispatched: freeWorkers, chain_retry: true, pr_flush_triggered: true });
  }

  // Check for recently dispatched backlog items (covers the race window
  // between dispatch and the Engineer registering as 'running' in agent_actions)
  const [recentDispatch] = await sql`
    SELECT id, title FROM hive_backlog
    WHERE status = 'dispatched'
    AND dispatched_at > NOW() - INTERVAL '10 minutes'
    LIMIT 1
  `.catch(() => []);
  if (recentDispatch) {
    return json({ dispatched: false, reason: "recent_dispatch_pending", item: recentDispatch.title });
  }

  // =========================================================================
  // Blocked item recycler: process items stuck in 'blocked' that need decomposition.
  // Without this, blocked items are a dead-end — no workflow ever picks them up.
  // Runs once per dispatch cycle (max 2 items) to avoid starving normal dispatch.
  // =========================================================================
  try {
    const blockedItems = await sql`
      SELECT id, title, description, priority, category, notes, spec, source
      FROM hive_backlog
      WHERE status = 'blocked'
      AND (
        notes ILIKE '%[needs_decomposition]%'
        OR notes ILIKE '%[auto-blocked]%'
        OR (notes ILIKE '%max_turns failures%' AND source NOT IN ('auto_decompose', 'decomposed'))
      )
      AND NOT notes ILIKE '%[recycled]%'
      AND NOT notes ILIKE '%[manual_spec_needed]%'
      AND created_at > NOW() - INTERVAL '7 days'
      ORDER BY
        CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,
        created_at ASC
      LIMIT 2
    `.catch(() => []);

    for (const item of blockedItems) {
      const isSubTask = item.source === 'auto_decompose' || item.source === 'decomposed';
      if (isSubTask) {
        // Sub-tasks that failed: unblock for retry with fresh cooldown instead of decomposing further
        await sql`
          UPDATE hive_backlog
          SET status = 'ready', dispatched_at = NULL,
              notes = COALESCE(notes, '') || ' [recycled] Sub-task unblocked for retry.'
          WHERE id = ${item.id} AND status = 'blocked'
        `.catch(() => {});

        // Re-add to dispatch queue when recycled to ready (will be scored in next rebuild)
        console.log(`[backlog] Recycled sub-task: "${item.title}" → ready for retry`);
        continue;
      }

      // Parent items: trigger LLM decomposition
      try {
        const { generateSpec, decomposeTask } = await import("@/lib/backlog-planner");
        let spec = item.spec;
        if (!spec || !spec.approach) {
          spec = await generateSpec(
            { id: item.id, title: item.title, description: item.description, priority: item.priority, category: item.category, notes: item.notes },
            sql
          );
        }

        if (spec && Array.isArray(spec.approach) && spec.approach.length >= 1) {
          const subTasks = await decomposeTask(
            { id: item.id, title: item.title, description: item.description, priority: item.priority, category: item.category, notes: item.notes },
            spec,
            `recycled from blocked status — previous attempts failed`,
            sql
          );

          if (subTasks.length >= 2) {
            for (const sub of subTasks) {
              await sql`
                INSERT INTO hive_backlog (title, description, priority, category, status, source, spec)
                VALUES (
                  ${sub.title.slice(0, 200)}, ${sub.description.slice(0, 2000)},
                  ${item.priority}, ${item.category || "feature"}, 'ready', 'auto_decompose',
                  ${JSON.stringify({
                    complexity: sub.complexity,
                    estimated_turns: sub.estimated_turns,
                    acceptance_criteria: sub.acceptance_criteria,
                    affected_files: sub.affected_files,
                    approach: [sub.description],
                    risks: []
                  })}
                )
              `.catch(() => {});
            }
            await sql`
              UPDATE hive_backlog
              SET notes = COALESCE(notes, '') || ${` [recycled] Decomposed into ${subTasks.length} sub-tasks.`}
              WHERE id = ${item.id}
            `.catch(() => {});
            console.log(`[backlog] Recycled blocked item: "${item.title}" → ${subTasks.length} sub-tasks`);
          } else {
            // Decomposition produced <2 tasks — unblock for direct retry
            await sql`
              UPDATE hive_backlog
              SET status = 'ready', dispatched_at = NULL,
                  notes = COALESCE(notes, '') || ' [recycled] Decomposition produced too few sub-tasks — unblocked for direct retry.'
              WHERE id = ${item.id} AND status = 'blocked'
            `.catch(() => {});
          }
        } else {
          // No spec possible — unblock for direct retry (P0s will bypass spec gate)
          await sql`
            UPDATE hive_backlog
            SET status = 'ready', dispatched_at = NULL,
                notes = COALESCE(notes, '') || ' [recycled] No spec generated — unblocked for retry.'
            WHERE id = ${item.id} AND status = 'blocked'
          `.catch(() => {});
        }
      } catch (decompErr) {
        // Mark as recycled even on failure to prevent retry loops
        await sql`
          UPDATE hive_backlog
          SET notes = COALESCE(notes, '') || ' [recycled] Decomposition failed — needs manual review.'
          WHERE id = ${item.id}
        `.catch(() => {});
        console.warn(`[backlog] Recycler decomposition failed for "${item.title}":`, decompErr instanceof Error ? decompErr.message : "unknown");
      }
    }
  } catch (recyclerErr) {
    console.warn('[backlog] Blocked item recycler failed:', recyclerErr instanceof Error ? recyclerErr.message : 'unknown');
    // Non-blocking — continue with normal dispatch
  }

  // Flag problem statements as needing decomposition before dispatch
  // This prevents vague/high-level descriptions from being dispatched repeatedly
  try {
    const flagResult = await flagProblemStatementsAsNeedingDecomposition(sql);
    if (flagResult.flagged > 0) {
      console.log(`[backlog] Flagged ${flagResult.flagged} problem statements:`,
                  flagResult.items.map(i => i.title).join(', '));
    }
  } catch (e) {
    console.warn('[backlog] Problem statement detection failed:', e instanceof Error ? e.message : 'unknown');
    // Non-blocking, continue with dispatch
  }

  // Fetch ready backlog items — priority-ordered (P0 first, then P1, P2, P3).
  // Within same priority, items WITH specs are preferred (they have actionable plans
  // and estimated turns, reducing max_turns failures). Items without specs are picked
  // only when no spec'd items of same priority exist.
  // Budget check above already gates total spend. Chain dispatch uses the same
  // query as regular dispatch — no P0/P1 filter. If high-priority items exist
  // they go first; if not, P2/P3 dispatch immediately instead of waiting for Sentinel.
  const isChainDispatch = !!completed_id;

  // Work stealing: check for stealable tasks first before regular backlog
  let stealableResult: WorkStealingResult | null = null;
  try {
    stealableResult = await claimStealableTask(sql, 'engineer');
    if (stealableResult.task) {
      console.log(`[backlog] Work stealing success: claimed "${stealableResult.task.title}" (reason: ${stealableResult.reason}${stealableResult.contested ? ', contested' : ''})`);

      // Dispatch the stealable task immediately
      const stealableItem = stealableResult.task;
      const ghPat = await getGitHubToken().catch(() => null) || process.env.GH_PAT;

      if (ghPat) {
        const res = await fetch("https://api.github.com/repos/carloshmiranda/hive/dispatches", {
          method: "POST",
          headers: { Authorization: `Bearer ${ghPat}`, Accept: "application/vnd.github.v3+json" },
          body: JSON.stringify({
            event_type: "feature_request",
            client_payload: {
              source: "work_stealing",
              company: "_hive",
              task: stealableItem.description,
              title: stealableItem.title,
              backlog_id: stealableItem.id,
              priority: stealableItem.priority,
              chain_next: true,
              max_turns: 50,
              meta: {
                attempt: stealableItem.failure_count + 1,
                stolen_from: stealableItem.original_agent,
                claim_type: stealableResult.reason
              }
            }
          }),
        });

        if (res.ok) {
          console.log(`[backlog] Work stealing dispatch successful for "${stealableItem.title}"`);
          return json({
            dispatched: true,
            stolen: true,
            item_id: stealableItem.id,
            item_title: stealableItem.title,
            original_agent: stealableItem.original_agent,
            failure_count: stealableItem.failure_count,
            reason: stealableResult.reason
          });
        } else {
          console.warn(`[backlog] Work stealing dispatch failed: ${res.status} ${await res.text()}`);
          // Reset the claim since dispatch failed
          await sql`
            UPDATE hive_backlog
            SET claimed_by = NULL, claimed_at = NULL, status = 'ready'
            WHERE id = ${stealableItem.id}
          `;
        }
      }
    } else if (stealableResult.reason !== "no_stealable_tasks") {
      console.log(`[backlog] Work stealing: ${stealableResult.reason}`);
    }
  } catch (e) {
    console.warn(`[backlog] Work stealing failed: ${e}`);
  }

  // Try Redis-first dispatch: pop highest-priority item from queue
  let redisResult = null;
  try {
    redisResult = await queuePop();
    if (redisResult) {
      console.log(`[backlog] Redis queue hit: item ${redisResult.itemId} (score: ${redisResult.score})`);
    }
  } catch (e) {
    console.warn(`[backlog] Redis queue pop failed, falling back to SQL: ${e instanceof Error ? e.message : String(e)}`);
  }

  let backlogItems: any[] = [];

  // If Redis returned an item, fetch it from database for full details
  if (redisResult) {
    try {
      backlogItems = await sql`
        SELECT * FROM hive_backlog
        WHERE id = ${redisResult.itemId}
        AND status IN ('ready', 'approved')
        AND NOT (
          notes ~ '\\[attempt \\d+\\] (Failed|Auto-blocked|\\[)'
          AND dispatched_at IS NOT NULL
          AND dispatched_at > NOW() - CASE
            WHEN notes ~ '\\[attempt 3\\] (Failed|Auto-blocked|\\[)' THEN INTERVAL '24 hours'
            WHEN notes ~ '\\[attempt 2\\] (Failed|Auto-blocked|\\[)' THEN INTERVAL '6 hours'
            ELSE INTERVAL '2 hours'
          END
        )
        AND (SELECT count(*) FROM regexp_matches(notes, '\\[attempt \\d+\\] (Failed|Auto-blocked|\\[)', 'g')) < 3
      `;

      // If item is no longer eligible, remove it from queue and fall back to SQL
      if (backlogItems.length === 0) {
        console.log(`[backlog] Redis item ${redisResult.itemId} no longer eligible, removing from queue`);
        // Item is removed from queue when status changes
        redisResult = null;
      } else {
        console.log(`[backlog] Redis dispatch: using item ${redisResult.itemId}`);
      }
    } catch (e) {
      console.error(`[backlog] Failed to fetch Redis item ${redisResult?.itemId || 'unknown'}, falling back to SQL: ${e instanceof Error ? e.message : String(e)}`);
      backlogItems = [];
      redisResult = null;
    }
  }

  // Fallback to SQL if Redis unavailable or returned invalid item
  if (!redisResult) {
    try {
      backlogItems = await sql`
        SELECT * FROM hive_backlog
        WHERE (
          status IN ('ready', 'approved')
          OR (status = 'planning' AND dispatched_at < NOW() - INTERVAL '2 minutes')
        )
        AND NOT (
          notes ~ '\\[attempt \\d+\\] (Failed|Auto-blocked|\\[)'
          AND dispatched_at IS NOT NULL
          AND dispatched_at > NOW() - CASE
            WHEN notes ~ '\\[attempt 3\\] (Failed|Auto-blocked|\\[)' THEN INTERVAL '24 hours'
            WHEN notes ~ '\\[attempt 2\\] (Failed|Auto-blocked|\\[)' THEN INTERVAL '6 hours'
            ELSE INTERVAL '2 hours'
          END
        )
        AND (SELECT count(*) FROM regexp_matches(notes, '\\[attempt \\d+\\] (Failed|Auto-blocked|\\[)', 'g')) < 3
        ORDER BY
          CASE WHEN spec IS NOT NULL AND spec->>'approach' IS NOT NULL THEN 0 ELSE 1 END,
          CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,
          created_at ASC
        LIMIT 10
      `;

      if (isChainDispatch) {
        console.log(`[backlog] Chain dispatch: all priorities, budget-gated (triggered by completion of ${completed_id})`);
      }
    } catch (e) {
      console.error("[backlog] Query failed:", e instanceof Error ? e.message : String(e));
      backlogItems = [];
    }
  }

  // Auto-block items with 3+ failed attempts at query time (defense-in-depth).
  // The callback handler also blocks after 3 attempts, but if the chain callback
  // never fires (e.g., dispatch lost), items stay in 'ready' and keep getting
  // dispatched. This catches that case.
  const MAX_ATTEMPTS = 3;
  for (const item of backlogItems) {
    const attemptCount = (item.notes || "").match(/\[attempt \d+\] (Failed|Auto-blocked|\[)/g)?.length || 0;
    if (attemptCount >= MAX_ATTEMPTS && item.status !== "blocked") {
      await sql`
        UPDATE hive_backlog
        SET status = 'blocked',
            notes = COALESCE(notes, '') || ${` [auto-blocked] ${attemptCount} failed attempts — needs decomposition or manual review.`}
        WHERE id = ${item.id} AND status IN ('ready', 'approved', 'planning')
      `.catch(() => {});

      // Remove from dispatch queue when auto-blocked
      await queueSyncItem(item.id, 'blocked').catch(() => {});
    }
  }
  backlogItems = backlogItems.filter(item => {
    const attemptCount = (item.notes || "").match(/\[attempt \d+\] (Failed|Auto-blocked|\[)/g)?.length || 0;
    return attemptCount < MAX_ATTEMPTS;
  });

  // Filter out items that require manual/human work (can't be automated)
  // Only match terms that genuinely indicate non-automatable work.
  // "manual" alone is too broad — it matches "manual review" in technical contexts.
  // Cost-risk gate: items that could incur real costs or break billing must be approval-gated
  const COST_RISK_KEYWORDS = /\b(upgrade plan|vercel pro|paid tier|increase budget|billing|subscription|paid addon|spending limit|add credit card|scale up infra)\b/i;
  const costRiskItems = [];
  const safeBudgetItems = [];
  for (const item of backlogItems) {
    const text = `${item.title} ${item.description}`;
    if (COST_RISK_KEYWORDS.test(text)) {
      costRiskItems.push(item);
    } else {
      safeBudgetItems.push(item);
    }
  }
  // Mark cost-risk items as blocked with reason
  for (const item of costRiskItems) {
    if (item.status === "ready") {
      await sql`
        UPDATE hive_backlog
        SET status = 'blocked', notes = COALESCE(notes, '') || ' [auto] Cost-risk: may incur spend — needs approval.'
        WHERE id = ${item.id} AND status = 'ready'
      `.catch(() => {});

      // Remove from dispatch queue when cost-risk blocked
      await queueSyncItem(item.id, 'blocked').catch(() => {});
    }
  }
  if (costRiskItems.length > 0) {
    const titles = costRiskItems.map((i) => `• [${i.priority}] ${i.title}${i.github_issue_number ? ` #${i.github_issue_number}` : ""}`).join("\n");
    await qstashPublish("/api/notify", {
      agent: "backlog",
      action: "cost_risk_blocked",
      company: "hive",
      status: "needs_carlos",
      summary: `${costRiskItems.length} backlog item(s) blocked (cost risk):\n${titles}`,
    }, { retries: 2 }).catch(() => {});
  }
  backlogItems = safeBudgetItems;

  const MANUAL_KEYWORDS = /\b(buy domain|DNS records|sign up manually|create account manually|register manually|purchase|human intervention)\b/i;
  const automatable = [];
  const manualItems = [];
  for (const item of backlogItems) {
    if (MANUAL_KEYWORDS.test(item.description) || MANUAL_KEYWORDS.test(item.title)) {
      manualItems.push(item);
    } else {
      automatable.push(item);
    }
  }

  // Mark manual items as blocked so they don't get re-evaluated every cycle
  for (const item of manualItems) {
    if (item.status === "ready") {
      await sql`
        UPDATE hive_backlog
        SET status = 'blocked', notes = COALESCE(notes, '') || ' [auto] Requires manual action — skipped by dispatch.'
        WHERE id = ${item.id} AND status = 'ready'
      `.catch(() => {});
    }
  }

  // Notify about manual items that were blocked
  if (manualItems.length > 0) {
    const titles = manualItems.map((i) => `• [${i.priority}] ${i.title}${i.github_issue_number ? ` #${i.github_issue_number}` : ""}`).join("\n");
    await qstashPublish("/api/notify", {
      agent: "backlog",
      action: "manual_blocked",
      company: "hive",
      status: "needs_carlos",
      summary: `${manualItems.length} backlog item(s) need manual action:\n${titles}`,
    }, { retries: 2 }).catch(() => {});
  }

  // Filter out CI-impossible tasks: items that require external service access,
  // dashboard UI operations, CLI-only operations, or account configuration.
  // These burn 36 turns in GitHub Actions CI and always fail with max_turns.
  // CI-impossible: items requiring external service UI interaction, manual CLI, or account ops.
  // Be very specific to avoid blocking legitimate code tasks.
  const CI_IMPOSSIBLE_KEYWORDS = /\b((?:go to|open|access|configure in|set up in|log into|navigate to) (the )?(sentry|vercel|neon|stripe|upstash|resend) (dashboard|console|settings page|UI|web interface)|run CREATE EXTENSION|execute SQL (on|against|in) (neon|postgres|production)|psql -c|neon-cli|vercel-cli|install .* globally|npm install -g|sign up for .* account|register an account|log into .* (dashboard|console|portal)|open .* in (the |a )?browser|click (the |a )?.* button|manually configure|manually create|manually set up)\b/i;
  const ciImpossibleItems: any[] = [];
  const ciPossibleItems: any[] = [];
  for (const item of automatable) {
    const text = `${item.title} ${item.description}`;
    if (CI_IMPOSSIBLE_KEYWORDS.test(text)) {
      ciImpossibleItems.push(item);
    } else {
      ciPossibleItems.push(item);
    }
  }
  // Block CI-impossible items
  for (const item of ciImpossibleItems) {
    if (item.status === "ready") {
      await sql`
        UPDATE hive_backlog
        SET status = 'blocked', notes = COALESCE(notes, '') || ' [ci_impossible] Requires external service access or UI interaction — cannot be done in GitHub Actions CI.'
        WHERE id = ${item.id} AND status = 'ready'
      `.catch(() => {});
    }
  }
  if (ciImpossibleItems.length > 0) {
    const titles = ciImpossibleItems.map((i: any) => `• [${i.priority}] ${i.title}${i.github_issue_number ? ` #${i.github_issue_number}` : ""}`).join("\n");
    await qstashPublish("/api/notify", {
      agent: "backlog",
      action: "ci_impossible_blocked",
      company: "hive",
      status: "needs_carlos",
      summary: `${ciImpossibleItems.length} backlog item(s) blocked (CI-impossible):\n${titles}`,
    }, { retries: 2 }).catch(() => {});
  }

  // Detect items that need decomposition (problem statements vs actionable tasks)
  // Problem statements describe what's wrong without specifying what to build/fix,
  // causing Claude to exhaust at 0 turns. Flag these for manual decomposition.
  const decompositionItems: any[] = [];
  const actionableItems: any[] = [];
  for (const item of ciPossibleItems) {
    const description = (item.description || '').toLowerCase();
    const title = (item.title || '').toLowerCase();
    const combined = `${title} ${description}`;

    // Indicators of problem statements (what's wrong, not what to do)
    const problemIndicators = [
      /\b(error|bug|issue|problem|broken|failing|not working|doesn't work)\b/,
      /\b(97\+ wasted|eliminate|unblock)\b/,  // From this specific task
      /\b(causing .* to exhaust|exhausted after 0 turns)\b/,
      /\b(problems?:|issues?:|errors?:)\b/,
      /\b(we have|there is|there are) .* (error|issue|problem)/,
    ];

    // Indicators of actionable tasks (what to build/fix)
    const actionIndicators = [
      /\b(add|create|build|implement|update|fix|refactor|remove|delete)\b/,
      /\b(write|generate|install|configure|setup|deploy)\b/,
      /\b(change .* to|replace .* with|move .* to)\b/,
      /\b(in .*(\.ts|\.js|\.tsx|\.jsx|\.md|\.sql|\.yml|\.yaml))\b/,  // Mentions specific files
    ];

    const hasProblemIndicators = problemIndicators.some(pattern => pattern.test(combined));
    const hasActionIndicators = actionIndicators.some(pattern => pattern.test(combined));

    // Flag as needing decomposition if:
    // 1. Has problem indicators but no clear action indicators, OR
    // 2. Description is very short (< 50 chars) and vague
    const isVague = description.length < 50 && !hasActionIndicators;
    const isProblemStatement = hasProblemIndicators && !hasActionIndicators;

    if (isProblemStatement || isVague) {
      decompositionItems.push(item);
    } else {
      actionableItems.push(item);
    }
  }

  // Mark decomposition items as needing manual breakdown
  for (const item of decompositionItems) {
    if (item.status === "ready") {
      await sql`
        UPDATE hive_backlog
        SET status = 'blocked', notes = COALESCE(notes, '') || ' [needs_decomposition] Problem statement without actionable task — needs breakdown before dispatch.'
        WHERE id = ${item.id} AND status = 'ready'
      `.catch(() => {});
    }
  }

  // Notify about items that need decomposition
  if (decompositionItems.length > 0) {
    const titles = decompositionItems.map((i) => `• [${i.priority}] ${i.title}${i.github_issue_number ? ` #${i.github_issue_number}` : ""}`).join("\n");
    await qstashPublish("/api/notify", {
      agent: "backlog",
      action: "decomposition_needed",
      company: "hive",
      status: "needs_breakdown",
      summary: `${decompositionItems.length} backlog item(s) need decomposition (problem statements):\n${titles}`,
    }, { retries: 2 }).catch(() => {});
  }

  // Cooldown is now SQL-based (dispatched_at > NOW() - 2 hours for items with attempt notes)
  // No in-memory filter needed — survives Vercel restarts.
  const backlogItemsFiltered = actionableItems;
  const cooldownCount = 0; // SQL-level filtering already applied

  if (backlogItemsFiltered.length === 0) {
    const reason = "backlog_empty";
    const extra = isChainDispatch ? { chain_dispatch: true } : {};
    // If items were blocked this cycle, retry later — new items may become ready
    const totalBlocked = manualItems.length + ciImpossibleItems.length + decompositionItems.length;
    if (totalBlocked > 0) {
      await scheduleChainRetry("backlog_items_blocked", 15);
    }

    return json({
      dispatched: false,
      reason,
      manual_blocked: manualItems.length,
      ci_impossible_blocked: ciImpossibleItems.length,
      decomposition_blocked: decompositionItems.length,
      cooldown_blocked: cooldownCount,
      items_in_cooldown: 0, // cooldown is now SQL-level
      chain_retry: totalBlocked > 0,
      ...extra
    });
  }

  // Score items
  const [activeCount] = await sql`
    SELECT COUNT(*)::int as count FROM companies WHERE status IN ('mvp', 'active')
  `.catch(() => [{ count: 4 }]);
  const totalCompanies = Number(activeCount?.count || 4);

  const [failRate] = await sql`
    SELECT COUNT(*) FILTER (WHERE status = 'failed'
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
  `.catch(() => [{ rate: 0 }]);
  const overallRate = Number(failRate?.rate || 0);

  const scoredItems: any[] = [];

  for (const item of backlogItemsFiltered) {
    const keywords = item.title.split(/\s+/).filter((w: string) => w.length > 4).slice(0, 3);
    let relatedErrors = 0;
    let companiesAffected = 0;

    if (keywords.length > 0) {
      const pattern = keywords.join("|");
      const [errCount] = await sql`
        SELECT COUNT(*)::int as count FROM agent_actions
        WHERE status = 'failed' AND error IS NOT NULL
        AND finished_at > NOW() - INTERVAL '7 days'
        AND error ~* ${pattern}
      `.catch(() => [{ count: 0 }]);
      relatedErrors = Number(errCount?.count || 0);

      const [compCount] = await sql`
        SELECT COUNT(DISTINCT company_id)::int as count FROM agent_actions
        WHERE status = 'failed' AND error ~* ${pattern}
        AND finished_at > NOW() - INTERVAL '7 days'
        AND company_id IS NOT NULL
      `.catch(() => [{ count: 0 }]);
      companiesAffected = Number(compCount?.count || 0);
    }

    const [failedSimilar] = await sql`
      SELECT id FROM hive_backlog
      WHERE status IN ('blocked', 'rejected')
      AND title ILIKE ${item.title.slice(0, 40) + "%"}
      AND completed_at > NOW() - INTERVAL '30 days'
      LIMIT 1
    `.catch(() => []);

    const blocksAgents = detectBlockedAgents(item.title, item.description);
    const daysSinceCreated = Math.max(0, item.created_at ? (Date.now() - new Date(item.created_at).getTime()) / 86400000 : 0);
    const previousAttempts = (item.notes || "").match(/\[attempt \d+\] (Failed|Auto-blocked|\[)/g)?.length || 0;

    const scored = computeBacklogScore(item as BacklogItem, {
      relatedErrors,
      companiesAffected,
      systemFailureRate: overallRate,
      hasSimilarFailed: !!failedSimilar,
      blocksAgents,
      daysSinceCreated,
      totalCompanies,
      previousAttempts,
    });

    scoredItems.push(scored);
  }

  // Sort by score descending — highest priority first
  scoredItems.sort((a, b) => b.priority_score - a.priority_score);

  // Rebuild Redis queue with scored items (only when using SQL fallback)
  if (!redisResult && scoredItems.length > 0) {
    try {
      const queueItems = scoredItems.map(item => ({
        id: item.id,
        priority_score: item.priority_score
      }));
      await queueRebuild(queueItems);
      console.log(`[backlog] Redis queue rebuilt with ${queueItems.length} items`);
    } catch (e) {
      console.warn(`[backlog] Failed to rebuild Redis queue: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (scoredItems.length === 0) {
    return json({ dispatched: false, reason: "no_scorable_items" });
  }

  // =========================================================================
  // Agent Success Rate Weighting: deprioritize items for companies where
  // the engineer agent has poor success rates. Combines with circuit breaker state.
  // =========================================================================
  const agentSuccessRates = await getAgentSuccessRates(sql);
  const weightedItems = await applySuccessRateWeighting(sql, scoredItems, agentSuccessRates);
  const filteredItems = weightedItems.filter(item => item.success_rate_weight > 0.2); // Skip companies with <20% success rate

  if (filteredItems.length === 0 && weightedItems.length > 0) {
    // All items filtered out due to poor success rates
    const poorCompanies = weightedItems.filter(item => item.success_rate_weight <= 0.2).map(item => item.company_slug).filter(Boolean);
    return json({ dispatched: false, reason: "agent_success_rate_filtered", poor_companies: poorCompanies.slice(0, 3) });
  }

  const finalItems = filteredItems.length > 0 ? filteredItems : scoredItems;

  // Build ordered candidate list: specced items first (ready to dispatch immediately),
  // then specless items (need LLM spec generation which may fail).
  // This prevents OpenRouter outages from blocking the entire queue.
  // We try multiple candidates — if spec generation fails for one, we move to the next.
  const speccedCandidates: any[] = [];
  const speclessCandidates: any[] = [];

  for (const candidate of finalItems) {
    const candidateSpec = candidate.spec;
    const hasManualSpecInNotes = (candidate.notes || "").includes("[manual_spec]");
    const hasSpec = (candidateSpec && candidateSpec.acceptance_criteria) || hasManualSpecInNotes;
    const notes = candidate.notes || "";

    // Permanently blocked — skip and ensure blocked status
    // Exception: if [manual_spec] is present in notes OR spec field is now populated — allow dispatch
    // Exception: if force_respec=true — strip the block tag and allow a fresh spec attempt
    if (notes.includes("[manual_spec_needed]") && !hasManualSpecInNotes && !hasSpec) {
      if (force_respec) {
        // Strip [manual_spec_needed] and [no_spec] tags so spec generation runs fresh
        const cleanedNotes = notes
          .replace(/\[manual_spec_needed\][^\n]*/g, "")
          .replace(/\[no_spec\]/g, "")
          .trim();
        await sql`
          UPDATE hive_backlog
          SET notes = ${cleanedNotes || null}, status = 'ready', dispatched_at = NULL
          WHERE id = ${candidate.id}
        `.catch(() => {});
        candidate.notes = cleanedNotes || null;
        // Fall through — treat as specless candidate for fresh spec generation
      } else {
        await sql`
          UPDATE hive_backlog
          SET status = 'blocked', dispatched_at = NULL
          WHERE id = ${candidate.id} AND status IN ('ready', 'approved', 'planning')
        `.catch(() => {});
        continue;
      }
    }

    // Specless item that already failed once — block permanently
    // Exception: if [manual_spec] is present in notes OR spec field is now populated — allow dispatch
    if (notes.includes("[no_spec]") && !hasManualSpecInNotes && !hasSpec) {
      await sql`
        UPDATE hive_backlog
        SET status = 'blocked', dispatched_at = NULL,
            notes = COALESCE(notes, '') || ' [manual_spec_needed] Spec generation failed twice — requires manual spec or rewrite before dispatch.'
        WHERE id = ${candidate.id} AND status IN ('ready', 'approved', 'planning')
      `.catch(() => {});
      console.warn(`[backlog] Permanently blocked specless item: "${candidate.title}" — spec failed twice`);
      continue;
    }

    // Items with spec or P0 — immediately dispatchable
    if (hasSpec || candidate.priority === "P0") {
      speccedCandidates.push(candidate);
    } else {
      speclessCandidates.push(candidate);
    }
  }

  // Ordered: specced first (guaranteed dispatchable), then specless (may fail spec gen)
  const orderedCandidates = [...speccedCandidates, ...speclessCandidates];

  if (orderedCandidates.length === 0) {
    return json({ dispatched: false, reason: "no_spec_items_only", blocked_count: finalItems.length });
  }

  // Try candidates in order — skip items that fail spec generation
  let topItem: any = null;

  // We'll select the first item here, but the spec generation loop below
  // may advance to subsequent candidates if spec fails.
  topItem = orderedCandidates[0];

  addDispatchBreadcrumb({
    message: `Item selected: "${topItem.title}"`,
    category: "dispatch",
    data: { id: topItem.id, priority: topItem.priority, category: topItem.category, has_spec: !!topItem.spec },
  });

  // Auto-classify category if item has default category ('feature')
  if (topItem.category === 'feature') {
    try {
      const { classifyCategory } = await import("@/lib/task-classifier");
      const autoCategory = classifyCategory(topItem.title, topItem.description);

      if (autoCategory !== 'feature') {
        await sql`
          UPDATE hive_backlog
          SET category = ${autoCategory}
          WHERE id = ${topItem.id}
        `.catch(() => {});

        // Update the topItem object for consistency
        topItem.category = autoCategory;

        console.log(`[backlog] Auto-classified item "${topItem.title}" as category: ${autoCategory}`);
      }
    } catch (e) {
      console.warn(`[backlog] Category auto-classification failed:`, e instanceof Error ? e.message : "unknown");
      // Non-blocking — dispatch continues with original category
    }
  }

  // Check if item is company-specific and should be blocked
  const companySlug = await isCompanySpecific(topItem.title, topItem.description, sql);
  if (companySlug) {
    // Update the item status to 'blocked' with clear note
    await sql`
      UPDATE hive_backlog
      SET status = 'blocked',
          notes = COALESCE(notes, '') || ${` [scope] Company-specific task for ${companySlug} — should be a company task, not hive_backlog`}
      WHERE id = ${topItem.id} AND status IN ('ready', 'approved', 'planning')
    `.catch(() => {});

    console.warn(`[backlog] Blocked company-specific item: "${topItem.title}" (company: ${companySlug})`);

    // Skip to next item by recursively calling dispatch (but limit to prevent infinite loop)
    const recursionDepth = (body.recursion_depth || 0) + 1;
    if (recursionDepth < 5) {
      // Call self with recursion tracking to find next valid item
      return POST(new Request(req.url, {
        method: 'POST',
        headers: req.headers,
        body: JSON.stringify({ ...body, recursion_depth: recursionDepth })
      }));
    } else {
      return json({
        dispatched: false,
        reason: "too_many_company_specific_items",
        blocked_company_item: topItem.title,
        company_slug: companySlug
      });
    }
  }

  // Dispatch via GitHub Actions — use GitHub App installation token
  // GH_PAT fallback removed: gho_ OAuth tokens expire silently, causing 422s
  const ghPat = await getGitHubToken().catch((e) => {
    console.error(`[backlog] getGitHubToken failed: ${e instanceof Error ? e.message : e}`);
    return null;
  }) || process.env.GH_PAT;
  if (!ghPat) {
    return json({ dispatched: false, reason: "no_github_token" });
  }
  const tokenPrefix = ghPat.substring(0, 4);
  console.log(`[backlog] Using GitHub token: ${tokenPrefix}... (length: ${ghPat.length})`);

  // Previous attempt context is computed AFTER spec generation loop (topItem may change)

  // Planning phase — generate spec before dispatching (P0 hotfixes bypass).
  // If spec generation fails, try the next candidate instead of halting the chain.
  // This ensures one bad item doesn't block all dispatch.
  let spec = topItem.spec || null;
  // If human provided a manual spec via [manual_spec] tag in notes, synthesize a spec
  // object from the notes content so the spec generation loop is skipped entirely.
  if (!spec && (topItem.notes || "").includes("[manual_spec]")) {
    // Extract text between [manual_spec] and the next tag (or end of string)
    const manualSpecMatch = (topItem.notes || "").match(/\[manual_spec\]([\s\S]*?)(?=\s*\[(?!manual_spec)[^\]]+\]|$)/);
    const manualSpecText = manualSpecMatch ? manualSpecMatch[1].trim() : "";
    spec = {
      acceptance_criteria: manualSpecText
        ? [manualSpecText.slice(0, 2000)]
        : ["Manual spec provided — see item notes for implementation details"],
      approach: manualSpecText
        ? [manualSpecText.slice(0, 2000)]
        : ["Follow implementation instructions in item notes"],
      complexity: "medium",
      estimated_turns: 30,
      affected_files: [],
      risks: [],
    };
    console.log(`[backlog] Using manual spec from notes for "${topItem.title}" (spec text: ${manualSpecText.length} chars)`);
  }

  // LINEAGE FAILURE CAP: Prevent death loops from decomposed items
  // Check if this item's lineage (parent + all descendants) has exceeded the failure threshold.
  // When too many failures accumulate across the parent_id chain, mark the entire lineage
  // as needing manual intervention to stop mechanical decomposition loops.
  const lineageCheck = await computeLineageFailures(topItem.id, 5);
  if (lineageCheck.exceedsThreshold) {
    console.log(`[backlog] Lineage failure cap triggered for "${topItem.title}": ${lineageCheck.totalFailures} failures across ${lineageCheck.lineageIds.length} lineage items`);

    // Block entire lineage to prevent further dispatch attempts
    await blockLineageForManualSpec(
      lineageCheck.lineageIds,
      `Lineage failure cap exceeded (${lineageCheck.totalFailures} failures > 5 threshold)`
    );

    return json({
      dispatched: false,
      reason: "lineage_failure_cap_exceeded",
      lineage_failures: lineageCheck.totalFailures,
      lineage_size: lineageCheck.lineageIds.length,
      blocked_item: topItem.title
    });
  }

  // If item has no spec, dispatch to GitHub Actions for Claude Max spec generation.
  // This replaces the old inline OpenRouter spec gen — Claude writes far better specs.
  // The item stays in 'planning' status until the hive-spec-gen workflow writes the spec
  // and sets it back to 'ready'. Next Sentinel cycle will pick it up.
  if (!spec && topItem.priority !== "P0") {
    await sql`
      UPDATE hive_backlog SET status = 'planning', dispatched_at = NULL WHERE id = ${topItem.id}
    `.catch(() => {});

    // Remove from dispatch queue when moved to planning
    await queueSyncItem(topItem.id, 'planning').catch(() => {});

    if (ghPat) {
      addDispatchBreadcrumb({
        message: `Spec request dispatched to GitHub Actions for "${topItem.title}"`,
        category: "github",
        data: { backlog_id: topItem.id, priority: topItem.priority },
      });
      const specRes = await fetch("https://api.github.com/repos/carloshmiranda/hive/dispatches", {
        method: "POST",
        headers: { Authorization: `Bearer ${ghPat}`, Accept: "application/vnd.github.v3+json", "Content-Type": "application/json" },
        body: JSON.stringify({
          event_type: "spec_request",
          client_payload: {
            backlog_id: topItem.id,
            title: topItem.title,
            priority: topItem.priority,
          },
        }),
        signal: AbortSignal.timeout(8000),
      }).catch((e: any) => { console.warn(`[backlog] spec_request dispatch failed: ${e?.message || e}`); return null; });

      if (specRes?.ok || specRes?.status === 204) {
        console.log(`[backlog] No spec for "${topItem.title}" — dispatched spec_request to GitHub Actions`);
        return json({ dispatched: false, reason: "spec_requested", item_id: topItem.id });
      }
    }

    // No GH PAT or dispatch failed — revert to ready so it can be retried next cycle
    await sql`
      UPDATE hive_backlog SET status = 'ready', dispatched_at = NULL WHERE id = ${topItem.id}
    `.catch(() => {});

    // Re-add to dispatch queue when reverted to ready (need to recompute score)
    // For now, just trigger a queue rebuild on next Sentinel cycle
    console.warn(`[backlog] No spec for "${topItem.title}" and spec_request dispatch failed — reverted to ready`);
    return json({ dispatched: false, reason: "spec_requested_failed", item_id: topItem.id });
  }

  // Check for previous failed attempts — inject error context so Engineer learns
  // (computed after spec loop since topItem may have changed)
  const attemptMatch = (topItem.notes || "").match(/\[attempt \d+\] (Failed|Auto-blocked|\[)/g);
  const attemptCount = attemptMatch?.length || 0;
  let previousErrors = "";
  if (attemptCount > 0) {
    // Find the most recent Engineer failures related to this backlog item
    const failures = await sql`
      SELECT error, description, finished_at
      FROM agent_actions
      WHERE agent = 'engineer' AND status = 'failed'
      AND company_id IS NULL
      AND finished_at > NOW() - INTERVAL '7 days'
      AND (description ILIKE ${"%" + topItem.title.slice(0, 30) + "%"}
           OR output::text ILIKE ${"%" + (topItem.id || "") + "%"})
      ORDER BY finished_at DESC
      LIMIT 3
    `.catch(() => []);

    if (failures.length > 0) {
      previousErrors = failures
        .map((f, i) => `Attempt ${i + 1}: ${(f.error || f.description || "unknown error").slice(0, 300)}`)
        .join("\n");
    }
  }

  // Turn-budget gate: decompose before dispatching anything that exceeds the turn budget.
  // The complexity label is unreliable — estimated_turns is the real signal.
  // Default turn budget is 50 (Sonnet). Items estimating more than 80% of budget get decomposed first.
  const TURN_BUDGET = 50;
  const turnBudgetThreshold = Math.floor(TURN_BUDGET * 0.8); // 28
  const estimatedTurns = spec?.estimated_turns || 0;
  const needsDecompose = spec && (
    estimatedTurns > turnBudgetThreshold ||
    spec.complexity === "L" ||
    (spec.complexity === "M" && estimatedTurns > turnBudgetThreshold)
  );

  // Auto-decompose tasks that exceed turn budget — dispatch to GitHub Actions
  // Claude CLI on Actions has Max subscription access for quality decomposition.
  // Instead of burning 40+ turns on a task that will exhaust max_turns, decompose first.
  if (needsDecompose) {
    try {
      const ghRepo = process.env.GITHUB_REPOSITORY || "carloshmiranda/hive";
      const decomposeRes = await fetch(`https://api.github.com/repos/${ghRepo}/dispatches`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ghPat}`, Accept: "application/vnd.github.v3+json" },
        body: JSON.stringify({
          event_type: "decompose_task",
          client_payload: {
            backlog_id: topItem.id,
            title: topItem.title,
            priority: topItem.priority,
          },
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (decomposeRes.ok || decomposeRes.status === 204) {
        // Mark as planning — decompose workflow will create sub-tasks and re-trigger dispatch
        await sql`
          UPDATE hive_backlog
          SET status = 'planning',
              notes = COALESCE(notes, '') || ${` [decompose] Dispatched to GitHub Actions for Claude-assisted decomposition.`}
          WHERE id = ${topItem.id}
        `.catch(() => {});

        console.log(`[backlog] L-complexity task "${topItem.title}" dispatched to hive-decompose.yml for Claude decomposition`);
        return json({
          ok: true,
          dispatched: true,
          target: "decompose",
          backlog_id: topItem.id,
          reason: "L-complexity task routed to GitHub Actions for Claude-assisted decomposition",
        });
      }

      // If Actions dispatch failed, fall back to serverless LLM decomposition
      console.warn(`[backlog] Actions decompose dispatch failed (${decomposeRes.status}), falling back to serverless`);
      const { decomposeTask } = await import("@/lib/backlog-planner");
      const subTasks = await decomposeTask(
        { id: topItem.id, title: topItem.title, description: topItem.description, priority: topItem.priority, category: topItem.category, notes: topItem.notes },
        spec as any,
        `pre-dispatch decomposition fallback — Actions dispatch failed`,
        sql
      );

      if (subTasks.length >= 2) {
        for (let i = 1; i < subTasks.length; i++) {
          const sub = subTasks[i];
          await sql`
            INSERT INTO hive_backlog (title, description, priority, category, status, source, spec)
            VALUES (
              ${sub.title.slice(0, 200)},
              ${`Parent: ${topItem.title}\n\n${sub.description}`.slice(0, 2000)},
              ${topItem.priority}, ${topItem.category}, 'ready', 'decomposed',
              ${JSON.stringify({ acceptance_criteria: sub.acceptance_criteria, affected_files: sub.affected_files, approach: [sub.description], risks: [], complexity: sub.complexity, estimated_turns: sub.estimated_turns })}
            )
          `.catch(() => {});
        }

        const first = subTasks[0];
        spec = { ...spec, approach: [first.description], complexity: first.complexity, estimated_turns: first.estimated_turns, affected_files: first.affected_files, acceptance_criteria: first.acceptance_criteria };

        await sql`
          UPDATE hive_backlog SET spec = ${JSON.stringify(spec)}, notes = COALESCE(notes, '') || ${` [auto-decomposed] Serverless fallback split into ${subTasks.length} sub-tasks.`}
          WHERE id = ${topItem.id}
        `.catch(() => {});

        console.log(`[backlog] Serverless fallback decomposed "${topItem.title}" into ${subTasks.length} sub-tasks`);
      }
    } catch (decomposeErr) {
      console.warn(`[backlog] Decomposition failed for "${topItem.title}", dispatching as-is:`, decomposeErr instanceof Error ? decomposeErr.message : "unknown");
      // Non-blocking — dispatch proceeds with the original L-complexity spec
    }
  }

  // Build task with failure context + spec
  let taskDescription = topItem.description;
  if (previousErrors) {
    taskDescription += `\n\n⚠️ PREVIOUS ATTEMPTS FAILED (attempt ${attemptCount + 1}):\n${previousErrors}\n\nDo NOT repeat the same approach. Analyze why it failed and try a different strategy.`;
  }

  // Inject decomposition context for sub-tasks (ADR-031 Phase 2)
  if (topItem.parent_id && topItem.decomposition_context) {
    try {
      const { formatDecompositionContextForPrompt } = await import("@/lib/github-issues");
      const ctxBlock = formatDecompositionContextForPrompt(topItem.decomposition_context as any, topItem.title);
      taskDescription += `\n\n${ctxBlock}`;
    } catch {}
  }

  // Sanitize task input before GitHub dispatch
  taskDescription = sanitizeTaskInput(taskDescription);

  // Check for suspicious patterns and log if detected
  const suspiciousCheck = hasSuspiciousPatterns(taskDescription);
  if (suspiciousCheck.hasSuspicious) {
    console.warn(`[backlog] Suspicious patterns detected in task "${topItem.title}": ${suspiciousCheck.patterns.join(', ')} (risk: ${suspiciousCheck.riskLevel})`);

    // Log to agent_actions with flagged status
    await sql`
      INSERT INTO agent_actions (
        company_id, agent, action_type, description, status, output,
        started_at, finished_at
      ) VALUES (
        NULL, 'backlog_dispatch', 'security_check',
        ${`Suspicious patterns detected in backlog item "${topItem.title}": ${suspiciousCheck.patterns.join(', ')}`},
        'flagged', ${JSON.stringify({
          backlog_id: topItem.id,
          patterns: suspiciousCheck.patterns,
          risk_level: suspiciousCheck.riskLevel,
          title: topItem.title
        })}::jsonb,
        ${new Date().toISOString()}, ${new Date().toISOString()}
      )
    `.catch(e => console.error('[backlog] Failed to log suspicious pattern detection:', e));

    // Add note to backlog item
    await sql`
      UPDATE hive_backlog
      SET notes = COALESCE(notes || E'\n', '') || ${`[SECURITY] Suspicious patterns detected: ${suspiciousCheck.patterns.join(', ')} (risk: ${suspiciousCheck.riskLevel})`}
      WHERE id = ${topItem.id}
    `.catch(e => console.error('[backlog] Failed to update backlog item with security note:', e));
  }

  // Structured handoff: give the Engineer awareness of recent system activity.
  // This prevents blind dispatches — the agent knows what just happened.
  const [recentActivity] = await sql`
    SELECT json_agg(sub) as activity FROM (
      SELECT agent, action_type, status, SUBSTRING(description FROM 1 FOR 120) as summary,
        EXTRACT(EPOCH FROM (NOW() - COALESCE(finished_at, started_at)))::int / 60 as minutes_ago
      FROM agent_actions
      WHERE (status IN ('success', 'failed') AND finished_at > NOW() - INTERVAL '2 hours')
        OR status = 'running'
      ORDER BY COALESCE(finished_at, started_at) DESC
      LIMIT 8
    ) sub
  `.catch(() => [{ activity: null }]);
  const [prState] = await sql`
    SELECT json_agg(sub) as prs FROM (
      SELECT title, pr_number, status FROM hive_backlog
      WHERE status = 'pr_open' AND pr_number IS NOT NULL
      ORDER BY dispatched_at DESC LIMIT 5
    ) sub
  `.catch(() => [{ prs: null }]);

  // GitHub repository_dispatch limits client_payload to 10 properties max.
  // Consolidate metadata to stay under the limit.
  const dispatchPayload = {
    event_type: "feature_request",
    client_payload: {
      source: "backlog_chain",
      company: "_hive",
      task: taskDescription,
      backlog_id: topItem.id,
      priority: topItem.priority,
      chain_next: true,
      spec: spec || undefined,
      max_turns: attemptCount >= 2
        ? 60
        : Math.max(50, spec?.estimated_turns || 50),
      // Pack secondary fields into metadata to stay within 10-property limit
      meta: {
        title: topItem.title,
        priority_score: topItem.priority_score,
        attempt: attemptCount + 1,
        github_issue: topItem.github_issue_number || undefined,
        ...(attemptCount >= 2 ? { model: "claude-opus-4-20250514" } : {}),
        // Handoff context: what's happening in the system right now
        system_state: {
          recent_activity: recentActivity?.activity || [],
          open_prs: prState?.prs || [],
        },
      },
    },
  };
  // Intent registration: announce the planned work before dispatching.
  // Other agents reading system state will see this as "planned" and avoid conflicts.
  await sql`
    INSERT INTO agent_actions (agent, action_type, status, description, started_at)
    VALUES ('engineer', 'feature_request', 'pending',
      ${`[intent] Will dispatch: "${topItem.title}" (${topItem.priority}, attempt ${attemptCount + 1})`},
      NOW())
  `.catch(() => {});

  const payloadStr = JSON.stringify(dispatchPayload);
  console.log(`[backlog] Dispatch payload size: ${payloadStr.length} bytes`);
  addDispatchBreadcrumb({
    message: `GitHub dispatch: repository_dispatch engineer_task for "${topItem.title}"`,
    category: "github",
    data: { backlog_id: topItem.id, priority: topItem.priority, attempt: attemptCount + 1, payload_bytes: payloadStr.length },
  });

  // Sentry performance span: measures GitHub API call duration for tracing
  const res = await withSpan(
    "GitHub: repository_dispatch",
    "http.client",
    {
      "http.method": "POST",
      "http.url": "https://api.github.com/repos/carloshmiranda/hive/dispatches",
      "backlog.item_id": topItem.id,
      "backlog.priority": topItem.priority,
      "backlog.title": topItem.title.slice(0, 100),
      "backlog.attempt": attemptCount + 1,
    },
    async (span) => {
      const response = await fetch("https://api.github.com/repos/carloshmiranda/hive/dispatches", {
        method: "POST",
        headers: { Authorization: `Bearer ${ghPat}`, Accept: "application/vnd.github.v3+json", "Content-Type": "application/json" },
        body: payloadStr,
        signal: AbortSignal.timeout(10000),
      });
      span?.setAttributes({ "http.status_code": response.status });
      return response;
    }
  );

  if (res.ok || res.status === 204) {
    // Log the dispatch as an agent_action and capture its ID for tracing
    const [dispatchAction] = await sql`
      INSERT INTO agent_actions (agent, action_type, status, description, started_at)
      VALUES ('engineer', 'feature_request', 'running',
        ${`Backlog dispatch: "${topItem.title}" (${topItem.priority})`},
        NOW())
      RETURNING id
    `.catch(() => [{ id: null }]);

    // Mark as dispatched with race condition protection + link dispatch_id
    const updateResult = await sql`
      UPDATE hive_backlog
      SET status = 'dispatched', dispatched_at = NOW(),
          dispatch_id = ${dispatchAction?.id || null}
      WHERE id = ${topItem.id} AND status IN ('ready', 'approved', 'planning')
      RETURNING id
    `.catch(() => []);

    if (updateResult.length === 0) {
      console.warn(`[backlog] Race condition: item ${topItem.id} was already dispatched by another process`);
      return json({ dispatched: false, reason: "already_dispatched", item_id: topItem.id });
    }

    // Reset cooldown for successfully dispatched item
    await resetBacklogItemCooldown(topItem.id);
    syncIssueForBacklog(sql, topItem.id, "dispatched");

    // Log successful dispatch
    const dispatchType = isChainDispatch ? "chain" : "manual";
    console.log(`[backlog] ${dispatchType} dispatch: "${topItem.title}" (${topItem.priority}, score: ${topItem.priority_score})${attemptCount > 0 ? ` attempt ${attemptCount + 1}` : ""}`);

    addDispatchBreadcrumb({
      message: `Dispatch success: "${topItem.title}" → Engineer (${dispatchType})`,
      category: "dispatch",
      data: { backlog_id: topItem.id, dispatch_action_id: dispatchAction?.id, attempt: attemptCount + 1 },
    });

    // Notify via Telegram (QStash guarantees delivery)
    const issueRef = topItem.github_issue_number ? ` #${topItem.github_issue_number}` : "";
    await qstashPublish("/api/notify", {
      agent: "backlog",
      action: "dispatch",
      company: "_hive",
      status: "started",
      summary: `[${topItem.priority}] "${topItem.title}"${issueRef} dispatched to Engineer (score: ${topItem.priority_score}${attemptCount > 0 ? `, attempt ${attemptCount + 1}` : ""})`,
    }, { retries: 2 }).catch(() => {});

    return json({
      dispatched: true,
      item: { id: topItem.id, title: topItem.title, priority: topItem.priority, priority_score: topItem.priority_score },
      score_breakdown: topItem.score_breakdown,
    });
  }

  const errBody = await res.text().catch(() => "");
  console.error(`[backlog] GitHub dispatch FAILED: status=${res.status} token=${tokenPrefix}...(${ghPat.length}) item="${topItem.title}" body=${errBody}`);
  // Block the item that caused the 422 to prevent it from being picked again
  if (res.status === 422) {
    await sql`
      UPDATE hive_backlog
      SET status = 'blocked',
          notes = COALESCE(notes, '') || ${` [dispatch_failed] GitHub API returned ${res.status} — needs investigation.`}
      WHERE id = ${topItem.id} AND status IN ('ready', 'approved', 'planning')
    `.catch(() => {});
    syncIssueForBacklog(sql, topItem.id, "blocked");
  }
  await scheduleChainRetry("github_dispatch_failed", 5);
  return json({ dispatched: false, reason: "github_dispatch_failed", status: res.status, item_title: topItem.title, chain_retry: true });
}
