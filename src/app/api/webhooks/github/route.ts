import { getDb } from "@/lib/db";
import { createHmac, timingSafeEqual } from "crypto";
import { dispatchEvent } from "@/lib/dispatch";

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
      // PR merged → mark matching backlog items as done
      // PR closed without merge → reset to ready for re-dispatch
      if (body.action !== "closed") break;
      const pr = body.pull_request;
      if (!pr) break;

      const prRepo = body.repository?.name;
      const prNumber = pr.number;
      const prBranch = pr.head?.ref || "";
      const merged = pr.merged === true;

      // Only handle Hive repo PRs (backlog items are Hive self-improvement)
      if (prRepo !== "hive") break;

      // Find backlog items in pr_open status that match this PR
      // Match by pr_number if stored, or by title similarity with PR title
      const prTitle = (pr.title || "").slice(0, 50);
      const matchingItems = await sql`
        SELECT id, title FROM hive_backlog
        WHERE status = 'pr_open'
        AND (
          pr_number = ${prNumber}
          OR title ILIKE ${"%" + prTitle.replace(/^feat: |^fix: |^refactor: |^chore: /i, "").slice(0, 40) + "%"}
        )
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

          // Notify
          import("@/lib/telegram").then(({ notifyHive }) =>
            notifyHive({
              agent: "webhook",
              action: "backlog_merged",
              company: "_hive",
              status: "success",
              summary: `PR #${prNumber} merged → ${itemTitles.join(", ")}`,
            })
          ).catch(() => {});
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
      break;
    }
  }

  return Response.json({ received: true });
}

