import { getDb } from "@/lib/db";
import { createHmac, timingSafeEqual } from "crypto";
import { dispatchEvent } from "@/lib/dispatch";
import { analyzePR, autoMergePR } from "@/lib/pr-risk-scoring";
import { qstashPublish } from "@/lib/qstash";
import { setSentryTags } from "@/lib/sentry-tags";

// Receives GitHub webhook events
// Auth: HMAC-SHA256 signature verification via GITHUB_WEBHOOK_SECRET

function verifyGitHubSignature(payload: string, signature: string | null, secret: string): boolean {
  if (!signature) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  setSentryTags({
    action_type: "webhook",
    route: "/api/webhooks/github",
  });

  const rawBody = await req.text();
  const event = req.headers.get("x-github-event");
  const signature = req.headers.get("x-hub-signature-256");

  // Verify webhook signature
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (secret && !verifyGitHubSignature(rawBody, signature, secret)) {
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }

  const body = JSON.parse(rawBody);
  const sql = getDb();

  switch (event) {
    case "push": {
      const repoName = body.repository?.name;
      if (!repoName) break;

      // Self-monitoring: track pushes to the hive repo
      if (repoName === "hive") {
        const ref = body.ref;
        const headSha = body.head_commit?.id;
        if (ref === "refs/heads/main" && headSha) {
          await sql`
            INSERT INTO context_log (source, category, summary, detail, tags)
            VALUES ('code', 'milestone',
              ${('hive:main pushed — ' + (body.head_commit?.message || '').slice(0, 80))},
              ${JSON.stringify({ sha: headSha, pusher: body.pusher?.name, commits: body.commits?.length })},
              ${['deploy_tracking', 'hive_push']}
            )
          `;
        }
        break;
      }

      const [company] = await sql`SELECT id FROM companies WHERE slug = ${repoName}`;
      if (!company) break;

      const commitCount = body.commits?.length || 0;
      const pusher = body.pusher?.name || "unknown";
      const messages = (body.commits || []).map((c: any) => c.message).join(", ");

      await sql`
        INSERT INTO agent_actions (company_id, agent, action_type, description, status, started_at, finished_at)
        VALUES (${company.id}, 'engineer', 'git_push', ${`${commitCount} commit(s) pushed: ${messages.slice(0, 200)}`}, 'success', now(), now())
      `;
      break;
    }

    case "deployment_status": {
      const repoName = body.repository?.name;
      const state = body.deployment_status?.state; // success, failure, error, pending
      if (!repoName || !state) break;

      // Self-monitoring: track hive deploy failures
      if (repoName === "hive") {
        if (state === "failure" || state === "error") {
          const desc = body.deployment_status?.description || "Hive deploy failed";
          await sql`
            INSERT INTO context_log (source, category, summary, detail, tags)
            VALUES ('code', 'blocker',
              ${('hive:deploy failed — ' + desc.slice(0, 80))},
              ${JSON.stringify({ state, description: desc, sha: body.deployment?.sha })},
              ${['deploy_tracking', 'hive_deploy_failure']}
            )
          `;
        }
        break;
      }

      const [company] = await sql`SELECT id FROM companies WHERE slug = ${repoName}`;
      if (!company) break;

      if (state === "failure" || state === "error") {
        const desc = body.deployment_status?.description || "Deploy failed";

        await sql`
          INSERT INTO agent_actions (company_id, agent, action_type, description, status, error, started_at, finished_at)
          VALUES (${company.id}, 'engineer', 'deploy', ${`Deploy failed: ${desc}`}, 'failed', ${desc}, now(), now())
        `;

        // Telegram notification for deploy failure
        import("@/lib/telegram").then(({ notifyHive }) =>
          notifyHive({
            agent: "webhook",
            action: "deploy_failed",
            company: repoName,
            status: "failed",
            summary: `Deploy failed: ${desc}`,
          })
        ).catch(() => {});

        // Create escalation if deploy keeps failing
        const [recentFailures] = await sql`
          SELECT count(*) as cnt FROM agent_actions
          WHERE company_id = ${company.id} AND action_type = 'deploy' AND status = 'failed'
          AND started_at > now() - INTERVAL '24 hours'
        `;

        if (Number(recentFailures.cnt) >= 3) {
          await sql`
            INSERT INTO approvals (company_id, gate_type, title, description, context)
            VALUES (
              ${company.id}, 'escalation',
              ${`${repoName}: deploy failing repeatedly`},
              ${`${recentFailures.cnt} failed deploys in the last 24 hours. Last error: ${desc}. May need manual investigation.`},
              ${JSON.stringify({ failures: Number(recentFailures.cnt), last_error: desc })}
            )
          `;
          // Auto-dispatch Engineer to investigate deploy failures
          await dispatchEvent("ops_escalation", { source: "github_webhook", company: repoName, error: desc });
        }
      } else if (state === "success") {
        await sql`
          INSERT INTO agent_actions (company_id, agent, action_type, description, status, started_at, finished_at)
          VALUES (${company.id}, 'engineer', 'deploy', 'Deploy succeeded', 'success', now(), now())
        `;

        // Telegram notification for deploy success
        import("@/lib/telegram").then(({ notifyHive }) =>
          notifyHive({
            agent: "webhook",
            action: "deploy_success",
            company: repoName,
            status: "success",
            summary: "Deploy succeeded",
          })
        ).catch(() => {});
      }
      break;
    }

    case "pull_request": {
      const pr = body.pull_request;
      if (!pr) break;

      const prRepo = body.repository?.name;
      const prNumber = pr.number;
      const prOwner = body.repository?.owner?.login;
      const action = body.action;

      // Handle PR auto-merge for opened/updated PRs (all repos)
      if (action === "opened" || action === "synchronize" || action === "ready_for_review") {
        // Skip draft PRs
        if (pr.draft) break;

        // Get GitHub token from settings DB (encrypted) or env var fallback
        const { getSettingValue } = await import("@/lib/settings");
        const ghToken = await getSettingValue("github_token").catch(() => null)
          || process.env.GITHUB_PAT || process.env.GH_PAT;
        if (!ghToken) {
          console.warn('No GitHub token available for auto-merge');
          break;
        }

        let companyId: string | null = null;
        if (prRepo !== "hive") {
          const [company] = await sql`SELECT id FROM companies WHERE slug = ${prRepo}`.catch(() => []);
          companyId = company?.id || null;
        }

        try {
          // Analyze PR for auto-merge eligibility
          const analysis = await analyzePR(prOwner, prRepo, prNumber, ghToken);

          await sql`
            INSERT INTO agent_actions (company_id, agent, action_type, description, status, output, started_at, finished_at)
            VALUES (
              ${companyId}, 'auto_merge', 'pr_analysis',
              ${`PR #${prNumber}: ${analysis.decision} (risk ${analysis.riskScore})`},
              'success',
              ${JSON.stringify({
                pr_number: prNumber,
                risk_score: analysis.riskScore,
                risk_factors: analysis.riskFactors,
                decision: analysis.decision,
                hard_gates_passed: analysis.hardGatesPassed,
                ci_passed: analysis.ciPassed
              })}::jsonb,
              now(), now()
            )
          `;

          // Auto-merge if eligible
          if (analysis.decision === 'auto_merge') {
            const mergeResult = await autoMergePR(prOwner, prRepo, prNumber, ghToken);

            if (mergeResult.success) {
              // Log successful auto-merge
              await sql`
                INSERT INTO agent_actions (company_id, agent, action_type, description, status, started_at, finished_at)
                VALUES (
                  ${companyId}, 'auto_merge', 'pr_merge',
                  ${`PR #${prNumber} auto-merged (risk ${analysis.riskScore})`},
                  'success', now(), now()
                )
              `;

              // Telegram notification for auto-merge
              import("@/lib/telegram").then(({ notifyHive }) =>
                notifyHive({
                  agent: "auto_merge",
                  action: "pr_merged",
                  company: prRepo === "hive" ? "_hive" : prRepo,
                  status: "success",
                  summary: `PR #${prNumber} auto-merged (risk ${analysis.riskScore}, CI ✅)`,
                })
              ).catch(() => {});

            } else {
              // Log merge failure
              await sql`
                INSERT INTO agent_actions (company_id, agent, action_type, description, status, error, started_at, finished_at)
                VALUES (
                  ${companyId}, 'auto_merge', 'pr_merge',
                  ${`PR #${prNumber} merge failed: ${mergeResult.message}`},
                  'failed', ${mergeResult.message || 'Unknown error'}, now(), now()
                )
              `;
            }
          } else if (analysis.decision === 'escalate') {
            // Create approval gate for high-risk PRs
            const company = companyId ? await sql`SELECT slug FROM companies WHERE id = ${companyId}` : null;
            const companySlug = company?.[0]?.slug || prRepo;

            await sql`
              INSERT INTO approvals (company_id, gate_type, title, description, context)
              VALUES (
                ${companyId},
                'pr_review',
                ${`${companySlug}: High-risk PR #${prNumber}`},
                ${`PR requires manual review (risk score ${analysis.riskScore}). Issues: ${analysis.hardGateIssues.join(', ') || analysis.riskFactors.join(', ')}`},
                ${JSON.stringify({
                  pr_number: prNumber,
                  pr_url: pr.html_url,
                  risk_score: analysis.riskScore,
                  risk_factors: analysis.riskFactors,
                  hard_gate_issues: analysis.hardGateIssues,
                  company: companySlug
                })}
              )
            `;

            // Telegram notification for escalated PR
            import("@/lib/telegram").then(({ notifyHive }) =>
              notifyHive({
                agent: "auto_merge",
                action: "pr_escalated",
                company: prRepo === "hive" ? "_hive" : prRepo,
                status: "started",
                summary: `PR #${prNumber} escalated (risk ${analysis.riskScore}) - needs manual review`,
              })
            ).catch(() => {});

            // Immediately dispatch CEO to review the PR via QStash (guaranteed delivery + retries)
            // Previously fire-and-forget via dispatchEvent — now QStash-backed so PR reviews
            // don't silently fail and wait 4h for Sentinel to catch them
            qstashPublish("/api/dispatch/chain-dispatch", {
              event_type: "ceo_review",
              source: "webhook_pr_escalated",
              company: companySlug,
              pr_number: prNumber,
              pr_url: pr.html_url,
              risk_score: analysis.riskScore,
            }, {
              retries: 3,
              deduplicationId: `ceo-pr-review-${prNumber}-${Date.now().toString(36)}`,
            }).catch((e: unknown) => { console.warn(`[webhook] QStash CEO PR review dispatch failed for PR #${prNumber}: ${e instanceof Error ? e.message : e}`); });
          }

        } catch (error) {
          // Log analysis failure
          await sql`
            INSERT INTO agent_actions (company_id, agent, action_type, description, status, error, started_at, finished_at)
            VALUES (
              ${companyId}, 'auto_merge', 'pr_analysis',
              ${`PR #${prNumber} analysis failed`},
              'failed', ${String(error)}, now(), now()
            )
          `;
        }
      }

      // Handle PR closure (existing logic for backlog items)
      if (action === "closed") {
        const merged = pr.merged === true;

        // Only handle Hive repo PRs for backlog tracking (backlog items are Hive self-improvement)
        if (prRepo === "hive") {
          // Find backlog items in pr_open status that match this PR
          const matchingItems = await sql`
            SELECT id, title FROM hive_backlog
            WHERE status = 'pr_open'
            AND pr_number = ${prNumber}
          `.catch(() => []);

          const itemIds = matchingItems.map((i: Record<string, string>) => i.id);
          const itemTitles = matchingItems.map((i: Record<string, string>) => i.title);

          if (itemIds.length > 0) {
            if (merged) {
              await sql`
                UPDATE hive_backlog
                SET status = 'done', completed_at = NOW(),
                    pr_number = ${prNumber}, pr_url = ${pr.html_url || ""},
                    notes = COALESCE(notes, '') || ${` PR #${prNumber} merged.`}
                WHERE id = ANY(${itemIds})
                AND status = 'pr_open'
              `.catch(() => {});

              // Only notify if not already auto-merged (avoid duplicate notifications)
              const wasAutoMerged = await sql`
                SELECT 1 FROM agent_actions
                WHERE agent = 'auto_merge' AND action_type = 'pr_merge'
                AND description LIKE ${`PR #${prNumber}%`} AND status = 'success'
                AND started_at > now() - INTERVAL '1 hour'
                LIMIT 1
              `;

              if (wasAutoMerged.length === 0) {
                import("@/lib/telegram").then(({ notifyHive }) =>
                  notifyHive({
                    agent: "webhook",
                    action: "backlog_merged",
                    company: "_hive",
                    status: "success",
                    summary: `PR #${prNumber} merged → ${itemTitles.join(", ")}`,
                  })
                ).catch(() => {});
              }

              // Post-merge verification: check build health after 5 minutes
              qstashPublish("/api/dispatch/verify-merge", {
                pr_number: prNumber,
                backlog_ids: itemIds,
                merged_at: new Date().toISOString(),
              }, { delay: 300, retries: 2 }).catch(() => {});
            } else {
              // Closed without merge — reset to ready
              await sql`
                UPDATE hive_backlog
                SET status = 'ready', dispatched_at = NULL,
                    notes = COALESCE(notes, '') || ${` PR #${prNumber} closed without merge — will retry.`}
                WHERE id = ANY(${itemIds})
                AND status = 'pr_open'
              `.catch(() => {});
            }
          }
        } else {
          // Handle company repo PRs for task tracking
          const [company] = await sql`SELECT id FROM companies WHERE slug = ${prRepo}`.catch(() => []);
          if (company) {
            // Extract task_id from branch name (pattern: hive/cycle-<N>-<task-id>)
            const branchName = pr.head?.ref || "";
            const taskIdMatch = branchName.match(/^hive\/cycle-\d+-(.+)$/);
            const taskId = taskIdMatch?.[1];

            if (taskId) {
              if (merged) {
                // Confirm task is completed on merge
                await sql`
                  UPDATE company_tasks
                  SET status = 'done', updated_at = now()
                  WHERE id = ${taskId} AND company_id = ${company.id}
                  AND status IN ('approved', 'in_progress')
                `.catch(() => {});

                await sql`
                  INSERT INTO agent_actions (company_id, agent, action_type, description, status, started_at, finished_at)
                  VALUES (
                    ${company.id}, 'webhook', 'task_completed',
                    ${`Task ${taskId} confirmed completed via PR #${prNumber} merge`},
                    'success', now(), now()
                  )
                `.catch(() => {});

                // Telegram notification
                import("@/lib/telegram").then(({ notifyHive }) =>
                  notifyHive({
                    agent: "webhook",
                    action: "task_completed",
                    company: prRepo,
                    status: "success",
                    summary: `Task ${taskId} completed via PR #${prNumber}`,
                  })
                ).catch(() => {});
              } else {
                // PR closed without merge - reset task to approved for retry
                await sql`
                  UPDATE company_tasks
                  SET status = 'approved', updated_at = now()
                  WHERE id = ${taskId} AND company_id = ${company.id}
                  AND status = 'done'
                `.catch(() => {});

                await sql`
                  INSERT INTO agent_actions (company_id, agent, action_type, description, status, started_at, finished_at)
                  VALUES (
                    ${company.id}, 'webhook', 'task_reset',
                    ${`Task ${taskId} reset to approved - PR #${prNumber} closed without merge`},
                    'success', now(), now()
                  )
                `.catch(() => {});
              }
            }
          }
        }
      }
      break;
    }

    case "issues": {
      // Detect new hive-directive issues created directly on GitHub
      if (body.action !== "opened") break;
      const labels = (body.issue?.labels || []).map((l: any) => l.name);
      if (!labels.includes("hive-directive")) break;

      const title = body.issue?.title || "";
      const issueBody = body.issue?.body || "";
      const issueNumber = body.issue?.number;
      const issueUrl = body.issue?.html_url;

      // Extract company from labels
      const companyLabel = labels.find((l: string) => l.startsWith("company:"));
      const companySlug = companyLabel?.split(":")[1];
      const agentLabel = labels.find((l: string) => l.startsWith("agent:"));
      const agent = agentLabel?.split(":")[1] || null;

      let companyId: string | null = null;
      if (companySlug) {
        const [company] = await sql`SELECT id FROM companies WHERE slug = ${companySlug}`;
        companyId = company?.id || null;
      }

      // Store as a directive — the orchestrator picks it up
      await sql`
        INSERT INTO directives (company_id, agent, text, github_issue_number, github_issue_url, status)
        VALUES (${companyId}, ${agent}, ${title + (issueBody ? "\n\n" + issueBody : "")}, ${issueNumber}, ${issueUrl}, 'open')
      `;

      // Immediately dispatch CEO (or the specified agent) to process this directive
      // Without this, the directive sits until Sentinel next runs (up to 30min)
      const dispatchAgent = agent === "engineer" ? "engineer_task"
        : agent === "growth" ? "growth_dispatch"
        : "ceo_review";

      qstashPublish("/api/dispatch/chain-dispatch", {
        event_type: dispatchAgent,
        source: "webhook_directive",
        company: companySlug || "_portfolio",
        directive_issue: issueNumber,
        directive_url: issueUrl,
        directive_text: title,
      }, {
        retries: 2,
        deduplicationId: `directive-${issueNumber}-${Date.now().toString(36)}`,
      }).catch((e: unknown) => {
        console.warn(`[webhook] QStash directive dispatch failed for issue #${issueNumber}: ${e instanceof Error ? e.message : e}`);
      });
      break;
    }
  }

  return Response.json({ received: true });
}

