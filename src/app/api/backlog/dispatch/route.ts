import { getDb, json, err } from "@/lib/db";
import { getSettingValue } from "@/lib/settings";
import { computeBacklogScore, detectBlockedAgents } from "@/lib/backlog-priority";
import type { BacklogItem } from "@/lib/backlog-priority";

// POST /api/backlog/dispatch — score and dispatch the next backlog item
// Called by: Engineer workflow after completing a Hive fix (chain dispatch)
//            Sentinel as part of triage (existing flow)
//            Manual trigger from dashboard
// Auth: CRON_SECRET or OIDC
export async function POST(req: Request) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (authHeader !== `Bearer ${cronSecret}`) {
    const { validateOIDC } = await import("@/lib/oidc");
    const result = await validateOIDC(req);
    if (result instanceof Response) return result;
  }

  const sql = getDb();
  const body = await req.json().catch(() => ({}));
  const { completed_id, completed_status } = body;

  // If a completed item was passed, update its status
  if (completed_id && completed_status) {
    if (completed_status === "success") {
      // Engineer "success" means PR created, NOT code merged.
      // Move to 'pr_open' so it stays visible until PR is merged.
      // Sentinel or a webhook will mark 'done' after merge.
      await sql`
        UPDATE hive_backlog
        SET status = 'pr_open', dispatched_at = NOW(),
            notes = COALESCE(notes, '') || ' PR created via chain dispatch — awaiting merge.'
        WHERE id = ${completed_id} AND status IN ('dispatched', 'in_progress')
      `.catch(() => {});
    } else {
      // Failed: always retry. Hive learns from failures.
      // "blocked" is ONLY for items that need manual/human action.
      // Track attempts in notes so the Engineer gets failure context on retry.
      const [item] = await sql`
        SELECT id, title, notes FROM hive_backlog WHERE id = ${completed_id}
      `.catch(() => []);
      const prevAttempts = (item?.notes || "").match(/\[attempt \d+\]/g)?.length || 0;
      const attempt = prevAttempts + 1;

      // Auto-block after 5 failed attempts — prevents infinite retry loops
      if (attempt >= 5) {
        await sql`
          UPDATE hive_backlog
          SET status = 'blocked', dispatched_at = NULL,
              notes = COALESCE(notes, '') || ${` [attempt ${attempt}] Auto-blocked after ${attempt} failures — needs decomposition or manual review.`}
          WHERE id = ${completed_id} AND status IN ('dispatched', 'in_progress')
        `.catch(() => {});
      } else {
        // Back to ready with attempt context — the scoring engine will
        // deprioritize via the novelty penalty (hasSimilarFailed check)
        await sql`
          UPDATE hive_backlog
          SET status = 'ready', dispatched_at = NULL,
              notes = COALESCE(notes, '') || ${` [attempt ${attempt}] Failed — will retry with more context.`}
          WHERE id = ${completed_id} AND status IN ('dispatched', 'in_progress')
        `.catch(() => {});
      }

      // After 3 failures, notify Carlos (but still keep retrying)
      if (attempt >= 3) {
        const baseUrl = process.env.NEXT_PUBLIC_URL || "https://hive-phi.vercel.app";
        await fetch(`${baseUrl}/api/notify`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.CRON_SECRET}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            agent: "backlog",
            action: "repeated_failure",
            company: "hive",
            status: "failed",
            summary: `"${item?.title || completed_id}" has failed ${attempt} times. Still retrying but may need a different approach.`,
          }),
          signal: AbortSignal.timeout(5000),
        }).catch(() => {});
      }
    }
  }

  // Check budget — don't dispatch if Claude budget is exhausted
  const [usage] = await sql`
    SELECT COALESCE(SUM(tokens_used), 0)::int as turns
    FROM agent_actions
    WHERE agent IN ('ceo', 'scout', 'engineer', 'evolver', 'healer')
    AND started_at > NOW() - INTERVAL '5 hours'
  `.catch(() => [{ turns: 0 }]);
  const budgetUsedPct = Number(usage?.turns || 0) / 225;
  if (budgetUsedPct > 0.85) {
    return json({ dispatched: false, reason: "budget_exhausted", budget_pct: Math.round(budgetUsedPct * 100) });
  }

  // Check for rate-limit failures (2h window — these indicate weekly/session cap)
  const [rateLimitRow] = await sql`
    SELECT COUNT(*) FILTER (WHERE status = 'failed'
      AND (error ILIKE '%rate limit%' OR error ILIKE '%session limit%'
        OR error ILIKE '%usage cap%' OR error ILIKE '%too many%'
        OR error ILIKE '%quota%' OR error ILIKE '%limit reached%'
        OR error ILIKE '%max_tokens%' OR error ILIKE '%capacity%'))::int as rate_limited
    FROM agent_actions
    WHERE agent IN ('ceo', 'scout', 'engineer', 'evolver', 'healer')
    AND started_at > NOW() - INTERVAL '2 hours'
  `.catch(() => [{ rate_limited: 0 }]);
  const rateLimited = Number((rateLimitRow as Record<string, number>)?.rate_limited || 0);
  if (rateLimited >= 2) {
    return json({ dispatched: false, reason: "claude_rate_limited", rate_limit_failures: rateLimited, window: "2h" });
  }

  // Circuit breaker: short 30-min window so it recovers quickly after limit resets
  const [recentFailureRow] = await sql`
    SELECT COUNT(*)::int as total,
           COUNT(*) FILTER (WHERE status = 'failed')::int as failed
    FROM agent_actions
    WHERE agent IN ('ceo', 'scout', 'engineer', 'evolver', 'healer')
    AND started_at > NOW() - INTERVAL '30 minutes'
  `.catch(() => [{ total: 0, failed: 0 }]);
  const recentFailed = Number((recentFailureRow as Record<string, number>)?.failed || 0);
  const recentTotal = Number((recentFailureRow as Record<string, number>)?.total || 0);
  if (recentTotal >= 3 && recentFailed / recentTotal > 0.6) {
    return json({ dispatched: false, reason: "circuit_breaker", failed: recentFailed, total: recentTotal, rate: Math.round((recentFailed / recentTotal) * 100), window: "30m" });
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
    return json({ dispatched: false, reason: "engineer_busy", running_id: running.id });
  }

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

  // Fetch ready backlog items (exclude manually-blocked items and recently-failed items)
  const backlogItems = await sql`
    SELECT * FROM hive_backlog
    WHERE status IN ('ready', 'approved')
    AND NOT (
      notes ILIKE '%[attempt %]%'
      AND created_at > NOW() - INTERVAL '30 minutes'
    )
    ORDER BY
      CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,
      created_at ASC
    LIMIT 10
  `.catch(() => []);

  // Filter out items that require manual/human work (can't be automated)
  const MANUAL_KEYWORDS = /\b(manual|buy domain|DNS records|sign up|create account|register|purchase|human|carlos)\b/i;
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
    const baseUrl = process.env.NEXT_PUBLIC_URL || "https://hive-phi.vercel.app";
    const titles = manualItems.map((i) => `• [${i.priority}] ${i.title}`).join("\n");
    await fetch(`${baseUrl}/api/notify`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.CRON_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agent: "backlog",
        action: "manual_blocked",
        company: "hive",
        status: "needs_carlos",
        summary: `${manualItems.length} backlog item(s) need manual action:\n${titles}`,
      }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  }

  const backlogItemsFiltered = automatable;

  if (backlogItemsFiltered.length === 0) {
    return json({ dispatched: false, reason: "backlog_empty", manual_blocked: manualItems.length });
  }

  // Score items
  const [activeCount] = await sql`
    SELECT COUNT(*)::int as count FROM companies WHERE status IN ('mvp', 'active')
  `.catch(() => [{ count: 4 }]);
  const totalCompanies = Number(activeCount?.count || 4);

  const [failRate] = await sql`
    SELECT COUNT(*) FILTER (WHERE status = 'failed')::float /
      NULLIF(COUNT(*), 0)::float as rate
    FROM agent_actions
    WHERE agent NOT IN ('sentinel', 'healer')
    AND finished_at > NOW() - INTERVAL '48 hours'
  `.catch(() => [{ rate: 0 }]);
  const overallRate = Number(failRate?.rate || 0);

  let topItem = null;
  let topScore = -1;

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
    const daysSinceCreated = Math.max(0, (Date.now() - new Date(item.created_at).getTime()) / 86400000);
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

    if (scored.priority_score > topScore) {
      topScore = scored.priority_score;
      topItem = scored;
    }
  }

  if (!topItem) {
    return json({ dispatched: false, reason: "no_scorable_items" });
  }

  // Dispatch via GitHub Actions
  const ghPat = await getSettingValue("github_token").catch(() => null);
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

  // Build task with failure context
  let taskDescription = topItem.description;
  if (previousErrors) {
    taskDescription += `\n\n⚠️ PREVIOUS ATTEMPTS FAILED (attempt ${attemptCount + 1}):\n${previousErrors}\n\nDo NOT repeat the same approach. Analyze why it failed and try a different strategy.`;
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
        backlog_id: topItem.id,
        priority: topItem.priority,
        priority_score: topItem.priority_score,
        attempt: attemptCount + 1,
        chain_next: true,
      },
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (res.ok || res.status === 204) {
    // Mark as dispatched
    await sql`
      UPDATE hive_backlog
      SET status = 'dispatched', dispatched_at = NOW()
      WHERE id = ${topItem.id}
    `.catch(() => {});

    // Notify via Telegram
    const baseUrlNotify = process.env.NEXT_PUBLIC_URL || "https://hive-phi.vercel.app";
    await fetch(`${baseUrlNotify}/api/notify`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cronSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agent: "backlog",
        action: "dispatch",
        company: "_hive",
        status: "started",
        summary: `[${topItem.priority}] "${topItem.title}" dispatched to Engineer (score: ${topItem.priority_score}${attemptCount > 0 ? `, attempt ${attemptCount + 1}` : ""})`,
      }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});

    return json({
      dispatched: true,
      item: { id: topItem.id, title: topItem.title, priority: topItem.priority, priority_score: topItem.priority_score },
      score_breakdown: topItem.score_breakdown,
    });
  }

  return json({ dispatched: false, reason: "github_dispatch_failed", status: res.status });
}
