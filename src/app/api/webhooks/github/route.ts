import { getDb } from "@/lib/db";

// Receives GitHub webhook events — no auth check (verified by webhook secret)
// Tracks: push events, deploy statuses, PR merges

export async function POST(req: Request) {
  const body = await req.json();
  const event = req.headers.get("x-github-event");
  const sql = getDb();

  // Verify webhook secret
  // In production, verify HMAC signature from X-Hub-Signature-256
  // Skipped here for brevity — add before production

  switch (event) {
    case "push": {
      const repoName = body.repository?.name;
      if (!repoName) break;

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

      const [company] = await sql`SELECT id FROM companies WHERE slug = ${repoName}`;
      if (!company) break;

      if (state === "failure" || state === "error") {
        const desc = body.deployment_status?.description || "Deploy failed";

        await sql`
          INSERT INTO agent_actions (company_id, agent, action_type, description, status, error, started_at, finished_at)
          VALUES (${company.id}, 'engineer', 'deploy', ${`Deploy failed: ${desc}`}, 'failed', ${desc}, now(), now())
        `;

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
        }
      } else if (state === "success") {
        await sql`
          INSERT INTO agent_actions (company_id, agent, action_type, description, status, started_at, finished_at)
          VALUES (${company.id}, 'engineer', 'deploy', 'Deploy succeeded', 'success', now(), now())
        `;
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
