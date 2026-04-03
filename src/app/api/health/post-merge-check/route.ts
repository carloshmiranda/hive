/**
 * POST /api/health/post-merge-check
 *
 * Called by QStash ~5 minutes after a PR is auto-merged.
 * Fetches recent Sentry errors and checks for a regression spike
 * (≥3 new distinct error patterns introduced since the merge).
 * On spike: inserts a post_merge_regression agent_action and creates a P0 backlog item.
 */

import { NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { verifyCronAuth } from "@/lib/qstash";
import { fetchRecentErrors, extractErrorPatterns } from "@/lib/sentry-api";

const REGRESSION_THRESHOLD = 3; // distinct new error patterns = regression
const BASELINE_WINDOW_SECS = 86400; // 24h baseline comparison window
const POST_MERGE_WINDOW_SECS = 600;  // 10 min window to detect new errors

export async function POST(req: Request) {
  const auth = await verifyCronAuth(req);
  if (!auth.authorized) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: 401 });
  }

  let body: { pr_number?: number; pr_title?: string; merged_at?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const { pr_number, pr_title, merged_at } = body;
  if (!pr_number) {
    return NextResponse.json({ ok: false, error: "Missing pr_number" }, { status: 400 });
  }

  const sql = neon(process.env.DATABASE_URL!);

  // Fetch errors from the post-merge window (recent 10 min) and baseline (24h)
  const [recentErrors, baselineErrors] = await Promise.all([
    fetchRecentErrors(POST_MERGE_WINDOW_SECS),
    fetchRecentErrors(BASELINE_WINDOW_SECS),
  ]);

  const recentPatterns = extractErrorPatterns(recentErrors);
  const baselinePatterns = extractErrorPatterns(baselineErrors);
  const baselineKeys = new Set(baselinePatterns.map((p) => p.pattern));

  // New patterns = those in recent window not present in baseline
  const newPatterns = recentPatterns.filter((p) => !baselineKeys.has(p.pattern));

  const isRegression = newPatterns.length >= REGRESSION_THRESHOLD;

  await sql`
    INSERT INTO agent_actions (agent, action_type, status, description, output, started_at, finished_at)
    VALUES (
      'backlog_dispatch',
      'post_merge_regression',
      ${isRegression ? "failure" : "success"},
      ${`Post-merge health check for PR #${pr_number}: ${isRegression ? `REGRESSION — ${newPatterns.length} new error pattern(s)` : "clean"}`},
      ${JSON.stringify({
        pr_number,
        pr_title,
        merged_at,
        new_patterns: newPatterns.length,
        recent_errors: recentErrors.length,
        baseline_errors: baselineErrors.length,
        top_new_patterns: newPatterns.slice(0, 3).map((p) => ({
          pattern: p.pattern,
          count: p.count,
          severity: p.severity,
        })),
      })}::jsonb,
      NOW(),
      NOW()
    )
  `.catch((err) => {
    console.error("[post-merge-check] Failed to insert agent_action:", err);
  });

  if (isRegression) {
    const description = [
      `PR #${pr_number} (${pr_title ?? "unknown"}) merged at ${merged_at ?? "unknown"}.`,
      `${newPatterns.length} new Sentry error patterns detected within 10 min of merge.`,
      "",
      "Top new patterns:",
      ...newPatterns.slice(0, 3).map((p, i) => `${i + 1}. ${p.pattern} (${p.count} occurrences, ${p.severity})`),
    ].join("\n");

    await sql`
      INSERT INTO hive_backlog (id, title, description, category, priority, status, notes, created_at, updated_at)
      VALUES (
        gen_random_uuid(),
        ${`P0: Post-merge regression — PR #${pr_number}: ${pr_title ?? ""}`},
        ${description},
        'bugfix',
        0,
        'ready',
        ${`Auto-created by post-merge health check. New error patterns: ${newPatterns.length}`},
        NOW(),
        NOW()
      )
    `.catch((err) => {
      console.error("[post-merge-check] Failed to create regression backlog item:", err);
    });

    console.warn(
      `[post-merge-check] REGRESSION detected after PR #${pr_number}: ${newPatterns.length} new pattern(s). Backlog item created.`
    );
  } else {
    console.log(`[post-merge-check] PR #${pr_number} clean — ${recentErrors.length} recent errors, ${newPatterns.length} new patterns (threshold: ${REGRESSION_THRESHOLD})`);
  }

  return NextResponse.json({
    ok: true,
    pr_number,
    is_regression: isRegression,
    new_patterns: newPatterns.length,
    threshold: REGRESSION_THRESHOLD,
  });
}
