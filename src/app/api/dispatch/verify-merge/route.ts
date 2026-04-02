import { getDb, json, err } from "@/lib/db";
import { verifyCronAuth, qstashPublish } from "@/lib/qstash";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// POST /api/dispatch/verify-merge
// Called via QStash after a Hive PR is merged.
//
// Two check modes (controlled by body params):
//   - Default (5 min delay): checks Vercel deployment health
//   - check_sentry=true (15 min delay): checks Sentry error rate spike vs baseline

const SENTRY_SPIKE_MULTIPLIER = 2; // >2x baseline = spike

export async function POST(req: Request) {
  const auth = await verifyCronAuth(req);
  if (!auth.authorized) {
    return Response.json({ error: auth.error }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const { pr_number, backlog_ids: _backlog_ids, merged_at, check_sentry } = body;

  if (!pr_number) {
    return err("Missing pr_number");
  }

  const sql = getDb();
  const baseUrl = process.env.NEXT_PUBLIC_URL || "https://hive-phi.vercel.app";

  try {
    if (check_sentry && merged_at) {
      return await checkSentryErrorRate(sql, pr_number, merged_at, baseUrl);
    }

    // Default: Vercel deployment health check
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
            ${`PR #${pr_number} was merged but the deployment appears broken. Check build logs and fix the regression. Health check: ${deployHealthy ? "OK" : "FAILED"}. Deploy status: ${deployFailed ? "FAILED" : "unknown"}.`},
            'P0', 'ready', 'sentinel', 'code_quality'
          )
        `;

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

    await sql`
      INSERT INTO agent_actions (agent, action_type, description, status, started_at, finished_at)
      VALUES ('sentinel', 'verify_merge',
        ${`PR #${pr_number} merge verified — deployment healthy`},
        'success', NOW(), NOW())
    `.catch(() => {});

    return json({ verified: true, pr_number, health_ok: true });

  } catch (error) {
    return err(`Verification failed: ${error instanceof Error ? error.message : "unknown"}`);
  }
}

/**
 * Check if Sentry error rate spiked more than 2x after a merge.
 * Compares 15-min pre-merge baseline against 15-min post-merge count.
 * If spike detected, dispatches revert_request and creates P0 backlog item.
 */
async function checkSentryErrorRate(
  sql: any,
  prNumber: number,
  mergedAt: string,
  baseUrl: string
): Promise<Response> {
  const mergedAtDate = new Date(mergedAt);
  const windowMs = 15 * 60 * 1000; // 15 minutes
  const beforeStart = new Date(mergedAtDate.getTime() - windowMs);
  const afterEnd = new Date(mergedAtDate.getTime() + windowMs);

  // Count Sentry error events in the 15-min window before the merge
  const [beforeRow] = await sql`
    SELECT COUNT(*)::int AS count
    FROM agent_actions
    WHERE action_type = 'sentry_event'
      AND started_at >= ${beforeStart}
      AND started_at < ${mergedAtDate}
  `.catch(() => [{ count: 0 }]);

  // Count Sentry error events in the 15-min window after the merge
  const [afterRow] = await sql`
    SELECT COUNT(*)::int AS count
    FROM agent_actions
    WHERE action_type = 'sentry_event'
      AND started_at >= ${mergedAtDate}
      AND started_at <= ${afterEnd}
  `.catch(() => [{ count: 0 }]);

  const beforeCount: number = beforeRow?.count ?? 0;
  const afterCount: number = afterRow?.count ?? 0;

  // Use a floor of 1 for the baseline so a jump from 0→1 doesn't trigger
  const baseline = Math.max(beforeCount, 1);
  const spikeDetected = afterCount > baseline * SENTRY_SPIKE_MULTIPLIER && afterCount >= 3;

  await sql`
    INSERT INTO agent_actions (agent, action_type, description, status, output, started_at, finished_at)
    VALUES (
      'sentinel', 'sentry_spike_check',
      ${`PR #${prNumber} Sentry check: before=${beforeCount}, after=${afterCount}, spike=${spikeDetected}`},
      ${spikeDetected ? "failed" : "success"},
      ${JSON.stringify({ pr_number: prNumber, before_count: beforeCount, after_count: afterCount, spike_detected: spikeDetected, merged_at: mergedAt })}::jsonb,
      NOW(), NOW()
    )
  `.catch(() => {});

  if (!spikeDetected) {
    return json({
      sentry_ok: true,
      pr_number: prNumber,
      before_count: beforeCount,
      after_count: afterCount,
    });
  }

  // Spike detected — dispatch revert_request to GitHub Actions
  const ghPat = process.env.GH_PAT;
  const repo = process.env.GITHUB_REPOSITORY || "carloshmiranda/hive";

  let revertDispatched = false;
  if (ghPat) {
    const dispatchRes = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
      method: "POST",
      headers: {
        Authorization: `token ${ghPat}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        event_type: "revert_request",
        client_payload: {
          pr_number: prNumber,
          reason: `Sentry error spike: ${afterCount} errors in 15min post-merge (baseline: ${beforeCount})`,
          merged_at: mergedAt,
        },
      }),
      signal: AbortSignal.timeout(10000),
    }).catch(() => null);
    revertDispatched = dispatchRes?.ok ?? false;
  }

  // Also create a P0 backlog item so humans are aware
  const fixTitle = `Revert PR #${prNumber} — Sentry error spike detected`;
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
        ${`PR #${prNumber} caused a Sentry error spike: ${afterCount} errors in 15 min post-merge vs ${beforeCount} in 15 min pre-merge (${SENTRY_SPIKE_MULTIPLIER}x threshold). ${revertDispatched ? "Revert workflow dispatched." : "Manual revert may be needed."}`},
        'P0', 'ready', 'sentinel', 'code_quality'
      )
    `.catch(() => {});
  }

  import("@/lib/telegram").then(({ notifyHive }) =>
    notifyHive({
      agent: "verify-merge",
      action: "sentry_spike",
      company: "_hive",
      status: "failed",
      summary: `PR #${prNumber}: Sentry errors spiked ${afterCount}x post-merge (baseline ${beforeCount}) — ${revertDispatched ? "revert dispatched" : "manual revert needed"}`,
    })
  ).catch(() => {});

  return json({
    sentry_ok: false,
    spike_detected: true,
    pr_number: prNumber,
    before_count: beforeCount,
    after_count: afterCount,
    revert_dispatched: revertDispatched,
    fix_item_created: !existing,
  });
}
