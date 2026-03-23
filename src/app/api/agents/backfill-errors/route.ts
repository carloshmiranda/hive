import { getDb } from "@/lib/db";
import { getSettingValue } from "@/lib/settings";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/agents/backfill-errors
 *
 * Finds agent_actions with NULL error and status='failed' (last 48h),
 * looks up corresponding GitHub Actions workflow runs, and fills in the error.
 * Auth: CRON_SECRET
 */
export async function POST(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sql = getDb();
  const ghPat = await getSettingValue("github_token");
  if (!ghPat) {
    return Response.json({ ok: false, error: "No github_token configured" }, { status: 400 });
  }

  // Find failed actions with NULL error in the last 48h
  const nullErrors = await sql`
    SELECT aa.id, aa.agent, aa.company_id, aa.started_at, aa.finished_at,
      c.slug, c.github_repo
    FROM agent_actions aa
    JOIN companies c ON c.id = aa.company_id
    WHERE aa.status = 'failed'
    AND aa.error IS NULL
    AND aa.started_at > NOW() - INTERVAL '48 hours'
    AND c.github_repo IS NOT NULL
    ORDER BY aa.started_at DESC
    LIMIT 50
  `;

  if (nullErrors.length === 0) {
    return Response.json({ ok: true, backfilled: 0 });
  }

  // Group by company repo to minimize API calls
  const byRepo = new Map<string, typeof nullErrors>();
  for (const row of nullErrors) {
    const repo = row.github_repo as string;
    if (!byRepo.has(repo)) byRepo.set(repo, []);
    byRepo.get(repo)!.push(row);
  }

  let backfilled = 0;
  const errors: string[] = [];

  for (const [repo, actions] of byRepo) {
    try {
      // Fetch recent failed workflow runs for this repo
      const runsRes = await fetch(
        `https://api.github.com/repos/${repo}/actions/runs?per_page=20&status=failure`,
        {
          headers: { Authorization: `token ${ghPat}`, Accept: "application/vnd.github.v3+json" },
          signal: AbortSignal.timeout(10000),
        }
      );
      if (!runsRes.ok) {
        errors.push(`GitHub API ${runsRes.status} for ${repo}`);
        continue;
      }

      const runs = await runsRes.json();
      const workflowRuns = runs.workflow_runs || [];

      // For each action with NULL error, try to match a workflow run by timestamp
      for (const action of actions) {
        const actionStart = new Date(action.started_at as string).getTime();
        const actionEnd = action.finished_at
          ? new Date(action.finished_at as string).getTime()
          : actionStart + 300000; // 5 min default window

        // Find a run that started within 5 min of the action
        const matchedRun = workflowRuns.find((run: any) => {
          const runStart = new Date(run.created_at).getTime();
          return Math.abs(runStart - actionStart) < 300000 || // within 5 min of start
            (runStart >= actionStart && runStart <= actionEnd); // during action window
        });

        if (matchedRun) {
          const errorMsg = `GitHub Actions: ${matchedRun.conclusion} — ${matchedRun.name} (run ${matchedRun.id})`;
          await sql`
            UPDATE agent_actions SET error = ${errorMsg}
            WHERE id = ${action.id} AND error IS NULL
          `;
          backfilled++;
        }
      }
    } catch (e: any) {
      errors.push(`${repo}: ${e.message}`);
    }
  }

  return Response.json({
    ok: true,
    backfilled,
    checked: nullErrors.length,
    repos: byRepo.size,
    ...(errors.length > 0 ? { errors } : {}),
  });
}
