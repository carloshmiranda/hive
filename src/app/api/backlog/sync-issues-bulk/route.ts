import { getDb, json, err } from "@/lib/db";
import { createBacklogIssue } from "@/lib/github-issues";

// POST /api/backlog/sync-issues-bulk — Create GitHub Issues for all active backlog items
// that don't have one yet. Rate-limited to avoid GitHub API abuse.
// Auth: CRON_SECRET (internal only)
export async function POST(req: Request) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return err("Unauthorized", 401);
  }

  const body = await req.json().catch(() => ({}));
  const batchSize = Math.min(body.batch_size || 10, 30); // max 30 per call
  const dryRun = body.dry_run === true;

  const sql = getDb();

  // Find active backlog items without GitHub Issues
  const items = await sql`
    SELECT id, title, priority, category, theme, notes
    FROM hive_backlog
    WHERE github_issue_number IS NULL
    AND status NOT IN ('done', 'rejected')
    ORDER BY
      CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,
      created_at ASC
    LIMIT ${batchSize}
  `;

  if (items.length === 0) {
    return json({ synced: 0, remaining: 0, message: "All active items already have GitHub Issues" });
  }

  // Count remaining for progress reporting
  const [{ count: remaining }] = await sql`
    SELECT COUNT(*)::int as count FROM hive_backlog
    WHERE github_issue_number IS NULL AND status NOT IN ('done', 'rejected')
  `;

  if (dryRun) {
    return json({
      dry_run: true,
      would_sync: items.length,
      remaining,
      items: items.map((i: any) => ({ id: i.id, title: i.title, priority: i.priority })),
    });
  }

  let synced = 0;
  let failed = 0;
  const results: { id: string; title: string; issue_number?: number; error?: string }[] = [];

  for (const item of items) {
    // Brief pause between API calls to respect rate limits
    if (synced > 0) await new Promise((r) => setTimeout(r, 1000));

    try {
      const issue = await createBacklogIssue({
        id: item.id,
        title: item.title,
        description: item.notes || item.title,
        priority: item.priority || "P2",
        category: item.category || "feature",
        theme: item.theme || null,
      });

      if (issue) {
        await sql`
          UPDATE hive_backlog
          SET github_issue_number = ${issue.number}, github_issue_url = ${issue.url}
          WHERE id = ${item.id}
        `;
        synced++;
        results.push({ id: item.id, title: item.title, issue_number: issue.number });
      } else {
        failed++;
        results.push({ id: item.id, title: item.title, error: "Issue creation returned null" });
      }
    } catch (e: any) {
      failed++;
      results.push({ id: item.id, title: item.title, error: e?.message || "Unknown error" });
    }
  }

  return json({
    synced,
    failed,
    remaining: remaining - synced,
    results,
  });
}
