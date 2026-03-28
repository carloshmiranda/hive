import { getDb, json, err } from "@/lib/db";
import { getGitHubToken } from "@/lib/github-app";
import { computeBacklogScore, detectBlockedAgents, isHighPriority } from "@/lib/backlog-priority";
import type { BacklogItem } from "@/lib/backlog-priority";
import { trackFailedBacklogItem, resetBacklogItemCooldown } from "@/lib/dispatch";
import { flagProblemStatementsAsNeedingDecomposition, isCompanySpecific } from "@/lib/backlog-planner";
import { qstashPublish } from "@/lib/qstash";
import { sanitizeTaskInput, hasSuspiciousPatterns } from "@/lib/input-sanitizer";
import { setSentryTags } from "@/lib/sentry-tags";

const HIVE_URL = process.env.NEXT_PUBLIC_URL || "https://hive-phi.vercel.app";

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

  // PR tracking: only trust pr_number explicitly provided by the Engineer callback.
  // Previously auto-extracted from recent open PRs, but this caused wrong PR attribution
  // when multiple Engineer runs overlapped (grabbed most recent hive/* PR, not the right one).

  // Cooldown is now SQL-based (no in-memory cleanup needed)

  // If a completed item was passed, update its status
  if (completed_id && completed_status) {
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

          const ghPat = process.env.GH_PAT;
          if (ghPat) {
            const contRes = await fetch("https://api.github.com/repos/carloshmiranda/hive/dispatches", {
              method: "POST",
              headers: { Authorization: `token ${ghPat}`, Accept: "application/vnd.github.v3+json" },
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
              await sql`
                UPDATE hive_backlog
                SET status = 'dispatched', dispatched_at = NOW(),
                    notes = COALESCE(notes, '') || ${` [continued] Continuation dispatch after partial progress (${turnsUsed} turns → ${continuationTurns} turns). Last: ${lastCommit.slice(0, 80)}`}
                WHERE id = ${completed_id}
              `.catch((e: any) => { console.warn(`[backlog] mark ${completed_id} as continued failed: ${e?.message || e}`); });
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
        trackFailedBacklogItem(item.id, attempt);
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

  // Event-driven PR review: review and auto-merge all open hive/ PRs on every callback
  // Runs on both success and failure — merging existing PRs is independent of current task outcome
  if (completed_id) {
    try {
      const ghToken = await getGitHubToken();
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
                  const mergedItems = await sql`
                    UPDATE hive_backlog SET status = 'done', completed_at = NOW(),
                      notes = COALESCE(notes, '') || ${` [auto-merged] PR #${pr.number} merged on callback.`}
                    WHERE status = 'pr_open'
                      AND pr_number = ${pr.number}
                    RETURNING id
                  `.catch(() => []);
                  for (const merged of mergedItems || []) {
                    syncIssueForBacklog(sql, merged.id, "done");
                  }
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
    // Don't retry — the running engineer will chain-dispatch when it finishes
    return json({ dispatched: false, reason: "engineer_busy", running_id: running.id });
  }

  // PR queue gate: don't pile up PRs that increase merge conflict risk.
  // If 3+ PRs are open, force the system to clear its queue first.
  const [prQueue] = await sql`
    SELECT COUNT(*)::int as open_prs FROM hive_backlog
    WHERE status = 'pr_open' AND pr_number IS NOT NULL
  `.catch(() => [{ open_prs: 0 }]);
  const openPRCount = Number(prQueue?.open_prs || 0);
  if (openPRCount >= 3) {
    // Still try to merge what we have before giving up
    const freeWorkers = await dispatchFreeWorkers(cronSecret!, sql).catch(() => []);
    await scheduleChainRetry("pr_queue_full", 10);
    return json({ dispatched: false, reason: "pr_queue_full", open_prs: openPRCount, free_workers_dispatched: freeWorkers, chain_retry: true });
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
        AND dispatched_at > NOW() - CASE
          WHEN notes ILIKE '%[attempt 3]%' THEN INTERVAL '24 hours'
          WHEN notes ILIKE '%[attempt 2]%' THEN INTERVAL '6 hours'
          ELSE INTERVAL '2 hours'
        END
      )
      AND (array_length(regexp_match(notes, '\\[attempt \\d+\\]'), 1) IS NULL
           OR (SELECT count(*) FROM regexp_matches(notes, '\\[attempt \\d+\\]', 'g')) < 3)
      ORDER BY
        CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,
        CASE WHEN spec IS NOT NULL AND spec->>'approach' IS NOT NULL THEN 0 ELSE 1 END,
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

    scoredItems.push(scored);
  }

  // Sort by score descending — highest priority first
  scoredItems.sort((a, b) => b.priority_score - a.priority_score);

  if (scoredItems.length === 0) {
    return json({ dispatched: false, reason: "no_scorable_items" });
  }

  // Pick the first dispatchable item (skip specless non-P0 items, blocking them as we go)
  let topItem: any = null;
  for (const candidate of scoredItems) {
    const candidateSpec = candidate.spec;
    const hasSpec = candidateSpec && candidateSpec.acceptance_criteria;

    if (!hasSpec && candidate.priority !== "P0") {
      // Block specless item and continue to next
      const alreadyFailedSpec = (candidate.notes || "").includes("[no_spec]");
      if (alreadyFailedSpec) {
        await sql`
          UPDATE hive_backlog
          SET status = 'blocked', dispatched_at = NULL,
              notes = COALESCE(notes, '') || ' [manual_spec_needed] Spec generation failed twice — requires manual spec or rewrite before dispatch.'
          WHERE id = ${candidate.id} AND status IN ('ready', 'approved', 'planning')
        `.catch(() => {});
        console.warn(`[backlog] Permanently blocked specless item: "${candidate.title}" — spec failed twice`);
      } else {
        await sql`
          UPDATE hive_backlog
          SET status = 'blocked', dispatched_at = NULL,
              notes = COALESCE(notes, '') || ' [no_spec] Spec generation failed — needs manual spec or decomposition before dispatch.'
          WHERE id = ${candidate.id} AND status IN ('ready', 'approved', 'planning')
        `.catch(() => {});
        console.warn(`[backlog] Blocked specless item: "${candidate.title}" — skipping to next`);
      }
      continue;
    }

    topItem = candidate;
    break;
  }

  if (!topItem) {
    return json({ dispatched: false, reason: "no_spec_items_only", blocked_count: scoredItems.length });
  }

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

  // Dispatch via GitHub Actions
  const ghPat = await getGitHubToken().catch(() => null);
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

  const res = await fetch("https://api.github.com/repos/carloshmiranda/hive/dispatches", {
    method: "POST",
    headers: { Authorization: `token ${ghPat}`, Accept: "application/vnd.github.v3+json" },
    body: JSON.stringify({
      event_type: "feature_request",
      client_payload: {
        source: "backlog_chain",
        company: "_hive",
        task: taskDescription,
        title: topItem.title,
        backlog_id: topItem.id,
        github_issue: topItem.github_issue_number || undefined,
        priority: topItem.priority,
        priority_score: topItem.priority_score,
        attempt: attemptCount + 1,
        chain_next: true,
        spec: spec || undefined,
        // Turn budget: always give at least TURN_BUDGET (50) turns.
        // Estimates below budget are unreliable — tasks routinely need more turns than estimated
        // due to context loading, git operations, and unexpected complexity.
        // On 3rd+ attempt: escalate to Opus with 60-turn budget.
        max_turns: attemptCount >= 2
          ? 60
          : Math.max(50, spec?.estimated_turns || 50),
        ...(attemptCount >= 2 ? { model: "claude-opus-4-20250514" } : {}),
      },
    }),
    signal: AbortSignal.timeout(10000),
  });

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
    resetBacklogItemCooldown(topItem.id);
    syncIssueForBacklog(sql, topItem.id, "dispatched");

    // Log successful dispatch
    const dispatchType = isChainDispatch ? "chain" : "manual";
    console.log(`[backlog] ${dispatchType} dispatch: "${topItem.title}" (${topItem.priority}, score: ${topItem.priority_score})${attemptCount > 0 ? ` attempt ${attemptCount + 1}` : ""}`);

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
  console.error(`[backlog] GitHub dispatch failed: ${res.status} for "${topItem.title}" (${topItem.priority}): ${errBody.slice(0, 500)}`);
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
