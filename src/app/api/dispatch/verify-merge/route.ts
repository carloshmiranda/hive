import { getDb, json, err } from "@/lib/db";
import { verifyCronAuth } from "@/lib/qstash";

export const dynamic = "force-dynamic";

// POST /api/dispatch/verify-merge
// Called via QStash with a 5-minute delay after a Hive PR is merged.
// Checks if the Vercel deployment succeeded after the merge.
// If build broke, auto-creates a P0 backlog item to fix it.

export async function POST(req: Request) {
  const auth = await verifyCronAuth(req);
  if (!auth.authorized) {
    return Response.json({ error: auth.error }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const { pr_number, backlog_ids, merged_at } = body;

  if (!pr_number) {
    return err("Missing pr_number");
  }

  const sql = getDb();
  const baseUrl = process.env.NEXT_PUBLIC_URL || "https://hive-phi.vercel.app";

  try {
    // Check Vercel deployment status by hitting the health endpoint
    let deployHealthy = false;
    try {
      const healthRes = await fetch(`${baseUrl}/api/health`, {
        signal: AbortSignal.timeout(10000),
      });
      deployHealthy = healthRes.ok;
    } catch {
      deployHealthy = false;
    }

    // Also check most recent deployment_status webhook event
    const [recentDeploy] = await sql`
      SELECT summary, detail FROM context_log
      WHERE source = 'code' AND tags @> ARRAY['deploy_tracking']
      AND created_at > NOW() - INTERVAL '10 minutes'
      ORDER BY created_at DESC LIMIT 1
    `.catch(() => []);

    const deployFailed = recentDeploy?.summary?.includes("deploy failed") || false;

    if (!deployHealthy || deployFailed) {
      // Build broke after merge — create a P0 fix item
      const fixTitle = `Fix build regression from PR #${pr_number}`;

      // Check if we already created a fix item for this
      const [existing] = await sql`
        SELECT id FROM hive_backlog
        WHERE title = ${fixTitle} AND status NOT IN ('done', 'rejected')
        LIMIT 1
      `.catch(() => []);

      if (!existing) {
        await sql`
          INSERT INTO hive_backlog (title, description, priority, status, source, theme)
          VALUES (
            ${fixTitle},
            ${`PR #${pr_number} was merged but the deployment appears broken. Check build logs and fix the regression. Health check: ${deployHealthy ? 'OK' : 'FAILED'}. Deploy status: ${deployFailed ? 'FAILED' : 'unknown'}.`},
            'P0', 'ready', 'sentinel', 'code_quality'
          )
        `;

        // Notify about build regression
        import("@/lib/telegram").then(({ notifyHive }) =>
          notifyHive({
            agent: "verify-merge",
            action: "build_regression",
            company: "_hive",
            status: "failed",
            summary: `PR #${pr_number} merged but build appears broken — P0 fix item created`,
          })
        ).catch(() => {});
      }

      // Log the verification failure
      await sql`
        INSERT INTO agent_actions (agent, action_type, description, status, started_at, finished_at)
        VALUES ('sentinel', 'verify_merge',
          ${`PR #${pr_number} merge verification FAILED — build appears broken`},
          'failed', NOW(), NOW())
      `.catch(() => {});

      return json({
        verified: false,
        pr_number,
        health_ok: deployHealthy,
        deploy_failed: deployFailed,
        fix_item_created: !existing,
      });
    }

    // Build is healthy — log success
    await sql`
      INSERT INTO agent_actions (agent, action_type, description, status, started_at, finished_at)
      VALUES ('sentinel', 'verify_merge',
        ${`PR #${pr_number} merge verified — deployment healthy`},
        'success', NOW(), NOW())
    `.catch(() => {});

    return json({
      verified: true,
      pr_number,
      health_ok: true,
    });

  } catch (error) {
    return err(`Verification failed: ${error instanceof Error ? error.message : "unknown"}`);
  }
}
