import { getDb, json, err } from "@/lib/db";
import { getSettingValue } from "@/lib/settings";
import { computeBacklogScore, detectBlockedAgents, isHighPriority } from "@/lib/backlog-priority";
import type { BacklogItem } from "@/lib/backlog-priority";
import { trackFailedBacklogItem, resetBacklogItemCooldown } from "@/lib/dispatch";
import { flagProblemStatementsAsNeedingDecomposition } from "@/lib/backlog-planner";
import { qstashPublish } from "@/lib/qstash";

const HIVE_URL = process.env.NEXT_PUBLIC_URL || "https://hive-phi.vercel.app";

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
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (authHeader !== `Bearer ${cronSecret}`) {
    const { validateOIDC } = await import("@/lib/oidc");
    const result = await validateOIDC(req);
    if (result instanceof Response) return result;
  }

  const sql = getDb();
  const body = await req.json().catch(() => ({}));
  let { completed_id, completed_status, pr_number, branch, changed_files } = body;

  // Auto-extract PR tracking data if not provided and status is success
  if (completed_id && completed_status === "success" && (!pr_number || !branch)) {
    try {
      const ghToken = await getSettingValue("github_token");
      if (ghToken) {
        // Look for recent open PRs on hive repo that might be related to this backlog item
        const prListRes = await fetch("https://api.github.com/repos/carloshmiranda/hive/pulls?state=open&per_page=10", {
          headers: { Authorization: `token ${ghToken}`, Accept: "application/vnd.github.v3+json" },
          signal: AbortSignal.timeout(5000),
        });

        if (prListRes.ok) {
          const openPRs = await prListRes.json();
          // Find PRs created in the last hour that start with "hive/"
          const recentPRs = openPRs.filter((pr: any) => {
            const createdAt = new Date(pr.created_at);
            const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
            return pr.head?.ref?.startsWith("hive/") && createdAt > oneHourAgo;
          });

          // Take the most recent one as likely candidate
          if (recentPRs.length > 0) {
            const candidatePR = recentPRs[0];
            pr_number = candidatePR.number;
            branch = candidatePR.head.ref;

            // Get changed files for this PR
            try {
              const filesRes = await fetch(`https://api.github.com/repos/carloshmiranda/hive/pulls/${pr_number}/files`, {
                headers: { Authorization: `token ${ghToken}`, Accept: "application/vnd.github.v3+json" },
                signal: AbortSignal.timeout(5000),
              });
              if (filesRes.ok) {
                const files = await filesRes.json();
                changed_files = files.map((f: any) => f.filename);
              }
            } catch (e: any) {
              console.warn(`[backlog] fetch PR #${pr_number} files failed: ${e?.message || e}`);
            }

            console.log(`[backlog] Auto-extracted PR tracking: #${pr_number} on ${branch}`);
          }
        }
      }
    } catch (e) {
      console.warn("[backlog] Failed to auto-extract PR tracking:", e instanceof Error ? e.message : "unknown");
      // Non-blocking, continue without PR data
    }
  }

  // Cooldown is now SQL-based (no in-memory cleanup needed)

  // If a completed item was passed, update its status
  if (completed_id && completed_status) {
    if (completed_status === "success") {
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
      } else {
        // No PR number — Engineer completed via direct commit or the PR info was lost.
        // Mark as done to prevent phantom pr_open items.
        await sql`
          UPDATE hive_backlog
          SET status = 'done', completed_at = NOW(),
              notes = COALESCE(notes, '') || ' Completed via chain dispatch (no PR created — direct commit or PR info missing).'
          WHERE id = ${completed_id} AND status IN ('dispatched', 'in_progress')
        `.catch((e: any) => { console.warn(`[backlog] mark item ${completed_id} done failed: ${e?.message || e}`); });
      }

      // Store PR tracking data in the agent_actions record
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

    } else {
      // Failed: learn from it. Track attempts, decompose if too big.
      const [item] = await sql`
        SELECT id, title, description, notes, priority, category, spec FROM hive_backlog WHERE id = ${completed_id}
      `.catch((e: any) => { console.warn(`[backlog] fetch item ${completed_id} for failure handling failed: ${e?.message || e}`); return []; });
      const prevAttempts = (item?.notes || "").match(/\[attempt \d+\]/g)?.length || 0;
      const attempt = prevAttempts + 1;
      const errorMsg = body.error || "";
      const turnsMatch = errorMsg.match(/\((\d+) turns\)/);
      const turnsUsed = turnsMatch ? parseInt(turnsMatch[1]) : 0;
      const isMaxTurns = errorMsg.includes("max_turns") || errorMsg.includes("error_max_turns") || turnsUsed >= 30;

      // Track this item as failed for cooldown purposes (unless it will be auto-blocked)
      // max_turns = immediate decompose (1 attempt) — retrying same item with same turn budget fails identically
      const maxAttempts = isMaxTurns ? 1 : 3;
      if (item && attempt < maxAttempts) {
        trackFailedBacklogItem(item.id, attempt);
      }

      // On max_turns failure: LLM-assisted decompose if complexity is M or L
      // Depth limit: don't decompose items that were already auto-decomposed (prevents infinite chains)
      const isAutoDecomposed = item?.source === 'auto_decompose' || item?.source === 'decomposed';
      let decomposed = false;
      if (isMaxTurns && item && isAutoDecomposed) {
        console.log(`[backlog] Skipping decomposition for "${item.title}" — already a sub-task (source: ${item.source}). Blocking instead.`);
      }
      if (isMaxTurns && item && !isAutoDecomposed) {
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
          if (spec && (spec.complexity === "M" || spec.complexity === "L") && Array.isArray(spec.approach) && spec.approach.length >= 2) {
            const subTasks = await decomposeTask(
              { id: item.id, title: item.title, description: item.description, priority: item.priority, category: item.category, notes: item.notes },
              spec,
              `max_turns failure after ${attempt} attempt(s) — task too large for single session`,
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
                `.catch((e: any) => { console.warn(`[backlog] insert decomposed sub-item failed: ${e?.message || e}`); });
              }

              // Mark the parent as blocked
              await sql`
                UPDATE hive_backlog
                SET status = 'blocked', dispatched_at = NULL,
                    notes = COALESCE(notes, '') || ${` [attempt ${attempt}] [auto-decomposed] LLM split into ${subTasks.length} independent sub-tasks.`}
                WHERE id = ${completed_id}
              `.catch((e: any) => { console.warn(`[backlog] mark ${completed_id} as auto-decomposed failed: ${e?.message || e}`); });
              decomposed = true;
              console.log(`[backlog] LLM-decomposed "${item.title}" → ${subTasks.length} sub-tasks: ${subTasks.map(s => s.title).join(", ")}`);
            }
          }
        } catch (e) {
          console.warn("[backlog] Auto-decompose on max_turns failure failed:", e instanceof Error ? e.message : "unknown");
        }
      }

      // After successful decomposition, skip circuit breaker checks and proceed
      // directly to dispatch selection. Freshly-created sub-tasks (S/M complexity)
      // should be the next items dispatched.
      if (decomposed) {
        console.log(`[backlog] Post-decompose: proceeding to dispatch first sub-task immediately`);
      }

      if (!decomposed) {
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

      // Notify on decomposition or repeated failures
      if (decomposed || attempt >= 3) {
        await qstashPublish("/api/notify", {
          agent: "backlog",
          action: decomposed ? "auto_decomposed" : "repeated_failure",
          company: "hive",
          status: decomposed ? "decomposed" : "failed",
          summary: decomposed
            ? `"${item?.title || completed_id}" hit max_turns — auto-decomposed into smaller tasks. Dispatching first sub-task.`
            : `"${item?.title || completed_id}" has failed ${attempt} times. Still retrying but may need a different approach.`,
        }, { retries: 2 }).catch(() => {});
      }
    }
  }

  // Event-driven PR review: review and auto-merge all open hive/ PRs on every callback
  // Runs on both success and failure — merging existing PRs is independent of current task outcome
  if (completed_id) {
    try {
      const ghToken = await getSettingValue("github_token");
      if (ghToken) {
        const { analyzePR, autoMergePR } = await import("@/lib/pr-risk-scoring");
        const prListRes = await fetch("https://api.github.com/repos/carloshmiranda/hive/pulls?state=open&per_page=30", {
          headers: { Authorization: `token ${ghToken}`, Accept: "application/vnd.github.v3+json" },
          signal: AbortSignal.timeout(10000),
        });
        if (prListRes.ok) {
          const openPRs = await prListRes.json();
          const hivePRs = openPRs.filter((pr: any) => pr.head?.ref?.startsWith("hive/"));
          for (const pr of hivePRs) {
            try {
              const analysis = await analyzePR("carloshmiranda", "hive", pr.number, ghToken);
              if (analysis.decision === "auto_merge") {
                const result = await autoMergePR("carloshmiranda", "hive", pr.number, ghToken, "squash");
                if (result.success) {
                  await sql`
                    UPDATE hive_backlog SET status = 'done',
                      notes = COALESCE(notes, '') || ${` [auto-merged] PR #${pr.number} merged on callback.`}
                    WHERE status = 'pr_open'
                      AND (notes LIKE ${'%PR #' + pr.number + '%'} OR notes LIKE ${'%' + pr.head.ref + '%'})
                  `.catch(() => {});
                  console.log(`[backlog] Auto-merged PR #${pr.number}: ${pr.title}`);
                }
              }
            } catch { /* individual PR analysis — non-blocking */ }
          }
        }
      }
    } catch (prErr) {
      console.warn("[backlog] Event-driven PR review failed:", prErr instanceof Error ? prErr.message : "unknown");
    }
  }

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
    return json({ dispatched: false, reason: "budget_exhausted", budget_pct: Math.round(budgetUsedPct * 100), free_workers_dispatched: freeWorkers });
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
    return json({ dispatched: false, reason: "rate_limit_cooldown", cooldown_remaining_minutes: minutesRemaining, free_workers_dispatched: freeWorkers });
  }

  // Check for running Hive Engineer jobs (dedup)
  const [running] = await sql`
    SELECT id FROM agent_actions
    WHERE agent = 'engineer' AND status = 'running'
    AND action_type IN ('feature_request', 'self_improvement')
    AND company_id IS NULL
    AND started_at > NOW() - INTERVAL '1 hour'
    LIMIT 1
  `.catch(() => []);
  if (running) {
    return json({ dispatched: false, reason: "engineer_busy", running_id: running.id });
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
  // Budget check above already gates total spend. Chain dispatch uses the same
  // query as regular dispatch — no P0/P1 filter. If high-priority items exist
  // they go first; if not, P2/P3 dispatch immediately instead of waiting for Sentinel.
  const isChainDispatch = !!completed_id;
  let backlogItems: any[];
  try {
    backlogItems = await sql`
      SELECT * FROM hive_backlog
      WHERE (
        status IN ('ready', 'approved')
        OR (status = 'planning' AND dispatched_at < NOW() - INTERVAL '2 minutes')
      )
      AND NOT (
        notes ILIKE '%[attempt %]%'
        AND dispatched_at IS NOT NULL
        AND dispatched_at > NOW() - INTERVAL '2 hours'
      )
      AND (array_length(regexp_match(notes, '\\[attempt \\d+\\]'), 1) IS NULL
           OR (SELECT count(*) FROM regexp_matches(notes, '\\[attempt \\d+\\]', 'g')) < 3)
      ORDER BY
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

  // Auto-block items with 3+ failed attempts at query time (defense-in-depth).
  // The callback handler also blocks after 3 attempts, but if the chain callback
  // never fires (e.g., dispatch lost), items stay in 'ready' and keep getting
  // dispatched. This catches that case.
  const MAX_ATTEMPTS = 3;
  for (const item of backlogItems) {
    const attemptCount = (item.notes || "").match(/\[attempt \d+\]/g)?.length || 0;
    if (attemptCount >= MAX_ATTEMPTS && item.status !== "blocked") {
      await sql`
        UPDATE hive_backlog
        SET status = 'blocked',
            notes = COALESCE(notes, '') || ${` [auto-blocked] ${attemptCount} failed attempts — needs decomposition or manual review.`}
        WHERE id = ${item.id} AND status IN ('ready', 'approved', 'planning')
      `.catch(() => {});
    }
  }
  backlogItems = backlogItems.filter(item => {
    const attemptCount = (item.notes || "").match(/\[attempt \d+\]/g)?.length || 0;
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
    }
  }
  if (costRiskItems.length > 0) {
    const titles = costRiskItems.map((i) => `• [${i.priority}] ${i.title}`).join("\n");
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
    const titles = manualItems.map((i) => `• [${i.priority}] ${i.title}`).join("\n");
    await qstashPublish("/api/notify", {
      agent: "backlog",
      action: "manual_blocked",
      company: "hive",
      status: "needs_carlos",
      summary: `${manualItems.length} backlog item(s) need manual action:\n${titles}`,
    }, { retries: 2 }).catch(() => {});
  }

  // Detect items that need decomposition (problem statements vs actionable tasks)
  // Problem statements describe what's wrong without specifying what to build/fix,
  // causing Claude to exhaust at 0 turns. Flag these for manual decomposition.
  const decompositionItems: any[] = [];
  const actionableItems: any[] = [];
  for (const item of automatable) {
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
    const titles = decompositionItems.map((i) => `• [${i.priority}] ${i.title}`).join("\n");
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

    return json({
      dispatched: false,
      reason,
      manual_blocked: manualItems.length,
      decomposition_blocked: decompositionItems.length,
      cooldown_blocked: cooldownCount,
      items_in_cooldown: 0, // cooldown is now SQL-level
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

  let topItem = null;
  let topScore = -1;

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
    const previousAttempts = (item.notes || "").match(/\[attempt \d+\]/g)?.length || 0;

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

    if (scored.priority_score > topScore) {
      topScore = scored.priority_score;
      topItem = scored;
    }
  }

  if (!topItem) {
    return json({ dispatched: false, reason: "no_scorable_items" });
  }

  // Dispatch via GitHub Actions
  const ghPat = await getSettingValue("github_token").catch(() => null);
  if (!ghPat) {
    return json({ dispatched: false, reason: "no_github_token" });
  }

  // Check for previous failed attempts — inject error context so Engineer learns
  const attemptMatch = (topItem.notes || "").match(/\[attempt \d+\]/g);
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

  // Planning phase — generate spec before dispatching (P0 hotfixes bypass)
  let spec = topItem.spec || null;
  if (!spec && topItem.priority !== "P0") {
    try {
      await sql`
        UPDATE hive_backlog SET status = 'planning' WHERE id = ${topItem.id}
      `.catch(() => {});

      const { generateSpec } = await import("@/lib/backlog-planner");
      spec = await generateSpec(
        {
          id: topItem.id,
          title: topItem.title,
          description: topItem.description,
          priority: topItem.priority,
          category: topItem.category,
          notes: topItem.notes,
        },
        sql
      );

      if (spec) {
        await sql`
          UPDATE hive_backlog SET spec = ${JSON.stringify(spec)} WHERE id = ${topItem.id}
        `.catch(() => {});
        console.log(`[backlog] Spec generated for "${topItem.title}" — complexity: ${spec.complexity}, turns: ${spec.estimated_turns}`);
      } else {
        console.log(`[backlog] Spec generation failed for "${topItem.title}" — dispatching without spec`);
      }
    } catch (e) {
      console.warn(`[backlog] Planning phase error:`, e instanceof Error ? e.message : "unknown");
      // Non-blocking — dispatch proceeds without spec
    }
  }

  // Auto-decompose L (large) complexity tasks — dispatch to GitHub Actions
  // Claude CLI on Actions has Max subscription access for quality decomposition.
  // Instead of burning 30+ turns on a task that will exhaust max_turns, decompose first.
  if (spec && spec.complexity === "L" && Array.isArray(spec.approach) && spec.approach.length >= 3) {
    try {
      const ghRepo = process.env.GITHUB_REPOSITORY || "carloshmiranda/hive";
      const decomposeRes = await fetch(`https://api.github.com/repos/${ghRepo}/dispatches`, {
        method: "POST",
        headers: { Authorization: `token ${ghPat}`, Accept: "application/vnd.github.v3+json" },
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

  const res = await fetch("https://api.github.com/repos/carloshmiranda/hive/dispatches", {
    method: "POST",
    headers: { Authorization: `token ${ghPat}`, Accept: "application/vnd.github.v3+json" },
    body: JSON.stringify({
      event_type: "feature_request",
      client_payload: {
        source: "backlog_chain",
        company: "_hive",
        task: taskDescription,
        backlog_id: topItem.id,
        priority: topItem.priority,
        priority_score: topItem.priority_score,
        attempt: attemptCount + 1,
        chain_next: true,
        spec: spec || undefined,
        // Model escalation: use Opus on 3rd+ attempt for harder reasoning
        ...(attemptCount >= 2 ? { model: "claude-opus-4-20250514", max_turns: 50 } : {}),
      },
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (res.ok || res.status === 204) {
    // Mark as dispatched with race condition protection
    const updateResult = await sql`
      UPDATE hive_backlog
      SET status = 'dispatched', dispatched_at = NOW()
      WHERE id = ${topItem.id} AND status IN ('ready', 'approved', 'planning')
      RETURNING id
    `.catch(() => []);

    if (updateResult.length === 0) {
      console.warn(`[backlog] Race condition: item ${topItem.id} was already dispatched by another process`);
      return json({ dispatched: false, reason: "already_dispatched", item_id: topItem.id });
    }

    // Reset cooldown for successfully dispatched item
    resetBacklogItemCooldown(topItem.id);

    // Log successful dispatch
    const dispatchType = isChainDispatch ? "chain" : "manual";
    console.log(`[backlog] ${dispatchType} dispatch: "${topItem.title}" (${topItem.priority}, score: ${topItem.priority_score})${attemptCount > 0 ? ` attempt ${attemptCount + 1}` : ""}`);

    // Notify via Telegram (QStash guarantees delivery)
    await qstashPublish("/api/notify", {
      agent: "backlog",
      action: "dispatch",
      company: "_hive",
      status: "started",
      summary: `[${topItem.priority}] "${topItem.title}" dispatched to Engineer (score: ${topItem.priority_score}${attemptCount > 0 ? `, attempt ${attemptCount + 1}` : ""})`,
    }, { retries: 2 }).catch(() => {});

    return json({
      dispatched: true,
      item: { id: topItem.id, title: topItem.title, priority: topItem.priority, priority_score: topItem.priority_score },
      score_breakdown: topItem.score_breakdown,
    });
  }

  console.error(`[backlog] GitHub dispatch failed: ${res.status} for "${topItem.title}" (${topItem.priority})`);
  return json({ dispatched: false, reason: "github_dispatch_failed", status: res.status, item_title: topItem.title });
}
