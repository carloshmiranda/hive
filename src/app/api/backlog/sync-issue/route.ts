import { getDb, json, err } from "@/lib/db";
import { createBacklogIssue } from "@/lib/github-issues";

// POST /api/backlog/sync-issue — Create GitHub Issue for a backlog item
// Called by MCP server after creating a backlog item (fire-and-forget)
// Auth: CRON_SECRET (internal only)
export async function POST(req: Request) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return err("Unauthorized", 401);
  }

  const body = await req.json().catch(() => ({}));
  const { backlog_id, title, description, priority, category, theme } = body;

  if (!backlog_id || !title) {
    return err("Missing backlog_id or title", 400);
  }

  const sql = getDb();

  // Check if already has an issue
  const [existing] = await sql`
    SELECT github_issue_number FROM hive_backlog WHERE id = ${backlog_id}
  `.catch(() => []);
  if (existing?.github_issue_number) {
    return json({ already_linked: true, issue_number: existing.github_issue_number });
  }

  const issue = await createBacklogIssue({
    id: backlog_id,
    title,
    description: description || title,
    priority: priority || "P2",
    category: category || "feature",
    theme: theme || null,
  });

  if (issue) {
    await sql`
      UPDATE hive_backlog
      SET github_issue_number = ${issue.number}, github_issue_url = ${issue.url}
      WHERE id = ${backlog_id}
    `.catch(() => {});
  }

  return json({ created: !!issue, issue_number: issue?.number, issue_url: issue?.url });
}
