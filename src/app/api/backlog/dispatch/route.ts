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
    const { NextRequest } = await import("next/server");
    const { validateOIDC } = await import("@/lib/oidc");
    const result = await validateOIDC(new NextRequest(req));
    if (result instanceof Response) return result;
  }

  const sql = getDb();
  const body = await req.json().catch(() => ({}));
  const { completed_id, completed_status } = body;

  // If a completed item was passed, mark it done/failed
  if (completed_id && completed_status) {
    await sql`
      UPDATE hive_backlog
      SET status = ${completed_status === "success" ? "done" : "blocked"},
          completed_at = NOW(),
          notes = COALESCE(notes, '') || ${completed_status === "success" ? " Completed via chain dispatch." : " Failed — marked blocked."}
      WHERE id = ${completed_id} AND status IN ('dispatched', 'in_progress')
    `.catch(() => {});
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

  // Fetch ready backlog items (exclude manually-blocked items)
  const backlogItems = await sql`
    SELECT * FROM hive_backlog
    WHERE status IN ('ready', 'approved')
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

    const scored = computeBacklogScore(item as BacklogItem, {
      relatedErrors,
      companiesAffected,
      systemFailureRate: overallRate,
      hasSimilarFailed: !!failedSimilar,
      blocksAgents,
      daysSinceCreated,
      totalCompanies,
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

  const res = await fetch("https://api.github.com/repos/carloshmiranda/hive/dispatches", {
    method: "POST",
    headers: { Authorization: `token ${ghPat}`, Accept: "application/vnd.github.v3+json" },
    body: JSON.stringify({
      event_type: "feature_request",
      client_payload: {
        source: "backlog_chain",
        company: "_hive",
        task: topItem.description,
        backlog_id: topItem.id,
        priority: topItem.priority,
        priority_score: topItem.priority_score,
        chain_next: true, // Tell Engineer to call back when done
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

    return json({
      dispatched: true,
      item: { id: topItem.id, title: topItem.title, priority: topItem.priority, priority_score: topItem.priority_score },
      score_breakdown: topItem.score_breakdown,
    });
  }

  return json({ dispatched: false, reason: "github_dispatch_failed", status: res.status });
}
