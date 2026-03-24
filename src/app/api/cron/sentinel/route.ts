import { getDb } from "@/lib/db";
import { getSettingValue } from "@/lib/settings";
import { getBoilerplateGaps } from "@/lib/capabilities";
import { SCHEMA_MAP, getExpectedTables } from "@/lib/schema-map";
import { findCapabilityForProblem } from "@/lib/hive-capabilities";
import { normalizeError, errorSimilarity } from "@/lib/error-normalize";
import boilerplateManifest from "../../../../../templates/boilerplate-manifest.json";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const REPO = "carloshmiranda/hive";
const MAX_CYCLE_DISPATCHES = 2;

type Dispatch = { type: string; target: string; payload: Record<string, unknown> };

// --- Dispatch dedup (claims system) ---
// Prevents duplicate dispatches both within a single Sentinel run and across runs.
// Two layers:
//   1. Cross-run: query GitHub Actions API for in_progress/queued workflow runs
//   2. Within-run: track a Set of already-dispatched keys this execution

function claimKey(eventType: string, company?: string): string {
  return `${eventType}:${company || "_global"}`;
}

async function getActiveClaims(ghPat: string | null): Promise<Set<string>> {
  if (!ghPat) return new Set();
  const claims = new Set<string>();

  try {
    // Fetch in_progress and queued runs in parallel
    const [inProgressRes, queuedRes] = await Promise.all(
      ["in_progress", "queued"].map((status) =>
        fetch(
          `https://api.github.com/repos/${REPO}/actions/runs?status=${status}&per_page=50`,
          {
            headers: {
              Authorization: `token ${ghPat}`,
              Accept: "application/vnd.github.v3+json",
            },
            signal: AbortSignal.timeout(8000),
          }
        )
      )
    );

    for (const res of [inProgressRes, queuedRes]) {
      if (!res.ok) continue;
      const data = await res.json();
      for (const run of data.workflow_runs || []) {
        // Parse run name format: "Agent: event_type — company"
        const match = run.name?.match(/:\s*(\w+)\s*[—–-]\s*(\w+)/);
        if (match) {
          claims.add(claimKey(match[1], match[2]));
        }
        // Also extract from display_title for repository_dispatch events
        // where name might differ from event_type
        if (run.event === "repository_dispatch" && run.display_title) {
          const dtMatch = run.display_title.match(/:\s*(\w+)\s*[—–-]\s*(\w+)/);
          if (dtMatch) {
            claims.add(claimKey(dtMatch[1], dtMatch[2]));
          }
        }
      }
    }
  } catch {
    // Non-critical: if GitHub API fails, proceed without cross-run dedup
    console.log("[sentinel] Warning: could not fetch active runs for dedup");
  }

  return claims;
}

// Module-level state for the current Sentinel run (reset each invocation)
let activeClaims = new Set<string>();
let dispatchedThisRun = new Set<string>();
let dedupSkips = 0;

function isDuplicate(eventType: string, company?: string): boolean {
  const key = claimKey(eventType, company);
  if (dispatchedThisRun.has(key)) {
    dedupSkips++;
    console.log(`[sentinel] Dedup skip (within-run): ${key}`);
    return true;
  }
  if (activeClaims.has(key)) {
    dedupSkips++;
    console.log(`[sentinel] Dedup skip (cross-run, already running): ${key}`);
    return true;
  }
  return false;
}

function markDispatched(eventType: string, company?: string) {
  dispatchedThisRun.add(claimKey(eventType, company));
}

async function dispatchToActions(eventType: string, payload: Record<string, unknown>, ghPat: string | null) {
  if (!ghPat) return;
  const company = (payload.company as string) || undefined;
  if (isDuplicate(eventType, company)) return;
  markDispatched(eventType, company);

  await fetch(`https://api.github.com/repos/${REPO}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `token ${ghPat}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ event_type: eventType, client_payload: payload }),
  });

  // Non-blocking Telegram notification
  import("@/lib/telegram").then(({ notifyHive }) =>
    notifyHive({
      agent: (payload.agent as string) || eventType.split("_")[0],
      action: eventType,
      company,
      status: "started",
      summary: `Dispatched ${eventType} via GitHub Actions`,
    })
  ).catch(() => {});
}

async function dispatchToWorker(agent: string, companySlug: string, trigger: string) {
  if (isDuplicate(`worker_${agent}`, companySlug)) return;
  markDispatched(`worker_${agent}`, companySlug);

  const cronSecret = process.env.CRON_SECRET;
  const baseUrl = process.env.NEXT_PUBLIC_URL || "https://hive-phi.vercel.app";
  await fetch(`${baseUrl}/api/agents/dispatch`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cronSecret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ company_slug: companySlug, agent, trigger }),
  });

  // Non-blocking Telegram notification
  import("@/lib/telegram").then(({ notifyHive }) =>
    notifyHive({
      agent,
      action: trigger,
      company: companySlug,
      status: "started",
      summary: `Dispatched ${agent} worker for ${companySlug}`,
    })
  ).catch(() => {});
}

async function dispatchToCompanyWorkflow(
  githubRepo: string,
  workflow: string,
  inputs: Record<string, string>,
  ghPat: string | null
) {
  if (!ghPat) return;
  const company = inputs.company_slug;
  const workflowKey = workflow.replace(".yml", "");
  if (isDuplicate(`company_${workflowKey}`, company)) return;
  markDispatched(`company_${workflowKey}`, company);

  await fetch(`https://api.github.com/repos/${githubRepo}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `token ${ghPat}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: "main", inputs }),
  });

  // Non-blocking Telegram notification
  import("@/lib/telegram").then(({ notifyHive }) =>
    notifyHive({
      agent: inputs.agent || workflowKey.replace("hive-", ""),
      action: `${workflowKey} workflow`,
      company,
      status: "started",
      summary: `Dispatched ${workflow} on ${githubRepo.split("/")[1]}`,
    })
  ).catch(() => {});
}

async function checkHttpHealth(
  companies: Array<{ slug: string; url: string }>
): Promise<Array<{ slug: string; url: string; status: number; error?: string }>> {
  const results = await Promise.all(
    companies.map(async (c) => {
      try {
        const res = await fetch(c.url, {
          redirect: "follow",
          signal: AbortSignal.timeout(10000),
        });
        if (res.status >= 400) {
          return { slug: c.slug, url: c.url, status: res.status };
        }
        return null;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "unknown";
        return { slug: c.slug, url: c.url, status: 0, error: msg };
      }
    })
  );
  return results.filter((r): r is NonNullable<typeof r> => r !== null);
}

async function checkDeployDrift(vercelToken: string | null, ghPat: string | null): Promise<{
  drifted: boolean;
  mainSha?: string;
  deploySha?: string;
}> {
  if (!vercelToken || !ghPat) return { drifted: false };

  try {
    const [mainRes, deployRes] = await Promise.all([
      fetch(`https://api.github.com/repos/${REPO}/commits/main`, {
        headers: { Authorization: `token ${ghPat}`, Accept: "application/vnd.github.v3+json" },
        signal: AbortSignal.timeout(10000),
      }),
      fetch(
        "https://api.vercel.com/v6/deployments?projectId=prj_n9JaPbWmRv0SKoHgkdXYOEGQtjRv&teamId=team_Z4AsGtjfy6pAjCOtvJqzMT8d&target=production&limit=1",
        {
          headers: { Authorization: `Bearer ${vercelToken}` },
          signal: AbortSignal.timeout(10000),
        }
      ),
    ]);

    if (!mainRes.ok || !deployRes.ok) return { drifted: false };

    const mainData = await mainRes.json();
    const deployData = await deployRes.json();
    const mainSha = mainData.sha?.slice(0, 12);
    const deploySha = deployData.deployments?.[0]?.meta?.githubCommitSha?.slice(0, 12);

    if (mainSha && deploySha && mainSha !== deploySha) {
      return { drifted: true, mainSha, deploySha };
    }
    return { drifted: false, mainSha, deploySha };
  } catch {
    return { drifted: false };
  }
}

async function isCircuitOpen(sql: any, agent: string, companyId: string | null): Promise<boolean> {
  if (!companyId) return false;
  const [result] = await sql`
    SELECT COUNT(*)::int as failures FROM agent_actions
    WHERE agent = ${agent} AND company_id = ${companyId}
    AND status = 'failed' AND started_at > NOW() - INTERVAL '24 hours'
  `;
  return (result?.failures || 0) >= 3;
}

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
  const sql = getDb();
  const traceId = crypto.randomUUID();
  const vercelToken = await getSettingValue("vercel_token");
  const ghPat = await getSettingValue("github_token");
  const dispatches: Dispatch[] = [];
  let cycleDispatches = 0;
  let circuitBreaks = 0;

  // Initialize dispatch dedup — fetch active GitHub Actions runs
  activeClaims = await getActiveClaims(ghPat);
  dispatchedThisRun = new Set<string>();
  dedupSkips = 0;
  if (activeClaims.size > 0) {
    console.log(`[sentinel] Active claims (${activeClaims.size}): ${[...activeClaims].join(", ")}`);
  }

  // --- Auto-expire stale approvals ---
  // Different gate types get different expiry windows based on urgency
  const expiredApprovals = await sql`
    UPDATE approvals
    SET status = 'expired',
        decision_note = 'Auto-expired: not reviewed within expiry window',
        decided_at = NOW()
    WHERE status = 'pending'
    AND (
      (gate_type = 'new_company' AND created_at < NOW() - INTERVAL '7 days')
      OR (gate_type = 'growth_strategy' AND created_at < NOW() - INTERVAL '7 days')
      OR (gate_type = 'spend_approval' AND created_at < NOW() - INTERVAL '7 days')
      OR (gate_type = 'outreach_batch' AND created_at < NOW() - INTERVAL '7 days')
      OR (gate_type = 'prompt_upgrade' AND created_at < NOW() - INTERVAL '14 days')
      OR (gate_type = 'social_account' AND created_at < NOW() - INTERVAL '14 days')
      OR (gate_type = 'capability_migration' AND created_at < NOW() - INTERVAL '3 days')
      OR (gate_type IN ('escalation', 'ops_escalation') AND created_at < NOW() - INTERVAL '2 days')
    )
    RETURNING id, gate_type, title
  `;
  if (expiredApprovals.length > 0) {
    console.log(`Auto-expired ${expiredApprovals.length} stale approvals: ${expiredApprovals.map((a: any) => `${a.gate_type}:${a.id}`).join(", ")}`);
  }

  // Clean up orphaned companies from expired new_company approvals
  // (companies stuck in 'idea' status with no pending approval)
  const cleanedCompanies = await sql`
    UPDATE companies SET status = 'killed', updated_at = NOW()
    WHERE status = 'idea'
    AND id NOT IN (
      SELECT company_id FROM approvals WHERE gate_type = 'new_company' AND status = 'pending' AND company_id IS NOT NULL
    )
    RETURNING id, slug
  `;
  if (cleanedCompanies.length > 0) {
    console.log(`Cleaned ${cleanedCompanies.length} orphaned idea companies: ${cleanedCompanies.map((c: any) => c.slug).join(", ")}`);
  }

  // --- Run all DB health checks ---
  // NOTE: Many checks below query companies with status IN ('mvp','active').
  // Companies without infra (github_repo IS NULL) should be EXCLUDED from dispatch-triggering
  // checks. Only check 9b (orphaned MVPs) intentionally includes them to trigger provisioning.

  // 1. Pipeline count + Scout proposal management
  const [pipeline] = await sql`
    SELECT COUNT(*) as cnt FROM companies
    WHERE status IN ('idea','approved','provisioning','mvp','active')
  `;
  const [pendingIdeas] = await sql`
    SELECT COUNT(*) as cnt FROM companies WHERE status = 'idea'
  `;

  // Check pending Scout proposals (new_company approvals)
  const [pendingProposals] = await sql`
    SELECT COUNT(*) as cnt FROM approvals
    WHERE gate_type = 'new_company' AND status = 'pending'
  `;

  // Auto-cleanup stale Scout proposals when pipeline is clogged (>5 pending)
  let proposalCleanupCount = 0;
  if (parseInt(pendingProposals.cnt) > 5) {
    console.log(`[sentinel] Pipeline clogged: ${pendingProposals.cnt} pending Scout proposals`);
    try {
      const cleanupRes = await fetch("https://hive-phi.vercel.app/api/approvals/scout-cleanup", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${process.env.CRON_SECRET}`
        },
        body: JSON.stringify({
          max_pending: 3,
          min_age_hours: 48,
          reason: "Auto-cleanup by Sentinel: too many Scout proposals blocking company execution"
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (cleanupRes.ok) {
        const data = await cleanupRes.json();
        proposalCleanupCount = data.expired_count || 0;
        console.log(`[sentinel] Scout cleanup: expired ${proposalCleanupCount} stale proposals`);
      }
    } catch (e) {
      console.log(`[sentinel] Scout cleanup failed: ${e instanceof Error ? e.message : "unknown"}`);
    }
  }

  // Check for stale proposals (>48h old)
  const [staleProposals] = await sql`
    SELECT COUNT(*) as cnt FROM approvals
    WHERE gate_type = 'new_company' AND status = 'pending'
    AND created_at < NOW() - INTERVAL '48 hours'
  `;

  // Scout blocked if too many pending proposals or any stale proposals exist
  const scoutBlocked = parseInt(pendingProposals.cnt) > 3 || parseInt(staleProposals.cnt) > 0;
  const pipelineLow = parseInt(pipeline.cnt) < 3 && parseInt(pendingIdeas.cnt) === 0 && !scoutBlocked;

  // 2. Stale content (no growth success in 7 days)
  const staleContent = await sql`
    SELECT c.slug, c.github_repo FROM companies c
    WHERE c.status IN ('mvp','active') AND c.github_repo IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM agent_actions aa
      WHERE aa.company_id = c.id AND aa.agent = 'growth'
      AND aa.status = 'success' AND aa.finished_at > NOW() - INTERVAL '7 days'
    )
  `;

  // 3. Stale leads (lead_list >5 days, no outreach)
  const staleLeads = await sql`
    SELECT c.slug FROM companies c
    WHERE c.status IN ('mvp','active') AND c.github_repo IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM research_reports rr
      WHERE rr.company_id = c.id AND rr.report_type = 'lead_list'
      AND rr.updated_at < NOW() - INTERVAL '5 days'
    )
    AND NOT EXISTS (
      SELECT 1 FROM agent_actions aa
      WHERE aa.company_id = c.id AND aa.agent = 'outreach'
      AND aa.status = 'success' AND aa.finished_at > NOW() - INTERVAL '5 days'
    )
  `;

  // 4. No CEO review in 48h
  const noCeoReview = await sql`
    SELECT c.slug FROM companies c
    WHERE c.status IN ('mvp','active') AND c.github_repo IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM agent_actions aa
      WHERE aa.company_id = c.id AND aa.agent = 'ceo'
      AND aa.status = 'success' AND aa.finished_at > NOW() - INTERVAL '48 hours'
    )
  `;

  // 5. Unverified deploys in 24h
  const unverifiedDeploys = await sql`
    SELECT c.slug FROM companies c
    WHERE c.status IN ('mvp','active') AND c.github_repo IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM agent_actions aa
      WHERE aa.company_id = c.id AND aa.action_type = 'deploy'
      AND aa.finished_at > NOW() - INTERVAL '24 hours'
    )
    AND NOT EXISTS (
      SELECT 1 FROM agent_actions aa
      WHERE aa.company_id = c.id AND aa.agent = 'ops'
      AND aa.action_type = 'health_check'
      AND aa.finished_at > NOW() - INTERVAL '24 hours'
    )
  `;

  // 6. Evolve due (>10 completed cycles since last evolve)
  const [lastEvolve] = await sql`
    SELECT MAX(finished_at) as last_run FROM agent_actions
    WHERE agent = 'evolver' AND status = 'success'
  `;
  const [cyclesSinceEvolve] = await sql`
    SELECT COUNT(*) as cnt FROM cycles
    WHERE status = 'completed'
    AND finished_at > COALESCE(${lastEvolve?.last_run}, '2000-01-01'::timestamptz)
  `;
  const evolveDue = parseInt(cyclesSinceEvolve.cnt) > 10;

  // 7. High failure rate >20% in 48h (min 5 actions)
  // Exclude healer+sentinel from the count — their own failures would trigger more healer
  // dispatches, creating a self-reinforcing loop
  const [failureStats] = await sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'failed') as failed,
      COUNT(*) as total
    FROM agent_actions
    WHERE finished_at > NOW() - INTERVAL '48 hours'
      AND agent NOT IN ('healer', 'sentinel')
  `;
  const failRate = parseInt(failureStats.total) > 0
    ? parseInt(failureStats.failed) / parseInt(failureStats.total)
    : 0;
  const highFailureRate = failRate > 0.2 && parseInt(failureStats.total) >= 5;

  // 8. Stale research (no research in 14 days)
  const staleResearch = await sql`
    SELECT c.slug FROM companies c
    WHERE c.status IN ('mvp','active') AND c.github_repo IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM research_reports rr
      WHERE rr.company_id = c.id AND rr.updated_at > NOW() - INTERVAL '14 days'
    )
  `;

  // 9. Stuck in 'approved' status
  const stuckApproved = await sql`
    SELECT slug FROM companies
    WHERE status = 'approved' AND updated_at < NOW() - INTERVAL '1 hour'
  `;

  // 9b. Orphaned MVPs (status=mvp but no infra)
  const orphanedMvps = await sql`
    SELECT c.slug FROM companies c
    WHERE c.status = 'mvp'
    AND NOT EXISTS (SELECT 1 FROM infra i WHERE i.company_id = c.id)
  `;

  // 9c. MVPs with missing Neon DB (have some infra but no neon_project_id)
  const missingNeonDb = await sql`
    SELECT c.slug FROM companies c
    WHERE c.status IN ('mvp', 'active')
    AND c.neon_project_id IS NULL
    AND c.github_repo IS NOT NULL
  `;

  // 10. Max turns exhaustion
  const maxTurnsHits = await sql`
    SELECT agent, COUNT(*) as cnt
    FROM agent_actions
    WHERE status = 'failed' AND error ILIKE '%max_turns%'
    AND finished_at > NOW() - INTERVAL '48 hours'
    GROUP BY agent HAVING COUNT(*) >= 2
  `;

  // 11. Chain dispatch gaps
  const chainGaps = await sql`
    SELECT aa.agent as source_agent, c.slug, c.github_repo
    FROM agent_actions aa
    JOIN companies c ON c.id = aa.company_id
    WHERE aa.status = 'success' AND aa.agent = 'ceo'
    AND aa.output::text ILIKE '%needs_feature%true%'
    AND aa.finished_at > NOW() - INTERVAL '48 hours'
    AND c.github_repo IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM agent_actions aa2
      WHERE aa2.agent = 'engineer' AND aa2.company_id = aa.company_id
      AND aa2.started_at > aa.finished_at
      AND aa2.started_at < aa.finished_at + INTERVAL '30 minutes'
    )
  `;

  // 12. Stalled companies (72h no activity)
  const stalledCompanies = await sql`
    SELECT c.slug, c.id as company_id, MAX(aa.finished_at) as last_activity
    FROM companies c
    LEFT JOIN agent_actions aa ON aa.company_id = c.id
    WHERE c.status IN ('mvp', 'active')
    AND EXISTS (SELECT 1 FROM infra i WHERE i.company_id = c.id)
    GROUP BY c.id, c.slug
    HAVING MAX(aa.finished_at) < NOW() - INTERVAL '72 hours'
      OR MAX(aa.finished_at) IS NULL
  `;

  // 13. Companies needing new cycle — ranked by priority score
  // Score = task pressure + staleness + lifecycle bonus + directive override
  // Higher score = dispatched first. Budget-aware: checks daily Claude usage.
  const needsCycle = await sql`
    WITH company_signals AS (
      SELECT
        c.slug,
        c.id as company_id,
        c.status,
        -- Pending task count (proposed + approved = work waiting)
        COALESCE((SELECT COUNT(*) FROM company_tasks ct
          WHERE ct.company_id = c.id AND ct.status IN ('proposed', 'approved')), 0) AS pending_tasks,
        -- Days since last completed cycle
        COALESCE(EXTRACT(EPOCH FROM (NOW() - (
          SELECT MAX(cy.finished_at) FROM cycles cy
          WHERE cy.company_id = c.id AND cy.status = 'completed'
        ))) / 86400.0, 30) AS days_since_cycle,
        -- Total completed cycles
        COALESCE((SELECT COUNT(*) FROM cycles cy
          WHERE cy.company_id = c.id AND cy.status = 'completed'), 0) AS total_cycles,
        -- Last CEO score (NULL if no review yet)
        (SELECT (cy.ceo_review->>'score')::int FROM cycles cy
          WHERE cy.company_id = c.id AND cy.ceo_review IS NOT NULL
          ORDER BY cy.finished_at DESC LIMIT 1) AS last_score,
        -- Has open Carlos directive (urgent override)
        EXISTS(SELECT 1 FROM directives d
          WHERE d.company_id = c.id AND d.status = 'open') AS has_directive,
        -- Has revenue (active paying customers)
        EXISTS(SELECT 1 FROM metrics m
          WHERE m.company_id = c.id AND m.mrr > 0
          AND m.date > NOW() - INTERVAL '30 days') AS has_revenue
      FROM companies c
      WHERE c.status IN ('mvp', 'active')
      AND EXISTS (SELECT 1 FROM infra i WHERE i.company_id = c.id)
      AND NOT EXISTS (
        SELECT 1 FROM cycles cy
        WHERE cy.company_id = c.id
        AND cy.status IN ('running', 'completed')
        AND cy.started_at > NOW() - INTERVAL '24 hours'
      )
    )
    SELECT slug, company_id,
      (
        (pending_tasks * 2)
        + (LEAST(days_since_cycle, 14) * 3)
        + (CASE WHEN total_cycles = 0 THEN 10 ELSE 0 END)
        + (CASE WHEN last_score IS NOT NULL AND last_score < 5 THEN 5 ELSE 0 END)
        + (CASE WHEN has_directive THEN 15 ELSE 0 END)
        + (CASE WHEN status = 'mvp' AND total_cycles < 3 THEN 8 ELSE 0 END)
        - (LEAST(total_cycles, 20) * 0.5)
      ) AS priority_score
    FROM company_signals
    ORDER BY priority_score DESC
  `;

  // 13b. Stuck cycles (running >2h, auto-cleanup)
  // Get stuck cycles before cleanup
  const stuckCycles = await sql`
    SELECT id, cycle_number, company_id
    FROM cycles
    WHERE status = 'running' AND started_at < NOW() - INTERVAL '2 hours'
  `;

  // Use the cleanup endpoint for each stuck cycle to avoid interfering with CEO reviews
  for (const cycle of stuckCycles) {
    try {
      const response = await fetch(`${process.env.VERCEL_URL || 'https://hive-phi.vercel.app'}/api/cycles/${cycle.id}/cleanup`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${process.env.CRON_SECRET}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          cleanup_reason: 'Cycle stuck in running state >2h, cleaned up by Sentinel',
          status: 'failed'
        })
      });

      if (!response.ok) {
        console.error(`Failed to cleanup cycle ${cycle.id}: ${response.status}`);
      }
    } catch (error) {
      console.error(`Error cleaning up cycle ${cycle.id}:`, error);
    }
  }

  // 13b2. Task stealability — stale running agent_actions (stuck >1h)
  // If a GitHub Actions run crashes without writing failure to Neon, the action stays
  // 'running' forever. Mark as 'failed' so the retry logic in 13c can pick it up.
  const staleRunning = await sql`
    UPDATE agent_actions
    SET status = 'failed',
        error = 'Stale: marked failed by Sentinel after 1h+ in running state (likely GitHub Actions crash/timeout)',
        finished_at = NOW()
    WHERE status = 'running'
    AND started_at < NOW() - INTERVAL '1 hour'
    AND agent IN ('engineer', 'growth', 'ceo', 'scout', 'healer', 'evolver')
    RETURNING id, agent, company_id
  `;
  if (staleRunning.length > 0) {
    console.log(`[sentinel] Task stealability: marked ${staleRunning.length} stale running actions as failed`);
  }

  // 13c. Failed agent tasks with unfinished CEO plan work — re-dispatch
  // When Engineer/Growth fails, the tasks from ceo_plan are lost. Detect and retry.
  const failedWithPlanWork = await sql`
    SELECT DISTINCT ON (aa.company_id, aa.agent)
      aa.id as action_id, aa.agent, aa.action_type, aa.error, aa.company_id, c.slug, c.github_repo
    FROM agent_actions aa
    JOIN companies c ON c.id = aa.company_id
    WHERE aa.status = 'failed'
    AND aa.agent IN ('engineer', 'growth')
    AND aa.finished_at > NOW() - INTERVAL '12 hours'
    AND c.status IN ('mvp', 'active')
    AND c.github_repo IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM agent_actions aa2
      WHERE aa2.company_id = aa.company_id
      AND aa2.agent = aa.agent
      AND aa2.status = 'success'
      AND aa2.started_at > aa.finished_at
    )
    AND NOT EXISTS (
      SELECT 1 FROM agent_actions aa3
      WHERE aa3.company_id = aa.company_id
      AND aa3.agent = aa.agent
      AND aa3.action_type = 'sentinel_retry'
      AND aa3.started_at > NOW() - INTERVAL '6 hours'
    )
    ORDER BY aa.company_id, aa.agent, aa.finished_at DESC
  `;

  // 14. Rate-limited agents (0 turns)
  const rateLimited = await sql`
    SELECT aa.agent, aa.action_type, aa.company_id, c.slug, c.github_repo
    FROM agent_actions aa
    INNER JOIN companies c ON c.id = aa.company_id
    WHERE aa.status = 'failed'
    AND aa.company_id IS NOT NULL
    AND aa.error ILIKE '%exhausted after 0 turns%'
    AND aa.finished_at > NOW() - INTERVAL '6 hours'
    AND NOT EXISTS (
      SELECT 1 FROM agent_actions aa2
      WHERE aa2.company_id = aa.company_id
      AND aa2.agent = aa.agent AND aa2.action_type = aa.action_type
      AND aa2.status = 'success' AND aa2.started_at > aa.finished_at
    )
  `;

  // 15. Unverified provisions (provisioned in last 2h, no deploy_verified)
  const unverifiedProvisions = await sql`
    SELECT c.slug, c.id as company_id, c.vercel_url
    FROM companies c
    JOIN agent_actions aa ON aa.company_id = c.id
      AND aa.action_type = 'scaffold_company'
      AND aa.status = 'success'
      AND aa.finished_at > NOW() - INTERVAL '2 hours'
    WHERE c.status = 'mvp'
    AND NOT EXISTS (
      SELECT 1 FROM agent_actions aa2
      WHERE aa2.company_id = c.id
      AND aa2.action_type = 'deploy_verified'
      AND aa2.finished_at > aa.finished_at
    )
  `;

  // 16. Missing metrics (no metrics row in 48h)
  const missingMetrics = await sql`
    SELECT c.slug FROM companies c
    WHERE c.status IN ('mvp', 'active') AND c.github_repo IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM metrics m
      WHERE m.company_id = c.id AND m.date > CURRENT_DATE - INTERVAL '2 days'
    )
  `;

  // 18. Anomaly detection — flag metrics moving >2 std dev from 14-day rolling average
  type Anomaly = { slug: string; company_id: string; metric: string; current: number; avg: number; stddev: number; direction: string };
  const anomalies: Anomaly[] = [];
  const anomalyRows = await sql`
    WITH daily AS (
      SELECT m.company_id, c.slug,
        m.date,
        m.mrr::float as mrr,
        m.page_views::float as page_views,
        m.signups::float as signups,
        m.customers::float as customers,
        m.waitlist_signups::float as waitlist_signups
      FROM metrics m
      JOIN companies c ON c.id = m.company_id
      WHERE c.status IN ('mvp', 'active')
        AND m.date >= CURRENT_DATE - INTERVAL '15 days'
    ),
    stats AS (
      SELECT company_id, slug,
        AVG(mrr) as avg_mrr, STDDEV_POP(mrr) as std_mrr,
        AVG(page_views) as avg_pv, STDDEV_POP(page_views) as std_pv,
        AVG(signups) as avg_signups, STDDEV_POP(signups) as std_signups,
        AVG(customers) as avg_cust, STDDEV_POP(customers) as std_cust,
        AVG(waitlist_signups) as avg_wl, STDDEV_POP(waitlist_signups) as std_wl,
        COUNT(*) as data_points
      FROM daily
      WHERE date < CURRENT_DATE
      GROUP BY company_id, slug
      HAVING COUNT(*) >= 5
    ),
    latest AS (
      SELECT DISTINCT ON (company_id)
        company_id, mrr, page_views, signups, customers, waitlist_signups
      FROM daily
      ORDER BY company_id, date DESC
    )
    SELECT s.company_id, s.slug,
      l.mrr as cur_mrr, s.avg_mrr, s.std_mrr,
      l.page_views as cur_pv, s.avg_pv, s.std_pv,
      l.signups as cur_signups, s.avg_signups, s.std_signups,
      l.customers as cur_cust, s.avg_cust, s.std_cust,
      l.waitlist_signups as cur_wl, s.avg_wl, s.std_wl
    FROM stats s
    JOIN latest l ON l.company_id = s.company_id
  `;

  for (const r of anomalyRows) {
    const checks: Array<{ metric: string; cur: number; avg: number; std: number }> = [
      { metric: "mrr", cur: r.cur_mrr, avg: r.avg_mrr, std: r.std_mrr },
      { metric: "page_views", cur: r.cur_pv, avg: r.avg_pv, std: r.std_pv },
      { metric: "signups", cur: r.cur_signups, avg: r.avg_signups, std: r.std_signups },
      { metric: "customers", cur: r.cur_cust, avg: r.avg_cust, std: r.std_cust },
      { metric: "waitlist_signups", cur: r.cur_wl, avg: r.avg_wl, std: r.std_wl },
    ];
    for (const c of checks) {
      const std = Number(c.std) || 0;
      const avg = Number(c.avg) || 0;
      const cur = Number(c.cur) || 0;
      // Skip if no variance or avg is 0 (no meaningful baseline)
      if (std === 0 || avg === 0) continue;
      const deviation = Math.abs(cur - avg) / std;
      if (deviation > 2) {
        anomalies.push({
          slug: r.slug as string,
          company_id: r.company_id as string,
          metric: c.metric,
          current: cur,
          avg: Math.round(avg * 100) / 100,
          stddev: Math.round(std * 100) / 100,
          direction: cur > avg ? "spike" : "drop",
        });
      }
    }
  }

  // Store anomalies for CEO to address
  if (anomalies.length > 0) {
    for (const a of anomalies) {
      await sql`
        INSERT INTO agent_actions (agent, company_id, action_type, status, description, output, started_at, finished_at)
        VALUES ('sentinel', ${a.company_id}, 'anomaly_detected', 'success',
          ${`Anomaly: ${a.metric} ${a.direction} for ${a.slug} (${a.current} vs avg ${a.avg}, ±${a.stddev})`},
          ${JSON.stringify(a)}::jsonb, NOW(), NOW())
      `;
    }
    // Dispatch CEO to review anomalies (pick the most affected company)
    const topAnomaly = anomalies[0];
    await dispatchToActions("ceo_review", {
      source: "sentinel_anomaly",
      company: topAnomaly.slug,
      anomalies: anomalies.map(a => `${a.slug}:${a.metric}(${a.direction})`),
      trace_id: traceId,
    }, ghPat);
    dispatches.push({
      type: "brain",
      target: "ceo_review",
      payload: { reason: "anomaly_detected", count: anomalies.length, anomalies },
    });
  }

  // 19. Evolver staleness — trigger when success rate drops or enough cycles completed
  // (replaces the Wednesday calendar cron with data-driven conditions)
  const evolverNeeded = evolveDue || highFailureRate || maxTurnsHits.length > 0;
  if (!evolverNeeded) {
    // Additional data condition: success rate dropped below 80% in last 7 days vs prior 7 days
    const [recentStats] = await sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'success') as s,
        COUNT(*) as t
      FROM agent_actions WHERE finished_at > NOW() - INTERVAL '7 days'
    `;
    const [priorStats] = await sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'success') as s,
        COUNT(*) as t
      FROM agent_actions
      WHERE finished_at BETWEEN NOW() - INTERVAL '14 days' AND NOW() - INTERVAL '7 days'
    `;
    const recentRate = parseInt(recentStats.t) > 5 ? parseInt(recentStats.s) / parseInt(recentStats.t) : 1;
    const priorRate = parseInt(priorStats.t) > 5 ? parseInt(priorStats.s) / parseInt(priorStats.t) : 1;
    // If success rate dropped >15 percentage points week-over-week, trigger Evolver
    if (priorRate - recentRate > 0.15 && parseInt(recentStats.t) >= 10) {
      const [lastEvolverRun] = await sql`
        SELECT MAX(finished_at) as last_run FROM agent_actions
        WHERE agent = 'evolver' AND finished_at > NOW() - INTERVAL '48 hours'
      `;
      if (!lastEvolverRun?.last_run) {
        await dispatchToActions("evolve_trigger", {
          source: "sentinel",
          reason: "success_rate_drop",
          recent_rate: Math.round(recentRate * 100),
          prior_rate: Math.round(priorRate * 100),
          trace_id: traceId,
        }, ghPat);
        dispatches.push({
          type: "brain",
          target: "evolve_trigger",
          payload: { reason: "success_rate_drop", recent: Math.round(recentRate * 100), prior: Math.round(priorRate * 100) },
        });
      }
    }
  }

  // 20. Boilerplate migration detection — compare company capabilities against manifest
  // Runs on Vercel (free), dispatches to company repos (free Actions on public repos)
  const companiesForMigration = await sql`
    SELECT id, slug, capabilities, company_type, github_repo, last_assessed_at
    FROM companies
    WHERE status IN ('mvp', 'active')
      AND github_repo IS NOT NULL
      AND capabilities IS NOT NULL
      AND capabilities != '{}'::jsonb
      AND last_assessed_at IS NOT NULL
  `;

  for (const co of companiesForMigration) {
    const gaps = getBoilerplateGaps(
      co.capabilities as Record<string, unknown>,
      (co.company_type as string) || "b2c_saas",
      boilerplateManifest
    );

    if (gaps.length === 0) continue;

    // Check if we already have a pending migration approval for this company
    const [existingApproval] = await sql`
      SELECT id FROM approvals
      WHERE company_id = ${co.id}
        AND gate_type = 'capability_migration'
        AND status = 'pending'
      LIMIT 1
    `;
    if (existingApproval) continue;

    // Create approval gate with migration details
    await sql`
      INSERT INTO approvals (company_id, gate_type, title, description, context)
      VALUES (
        ${co.id},
        'capability_migration',
        ${"Boilerplate migration: " + gaps.length + " features available for " + co.slug},
        ${gaps.map(g => `• ${g.description}`).join("\n")},
        ${JSON.stringify({
          company: co.slug,
          github_repo: co.github_repo,
          boilerplate_version: boilerplateManifest.version,
          gaps: gaps,
        })}::jsonb
      )
      ON CONFLICT DO NOTHING
    `;

    dispatches.push({
      type: "approval",
      target: "capability_migration",
      payload: { company: co.slug as string, gaps: gaps.length },
    });
  }

  // 21. Missing product spec — every active company needs mission/vision/what_we_build
  const companiesMissingSpec = await sql`
    SELECT c.id, c.slug FROM companies c
    WHERE c.status IN ('mvp', 'active')
    AND NOT EXISTS (
      SELECT 1 FROM research_reports rr
      WHERE rr.company_id = c.id AND rr.report_type = 'product_spec'
    )
  `;
  for (const co of companiesMissingSpec) {
    // Check debounce — don't dispatch if CEO already ran for this company in last 24h
    const [recent] = await sql`
      SELECT id FROM agent_actions
      WHERE company_id = ${co.id} AND agent = 'ceo'
      AND action_type = 'product_spec_generation'
      AND started_at > NOW() - INTERVAL '24 hours'
      LIMIT 1
    `;
    if (recent) continue;

    await dispatchToActions("cycle_start", {
      source: "sentinel",
      company: co.slug,
      directive: "Generate product_spec with mission, what_we_build, and vision. Use existing market_research and competitive_analysis reports as input. This is priority 1 for this cycle.",
      trace_id: traceId,
    }, ghPat);
    dispatches.push({ type: "brain", target: "ceo_product_spec", payload: { company: co.slug } });
  }

  // 22. Empty task backlog — active companies with no proposed tasks need CEO to generate them
  const companiesNoTasks = await sql`
    SELECT c.id, c.slug FROM companies c
    WHERE c.status IN ('mvp', 'active')
    AND NOT EXISTS (
      SELECT 1 FROM company_tasks ct
      WHERE ct.company_id = c.id AND ct.status NOT IN ('done', 'dismissed')
    )
  `;
  for (const co of companiesNoTasks) {
    const [recent] = await sql`
      SELECT id FROM agent_actions
      WHERE company_id = ${co.id} AND agent = 'ceo'
      AND action_type = 'task_generation'
      AND started_at > NOW() - INTERVAL '48 hours'
      LIMIT 1
    `;
    if (recent) continue;

    await dispatchToActions("cycle_start", {
      source: "sentinel",
      company: co.slug,
      directive: "Generate task backlog with proposed_tasks. Include 5-10 tasks across engineering, growth, research, qa, and ops categories based on company lifecycle stage.",
      trace_id: traceId,
    }, ghPat);
    dispatches.push({ type: "brain", target: "ceo_task_backlog", payload: { company: co.slug } });
  }

  // 23. Auto-assess companies that haven't been assessed (or assessed >7 days ago)
  // This feeds check 20 (boilerplate migration detection) which is type-aware via the manifest
  const unassessedCompanies = await sql`
    SELECT c.id, c.slug FROM companies c
    WHERE c.status IN ('mvp', 'active') AND c.github_repo IS NOT NULL
    AND (c.last_assessed_at IS NULL OR c.last_assessed_at < NOW() - INTERVAL '7 days')
  `;
  const baseUrl = process.env.NEXT_PUBLIC_URL || "https://hive-phi.vercel.app";
  const cronSecret = process.env.CRON_SECRET;
  for (const co of unassessedCompanies) {
    try {
      // Trigger assessment via the assess endpoint (internal call)
      await fetch(`${baseUrl}/api/companies/${co.id}/assess`, {
        method: "POST",
        headers: {
          // Use session cookie if available, otherwise pass CRON_SECRET as bearer
          Authorization: `Bearer ${cronSecret}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(15000),
      });
      dispatches.push({
        type: "internal",
        target: "auto_assess",
        payload: { company: co.slug },
      });
    } catch {
      // Non-blocking — assessment will retry next Sentinel run
    }
  }

  // 24. Schema drift detection — compare expected schema map against live DB
  // Catches: missing tables, missing columns, extra columns, stale CHECK constraints
  const schemaDrift: Array<{ table: string; issue: string }> = [];
  try {
    const expected = getExpectedTables();
    // Query live DB for actual tables and columns
    const liveTables = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;
    const liveTableNames = new Set(liveTables.map((t: any) => t.table_name as string));

    for (const { table } of expected) {
      if (!liveTableNames.has(table)) {
        schemaDrift.push({ table, issue: `Table '${table}' expected but missing from DB` });
        continue;
      }
      // Check columns for this table
      const liveCols = await sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${table}
      `;
      const liveColNames = new Set(liveCols.map((c: any) => c.column_name as string));
      const expectedCols = Object.keys(SCHEMA_MAP[table].columns);

      for (const col of expectedCols) {
        if (!liveColNames.has(col)) {
          schemaDrift.push({ table, issue: `Column '${table}.${col}' expected but missing from DB` });
        }
      }
      // Warn about extra columns in DB not in schema map (may indicate schema.sql is stale)
      for (const liveCol of liveColNames) {
        if (!SCHEMA_MAP[table].columns[liveCol]) {
          schemaDrift.push({ table, issue: `Column '${table}.${liveCol}' exists in DB but not in schema map — update schema.sql` });
        }
      }
    }

    if (schemaDrift.length > 0) {
      console.warn(`Schema drift detected (${schemaDrift.length} issues):`, schemaDrift);
      // Log as an agent action so it's visible in the dashboard + Healer can pick it up
      await sql`
        INSERT INTO agent_actions (agent, action_type, description, status, error, started_at, finished_at)
        VALUES (
          'sentinel', 'schema_drift_check',
          ${`Schema drift: ${schemaDrift.length} mismatches found`},
          'failed',
          ${JSON.stringify(schemaDrift)},
          NOW(), NOW()
        )
      `;
      // If systemic (3+ issues), dispatch Healer
      if (schemaDrift.length >= 3) {
        await dispatchToActions("healer_trigger", {
          source: "sentinel",
          error_class: "schema_mismatch",
          drift: schemaDrift,
          trace_id: traceId,
        }, ghPat);
        dispatches.push({ type: "brain", target: "healer_trigger", payload: { error_class: "schema_mismatch", count: schemaDrift.length } });
      }
    }
  } catch (e: any) {
    console.warn("Schema drift check failed (non-blocking):", e.message);
  }

  // 17. Dispatch loop detection (>5 same-agent actions in 30 min = likely loop)
  const dispatchLoops = await sql`
    SELECT agent, company_id, c.slug, COUNT(*) as cnt
    FROM agent_actions aa
    LEFT JOIN companies c ON c.id = aa.company_id
    WHERE aa.started_at > NOW() - INTERVAL '30 minutes'
    GROUP BY aa.agent, aa.company_id, c.slug
    HAVING COUNT(*) >= 5
  `;
  if (dispatchLoops.length > 0) {
    const loopDetails = dispatchLoops.map((r: any) => `${r.agent}/${r.slug}:${r.cnt}`).join(", ");
    console.warn(`DISPATCH LOOP DETECTED: ${loopDetails}`);
    // Log as escalation — but only if no pending escalation already exists for this agent/company
    for (const r of dispatchLoops) {
      const [existing] = await sql`
        SELECT id FROM approvals
        WHERE company_id = ${r.company_id} AND gate_type = 'escalation'
        AND status = 'pending' AND title LIKE ${"Dispatch loop: " + r.agent + "%"}
        LIMIT 1
      `;
      if (!existing) {
        await sql`
          INSERT INTO approvals (company_id, gate_type, title, description, context)
          VALUES (
            ${r.company_id}, 'escalation',
            ${"Dispatch loop: " + r.agent + " fired " + r.cnt + "x in 30min for " + r.slug},
            'Possible infinite dispatch loop detected. Check chain dispatch logic for this agent/company pair.',
            ${JSON.stringify({ agent: r.agent, company: r.slug, count: parseInt(r.cnt), detected_by: "sentinel" })}::jsonb
          )
          ON CONFLICT DO NOTHING
        `;
      }
    }
    dispatches.push({ type: "escalation", target: "dispatch_loop", payload: { loops: loopDetails } });
  }

  // 25. Recurring escalation detector — find approval patterns that repeat
  // If the same gate_type + company_id appears 2+ times in 14 days, the system
  // keeps hitting the same wall. Try to auto-resolve via capability registry.
  const recurringEscalations = await sql`
    SELECT a.gate_type, a.company_id, c.slug, COUNT(*)::int as occurrences,
      MAX(a.description) as latest_description
    FROM approvals a
    JOIN companies c ON c.id = a.company_id
    WHERE a.created_at > NOW() - INTERVAL '14 days'
      AND a.company_id IS NOT NULL
    GROUP BY a.gate_type, a.company_id, c.slug
    HAVING COUNT(*) >= 2
  `;

  let autoResolved = 0;
  // Gate types that can't be resolved by calling an API — skip to avoid loops
  const SKIP_AUTO_RESOLVE = ["capability_migration", "escalation", "ops_escalation", "new_company", "kill_company"];
  for (const esc of recurringEscalations) {
    if (SKIP_AUTO_RESOLVE.includes(esc.gate_type as string)) continue;
    const description = (esc.latest_description as string) || "";
    const capability = findCapabilityForProblem(description);

    if (capability) {
      // Auto-resolve: call the matching endpoint directly
      try {
        const resolveUrl = `${baseUrl}${capability.endpoint.replace("{id}", esc.company_id as string)}`;
        const resolveBody: Record<string, string> = {};
        if (capability.params.company_slug) resolveBody.company_slug = esc.slug as string;

        const res = await fetch(resolveUrl, {
          method: capability.method === "GET" ? "GET" : "POST",
          headers: {
            Authorization: `Bearer ${cronSecret}`,
            "Content-Type": "application/json",
          },
          ...(capability.method !== "GET" && Object.keys(resolveBody).length > 0
            ? { body: JSON.stringify(resolveBody) }
            : {}),
          signal: AbortSignal.timeout(30000),
        });

        await sql`
          INSERT INTO agent_actions (company_id, agent, action_type, description, status, output, started_at, finished_at)
          VALUES (
            ${esc.company_id}, 'sentinel', 'auto_resolve_escalation',
            ${`Auto-resolved recurring ${esc.gate_type} for ${esc.slug} via ${capability.id} (${esc.occurrences}x in 14d)`},
            ${res.ok ? 'success' : 'failed'},
            ${JSON.stringify({ capability: capability.id, endpoint: capability.endpoint, occurrences: esc.occurrences, http_status: res.status })}::jsonb,
            NOW(), NOW()
          )
        `;

        if (res.ok) autoResolved++;
        dispatches.push({
          type: "internal",
          target: "auto_resolve_escalation",
          payload: { company: esc.slug, gate_type: esc.gate_type, capability: capability.id, resolved: res.ok },
        });
      } catch (e: any) {
        console.warn(`Auto-resolve failed for ${esc.slug}/${esc.gate_type}: ${e.message}`);
      }
    } else {
      // No matching capability — suggest automation via evolver_proposals
      // Only create if one doesn't already exist for this pattern
      const [existing] = await sql`
        SELECT id FROM evolver_proposals
        WHERE title ILIKE ${"%" + esc.gate_type + "%" + esc.slug + "%"}
          AND status IN ('pending', 'approved')
        LIMIT 1
      `;
      if (!existing) {
        await sql`
          INSERT INTO evolver_proposals (gap_type, severity, title, diagnosis, signal_source, proposed_fix, affected_companies, status)
          VALUES (
            'process',
            'medium',
            ${`Recurring escalation needs automation: ${esc.gate_type} for ${esc.slug}`},
            ${`The same ${esc.gate_type} approval has appeared ${esc.occurrences} times in 14 days for ${esc.slug}. Latest: ${description.slice(0, 200)}`},
            'sentinel_recurring_escalation',
            ${JSON.stringify({ action: `Create automated resolution for ${esc.gate_type} escalations`, suggestion: "Add a new trigger to the Hive capability registry or a dedicated fix endpoint" })}::jsonb,
            ${[esc.slug as string]},
            'pending'
          )
        `;
        dispatches.push({
          type: "evolver_proposal",
          target: "recurring_escalation",
          payload: { company: esc.slug, gate_type: esc.gate_type, occurrences: esc.occurrences },
        });
      }
    }
  }

  // 26. Auto-dismiss resolved escalations — check if underlying conditions are fixed
  // Find all pending escalations and check if their root cause is resolved
  const pendingEscalations = await sql`
    SELECT a.id, a.company_id, a.title, a.description, a.context, a.created_at, c.slug
    FROM approvals a
    LEFT JOIN companies c ON c.id = a.company_id
    WHERE a.gate_type = 'escalation'
      AND a.status = 'pending'
      AND a.created_at > NOW() - INTERVAL '7 days'
  `;

  let autoDismissed = 0;
  for (const esc of pendingEscalations) {
    const title = esc.title as string;
    const context = esc.context as any;
    let shouldDismiss = false;
    let dismissReason = "";

    try {
      // 1. Dispatch loop escalations: check if agent hasn't fired excessively recently
      if (title.includes("Dispatch loop:") && context?.agent && context?.company) {
        const [recentLoops] = await sql`
          SELECT COUNT(*) as cnt
          FROM agent_actions
          WHERE agent = ${context.agent}
            AND company_id = ${esc.company_id}
            AND started_at > NOW() - INTERVAL '30 minutes'
        `;
        const recentCount = parseInt(recentLoops.cnt as string);
        if (recentCount < 3) {  // Normal dispatch rate, loop resolved
          shouldDismiss = true;
          dismissReason = `Dispatch loop resolved: ${context.agent} only fired ${recentCount}x in last 30min (below threshold)`;
        }
      }

      // 2. Stalled company escalations: check if there has been recent agent activity
      else if (title.includes("Stalled:") && title.includes("no activity in 72h")) {
        const [recentActivity] = await sql`
          SELECT MAX(started_at) as last_activity
          FROM agent_actions
          WHERE company_id = ${esc.company_id}
            AND started_at > NOW() - INTERVAL '48 hours'
            AND status = 'success'
        `;
        if (recentActivity.last_activity) {
          shouldDismiss = true;
          dismissReason = `Company no longer stalled: recent successful activity at ${recentActivity.last_activity}`;
        }
      }

      // 3. Agent performance escalations: check if success rate improved above 30%
      else if (title.includes("Agent critically underperforming") && title.includes("success rate")) {
        const agentMatch = title.match(/Agent critically underperforming: (\w+)/);
        if (agentMatch) {
          const agent = agentMatch[1];
          const [recent] = await sql`
            SELECT
              COUNT(*) as total,
              COUNT(*) FILTER (WHERE status = 'success') as successes
            FROM agent_actions
            WHERE agent = ${agent}
              AND started_at > NOW() - INTERVAL '7 days'
          `;
          const total = parseInt(recent.total as string);
          const successes = parseInt(recent.successes as string);
          const successRate = total > 0 ? successes / total : 0;

          if (successRate >= 0.4) {  // Above 40% (well above 30% threshold)
            shouldDismiss = true;
            dismissReason = `Agent performance recovered: ${agent} now at ${Math.round(successRate * 100)}% success rate (${successes}/${total} in 7d)`;
          }
        }
      }

      // Auto-dismiss if condition is resolved
      if (shouldDismiss) {
        await sql`
          UPDATE approvals
          SET status = 'expired',
              decided_at = NOW(),
              decision_note = ${'Auto-dismissed by Sentinel: ' + dismissReason}
          WHERE id = ${esc.id}
        `;

        await sql`
          INSERT INTO agent_actions (agent, company_id, action_type, description, status, output, started_at, finished_at)
          VALUES (
            'sentinel', ${esc.company_id}, 'auto_dismiss_escalation',
            ${`Auto-dismissed resolved escalation: ${title}`},
            'success',
            ${JSON.stringify({ escalation_id: esc.id, reason: dismissReason, age_hours: Math.round((Date.now() - new Date(esc.created_at as string).getTime()) / (1000 * 60 * 60)) })}::jsonb,
            NOW(), NOW()
          )
        `;

        autoDismissed++;
        dispatches.push({
          type: "internal",
          target: "auto_dismiss_escalation",
          payload: { escalation_id: esc.id, company: esc.slug, title, reason: dismissReason }
        });
      }
    } catch (e: any) {
      console.warn(`Auto-dismiss check failed for escalation ${esc.id}: ${e.message}`);
    }
  }

  // --- Dispatch logic ---

  // 1. Pipeline low → Scout (if not blocked by proposal backlog)
  if (pipelineLow) {
    await dispatchToActions("pipeline_low", { source: "sentinel", trace_id: traceId }, ghPat);
    dispatches.push({ type: "brain", target: "pipeline_low", payload: { source: "sentinel" } });
  } else if (scoutBlocked) {
    console.log(`[sentinel] Scout blocked: ${pendingProposals.cnt} pending, ${staleProposals.cnt} stale proposals`);
  }

  // 2. Stale content → Growth on company repo (free Actions) with Vercel fallback
  for (let i = 0; i < staleContent.length; i++) {
    const r = staleContent[i];
    // Circuit breaker: skip if growth has 3+ failures for this company in 24h
    const [staleCompany] = await sql`SELECT id FROM companies WHERE slug = ${r.slug} LIMIT 1`;
    if (staleCompany && await isCircuitOpen(sql, "growth", staleCompany.id as string)) {
      await sql`
        INSERT INTO agent_actions (agent, company_id, action_type, status, description, started_at, finished_at)
        VALUES ('growth', ${staleCompany.id}, 'circuit_breaker', 'success',
          ${"Circuit breaker open: skipping growth for " + r.slug + " (3+ failures in 24h)"},
          NOW(), NOW())
      `;
      circuitBreaks++;
      dispatches.push({ type: "circuit_breaker", target: "growth", payload: { company: r.slug, reason: "3+_failures_24h" } });
      continue;
    }
    if (r.github_repo) {
      try {
        await dispatchToCompanyWorkflow(r.github_repo, "hive-growth.yml", {
          company_slug: r.slug,
          trigger: "sentinel_stale_content",
          task_summary: `Content refresh for ${r.slug}`,
        }, ghPat);
        dispatches.push({ type: "company_actions", target: "growth", payload: { company: r.slug, repo: r.github_repo } });
        continue;
      } catch {
        // Fall through to Vercel serverless
      }
    }
    await dispatchToWorker("growth", r.slug, "sentinel_stale_content");
    dispatches.push({ type: "worker", target: "growth", payload: { company: r.slug } });

    // Add 1-second stagger between Growth dispatches to avoid API rate limits
    if (i < staleContent.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  // 3. Stale leads → Outreach worker
  for (let i = 0; i < staleLeads.length; i++) {
    const r = staleLeads[i];
    await dispatchToWorker("outreach", r.slug, "sentinel_stale_leads");
    dispatches.push({ type: "worker", target: "outreach", payload: { company: r.slug } });

    // Add 1-second stagger between Outreach dispatches to avoid API rate limits
    if (i < staleLeads.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  // 4. No CEO review → CEO brain
  if (noCeoReview.length > 0) {
    const slug = noCeoReview[0].slug;
    await dispatchToActions("ceo_review", { source: "sentinel", company: slug, trace_id: traceId }, ghPat);
    dispatches.push({ type: "brain", target: "ceo_review", payload: { company: slug } });
  }

  // 5. Unverified deploys → Ops worker (staggered to avoid Groq rate limits)
  for (let i = 0; i < unverifiedDeploys.length; i++) {
    const r = unverifiedDeploys[i];
    await dispatchToWorker("ops", r.slug, "sentinel_unverified_deploy");
    dispatches.push({ type: "worker", target: "health_check", payload: { company: r.slug } });

    // Add 2-second stagger between concurrent Ops dispatches to avoid Groq 429s
    if (i < unverifiedDeploys.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  // 6. Evolve due → Evolver brain
  if (evolveDue) {
    await dispatchToActions("evolve_trigger", { source: "sentinel", trace_id: traceId }, ghPat);
    dispatches.push({ type: "brain", target: "evolve_trigger", payload: { source: "sentinel" } });
  }

  // 7. High failure rate → Evolver brain (urgent) + Healer (fix code)
  // Guard: check Healer hasn't run in last 6h (prevents re-dispatch loop when Healer itself fails)
  if (highFailureRate) {
    await dispatchToActions("evolve_trigger", { source: "sentinel", reason: "high_failure_rate", trace_id: traceId }, ghPat);
    dispatches.push({ type: "brain", target: "evolve_trigger", payload: { reason: "high_failure_rate" } });

    const [lastHealerRun] = await sql`
      SELECT MAX(started_at) as last_run FROM agent_actions
      WHERE agent = 'healer' AND started_at > NOW() - INTERVAL '6 hours'
    `;
    if (!lastHealerRun?.last_run) {
      await dispatchToActions("healer_trigger", { source: "sentinel", scope: "systemic", reason: "high_failure_rate", trace_id: traceId }, ghPat);
      dispatches.push({ type: "brain", target: "healer_trigger", payload: { reason: "high_failure_rate" } });
    }
  }

  // 7b. Errors exist but below 20% threshold → Healer only (no Evolver)
  if (!highFailureRate && parseInt(failureStats.failed) >= 3) {
    // Check that Healer hasn't already run in last 24h
    const [lastHeal] = await sql`
      SELECT MAX(finished_at) as last_run FROM agent_actions
      WHERE agent = 'healer' AND finished_at > NOW() - INTERVAL '24 hours'
    `;
    if (!lastHeal?.last_run) {
      await dispatchToActions("healer_trigger", { source: "sentinel", scope: "systemic", reason: "errors_detected", trace_id: traceId }, ghPat);
      dispatches.push({ type: "brain", target: "healer_trigger", payload: { reason: "errors_detected" } });
    }
  }

  // 8. Stale research → Scout research refresh
  if (staleResearch.length > 0) {
    const slug = staleResearch[0].slug;
    await dispatchToActions("research_request", { source: "sentinel", company: slug, trace_id: traceId }, ghPat);
    dispatches.push({ type: "brain", target: "research_request", payload: { company: slug } });
  }

  // 9. Stuck approved → provision via Engineer
  for (const r of stuckApproved) {
    await dispatchToActions("new_company", { source: "sentinel", company: r.slug, trace_id: traceId }, ghPat);
    dispatches.push({ type: "brain", target: "new_company", payload: { company: r.slug } });
  }

  // 9b. Orphaned MVPs → re-provision
  for (const r of orphanedMvps) {
    await dispatchToActions("new_company", { source: "sentinel", company: r.slug, reason: "orphaned_mvp", trace_id: traceId }, ghPat);
    dispatches.push({ type: "brain", target: "new_company", payload: { company: r.slug, reason: "orphaned_mvp" } });
  }

  // 9c. Missing Neon DB → auto-repair infrastructure (no manual steps needed)
  for (const r of missingNeonDb) {
    try {
      const repairRes = await fetch(`${baseUrl}/api/agents/repair-infra`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cronSecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ company_slug: r.slug }),
        signal: AbortSignal.timeout(30000),
      });
      const repairData = await repairRes.json();
      dispatches.push({ type: "internal", target: "infra_repair", payload: { company: r.slug, result: repairData } });
    } catch (e: any) {
      console.error(`Infra repair failed for ${r.slug}: ${e.message}`);
    }
  }

  // 13c-pre. Backfill NULL errors from GitHub Actions API before retrying
  for (const r of failedWithPlanWork) {
    if (!r.error && r.github_repo && ghPat) {
      try {
        const runsRes = await fetch(
          `https://api.github.com/repos/${r.github_repo}/actions/runs?per_page=5&status=failure`,
          { headers: { Authorization: `token ${ghPat}`, Accept: "application/vnd.github.v3+json" }, signal: AbortSignal.timeout(10000) }
        );
        if (runsRes.ok) {
          const runs = await runsRes.json();
          const latestFail = runs.workflow_runs?.[0];
          if (latestFail) {
            await sql`
              UPDATE agent_actions SET error = ${`GitHub Actions: ${latestFail.conclusion} — ${latestFail.name} (run ${latestFail.id})`}
              WHERE id = ${r.action_id} AND error IS NULL
            `;
          }
        }
      } catch { /* non-blocking */ }
    }
  }

  // 13c. Failed agent tasks → re-dispatch directly to company repo (free Actions)
  for (const r of failedWithPlanWork) {
    // Circuit breaker: skip if 3+ failures for this agent+company in 24h
    if (await isCircuitOpen(sql, r.agent as string, r.company_id as string)) {
      await sql`
        INSERT INTO agent_actions (agent, company_id, action_type, status, description, started_at, finished_at)
        VALUES (${r.agent}, ${r.company_id}, 'circuit_breaker', 'success',
          ${"Circuit breaker open: skipping " + r.agent + " retry for " + r.slug + " (3+ failures in 24h)"},
          NOW(), NOW())
      `;
      circuitBreaks++;
      dispatches.push({ type: "circuit_breaker", target: r.agent as string, payload: { company: r.slug, reason: "3+_failures_24h" } });
      continue;
    }
    if (r.github_repo && r.agent === "engineer") {
      await dispatchToCompanyWorkflow(r.github_repo as string, "hive-build.yml", {
        company_slug: r.slug as string,
        trigger: "feature_request",
        task_summary: "Retry — previous build failed",
      }, ghPat);
      dispatches.push({ type: "company_actions", target: "feature_request", payload: { company: r.slug, reason: "failed_task_recovery" } });
    } else if (r.github_repo && r.agent === "growth") {
      await dispatchToCompanyWorkflow(r.github_repo as string, "hive-growth.yml", {
        company_slug: r.slug as string,
        trigger: "sentinel_retry",
        task_summary: "Retry — previous growth run failed",
      }, ghPat);
      dispatches.push({ type: "company_actions", target: "growth", payload: { company: r.slug, reason: "failed_task_recovery" } });
    } else {
      // Fallback to Hive repo dispatch if no company repo
      const eventType = r.agent === "engineer" ? "feature_request" : "growth_trigger";
      await dispatchToActions(eventType, {
        source: "sentinel_retry",
        company: r.slug,
        company_id: r.company_id,
        reason: "failed_task_recovery",
        trace_id: traceId,
      }, ghPat);
      dispatches.push({ type: "brain", target: eventType, payload: { company: r.slug, reason: "failed_task_recovery" } });
    }
    // Log the retry so we don't re-dispatch again for 6h
    await sql`
      INSERT INTO agent_actions (agent, company_id, action_type, status, description, started_at, finished_at)
      VALUES (${r.agent}, ${r.company_id}, 'sentinel_retry', 'success',
        ${"Sentinel re-dispatched " + r.agent + " for " + r.slug + " after failed task (plan work preserved in cycles table)"},
        NOW(), NOW())
    `;
  }

  // 10. Max turns exhaustion → Evolver
  if (maxTurnsHits.length > 0) {
    const agents = maxTurnsHits.map((r) => ({
      agent: r.agent as string,
      count: parseInt(r.cnt as string),
    }));
    await dispatchToActions("evolve_trigger", { source: "sentinel", reason: "max_turns_exhaustion", agents, trace_id: traceId }, ghPat);
    dispatches.push({ type: "brain", target: "evolve_trigger", payload: { reason: "max_turns_exhaustion", agents } });
  }

  // 11. Chain dispatch gaps → dispatch directly to company repo (free Actions)
  for (const r of chainGaps) {
    // Circuit breaker: skip if engineer has 3+ failures for this company in 24h
    const [gapCompany] = await sql`SELECT id FROM companies WHERE slug = ${r.slug} LIMIT 1`;
    if (gapCompany && await isCircuitOpen(sql, "engineer", gapCompany.id as string)) {
      await sql`
        INSERT INTO agent_actions (agent, company_id, action_type, status, description, started_at, finished_at)
        VALUES ('engineer', ${gapCompany.id}, 'circuit_breaker', 'success',
          ${"Circuit breaker open: skipping engineer chain gap recovery for " + r.slug + " (3+ failures in 24h)"},
          NOW(), NOW())
      `;
      circuitBreaks++;
      dispatches.push({ type: "circuit_breaker", target: "engineer", payload: { company: r.slug, reason: "3+_failures_24h" } });
      continue;
    }
    if (r.github_repo) {
      await dispatchToCompanyWorkflow(r.github_repo as string, "hive-build.yml", {
        company_slug: r.slug as string,
        trigger: "feature_request",
        task_summary: "Chain gap recovery — CEO planned features not yet built",
      }, ghPat);
      dispatches.push({ type: "company_actions", target: "feature_request", payload: { company: r.slug, repo: r.github_repo } });
    } else {
      await dispatchToActions("feature_request", { source: "sentinel_recovery", company: r.slug, trace_id: traceId }, ghPat);
      dispatches.push({ type: "brain", target: "feature_request", payload: { company: r.slug } });
    }
  }

  // 12. Stalled companies → escalation approval + force cycle
  for (const r of stalledCompanies) {
    await sql`
      INSERT INTO approvals (company_id, gate_type, title, description, context)
      VALUES (
        ${r.company_id}, 'escalation',
        ${"Stalled: " + r.slug + " — no activity in 72h"},
        'Company has infrastructure but no agent has run successfully in 72+ hours. The dispatch chain may be broken.',
        ${JSON.stringify({ last_activity: r.last_activity, detected_by: "sentinel" })}::jsonb
      )
      ON CONFLICT DO NOTHING
    `;
    await dispatchToActions("research_request", {
      source: "sentinel_stalled",
      company: r.slug,
      company_id: r.company_id,
      trace_id: traceId,
    }, ghPat);
    dispatches.push({ type: "brain", target: "research_request", payload: { company: r.slug, reason: "stalled" } });
  }

  // 13. Budget check + Hive-first prioritization
  // Check daily Claude usage to throttle dispatches
  const dailyUsage = await sql`
    SELECT COUNT(*) as action_count,
      COALESCE(SUM(tokens_used), 0) as total_turns
    FROM agent_actions
    WHERE agent IN ('ceo', 'scout', 'engineer', 'evolver', 'healer')
    AND started_at > NOW() - INTERVAL '5 hours'
  `;
  const turnsUsed = Number(dailyUsage[0]?.total_turns || 0);
  const budgetCeiling = 225; // Claude Max 5x ~225 messages per 5h window
  const budgetUsedPct = turnsUsed / budgetCeiling;

  // Throttle: >90% budget → skip all, >70% → max 1, otherwise max 2
  let remainingSlots = budgetUsedPct > 0.9 ? 0 : budgetUsedPct > 0.7 ? 1 : MAX_CYCLE_DISPATCHES;

  // 13a. HIVE-FIRST TRIAGE — fix Hive's own issues before running company cycles
  // Rationale: if Hive itself is broken (systemic errors, broken pipelines),
  // running company cycles wastes budget on work that will fail anyway.
  let hiveFixesDispatched = 0;
  try {
    // (A0) Auto-approve critical proposals pending >24h — these are blocking the system
    await sql`
      UPDATE evolver_proposals
      SET status = 'approved', decided_at = NOW(), notes = 'Auto-approved: critical severity pending >24h'
      WHERE status = 'pending'
        AND severity = 'critical'
        AND created_at < NOW() - INTERVAL '24 hours'
        AND created_at > NOW() - INTERVAL '14 days'
    `.catch(() => {});

    // (A) Approved self-improvement proposals waiting for dispatch (any source)
    const approvedImprovements = await sql`
      SELECT id, title, proposed_fix, severity
      FROM evolver_proposals
      WHERE status = 'approved'
        AND implemented_at IS NULL
        AND created_at > NOW() - INTERVAL '14 days'
      ORDER BY
        CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        created_at ASC
      LIMIT 2
    `.catch(() => []);

    // (B) Systemic errors — same error in 2+ companies in last 48h, no fix dispatched yet
    const systemicErrors = await sql`
      SELECT error, agent, COUNT(DISTINCT company_id)::int as affected_companies,
        COUNT(*)::int as occurrences
      FROM agent_actions
      WHERE status = 'failed' AND error IS NOT NULL
        AND finished_at > NOW() - INTERVAL '48 hours'
        AND company_id IS NOT NULL
      GROUP BY error, agent
      HAVING COUNT(DISTINCT company_id) >= 2
      ORDER BY COUNT(*) DESC
      LIMIT 3
    `.catch(() => []);

    // (C) Agent failure rate — if >50% of all agent runs are failing, Hive needs fixing
    const failureRate = await sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'failed')::float /
        NULLIF(COUNT(*), 0)::float as rate
      FROM agent_actions
      WHERE agent NOT IN ('sentinel', 'healer')
        AND finished_at > NOW() - INTERVAL '48 hours'
    `.catch(() => [{ rate: 0 }]);
    const overallFailureRate = Number(failureRate[0]?.rate || 0);

    // Dispatch Hive fixes if there are approved proposals or critical systemic issues
    const hiveFixNeeded = approvedImprovements.length > 0
      || (systemicErrors.length > 0 && overallFailureRate > 0.4);

    if (hiveFixNeeded && remainingSlots > 0) {
      // Prioritize approved improvement proposals first
      for (const proposal of approvedImprovements) {
        if (remainingSlots <= 0) break;
        await dispatchToActions("feature_request", {
          source: "sentinel_hive_triage",
          company: "_hive",
          task: proposal.proposed_fix,
          proposal_id: proposal.id,
          severity: proposal.severity,
          trace_id: traceId,
        }, ghPat);
        dispatches.push({
          type: "brain",
          target: "hive_self_fix",
          payload: { proposal_id: proposal.id, title: proposal.title, severity: proposal.severity },
        });
        hiveFixesDispatched++;
        remainingSlots--;
      }

      // If high systemic failure rate and still have budget, dispatch healer
      if (systemicErrors.length > 0 && overallFailureRate > 0.4 && remainingSlots > 0) {
        const errorSummary = systemicErrors
          .map((e) => `${e.agent}: "${(e.error as string).slice(0, 80)}" (${e.affected_companies} companies, ${e.occurrences}x)`)
          .join("; ");
        await dispatchToActions("healer_trigger", {
          source: "sentinel_hive_triage",
          scope: "systemic",
          reason: `Systemic failures (${Math.round(overallFailureRate * 100)}% failure rate): ${errorSummary.slice(0, 500)}`,
          trace_id: traceId,
        }, ghPat);
        dispatches.push({
          type: "brain",
          target: "healer_systemic",
          payload: { failure_rate: overallFailureRate, systemic_errors: systemicErrors.length },
        });
        hiveFixesDispatched++;
        remainingSlots--;
      }

      if (hiveFixesDispatched > 0) {
        await sql`
          INSERT INTO agent_actions (agent, action_type, description, status, started_at, finished_at)
          VALUES ('sentinel', 'hive_triage', ${`Hive-first: dispatched ${hiveFixesDispatched} fix(es) before company cycles. Failure rate: ${Math.round(overallFailureRate * 100)}%, approved proposals: ${approvedImprovements.length}, systemic errors: ${systemicErrors.length}`}, 'success', NOW(), NOW())
        `.catch(() => {});
      }
    }
  } catch (e: unknown) {
    console.warn("Check 13a (hive-first triage) failed:", e instanceof Error ? e.message : String(e));
  }

  // 13b. Scored backlog dispatch — pick highest-scoring Hive improvement if budget allows
  // Backlog items compete with company cycles for remaining slots.
  // P0/P1 items auto-dispatch. P2/P3 dispatch only when no company cycles are pending.
  let backlogDispatched = 0;
  try {
    if (remainingSlots > 0) {
      const { computeBacklogScore, detectBlockedAgents } = await import("@/lib/backlog-priority");

      // Fetch ready + approved backlog items
      const backlogItems = await sql`
        SELECT * FROM hive_backlog
        WHERE status IN ('ready', 'approved')
        ORDER BY
          CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,
          created_at ASC
        LIMIT 10
      `.catch(() => []);

      if (backlogItems.length > 0) {
        // Gather signals for scoring
        const activeCompanyCount = await sql`
          SELECT COUNT(*)::int as count FROM companies WHERE status IN ('mvp', 'active')
        `.catch(() => [{ count: 4 }]);
        const totalCompanies = Number(activeCompanyCount[0]?.count || 4);

        const backlogFailureRate = await sql`
          SELECT COUNT(*) FILTER (WHERE status = 'failed')::float /
            NULLIF(COUNT(*), 0)::float as rate
          FROM agent_actions
          WHERE agent NOT IN ('sentinel', 'healer')
          AND finished_at > NOW() - INTERVAL '48 hours'
        `.catch(() => [{ rate: 0 }]);
        const overallRate = Number(backlogFailureRate[0]?.rate || 0);

        // Score each item
        const scored = [];
        for (const item of backlogItems) {
          const titleDesc = `${item.title} ${item.description}`;
          // Count related errors (keyword match in last 7 days)
          const keywords = item.title.split(/\s+/).filter((w: string) => w.length > 4).slice(0, 3);
          let relatedErrors = 0;
          if (keywords.length > 0) {
            const pattern = keywords.join("|");
            const [errCount] = await sql`
              SELECT COUNT(*)::int as count FROM agent_actions
              WHERE status = 'failed' AND error IS NOT NULL
              AND finished_at > NOW() - INTERVAL '7 days'
              AND error ~* ${pattern}
            `.catch(() => [{ count: 0 }]);
            relatedErrors = Number(errCount?.count || 0);
          }

          // Check if similar item was attempted and failed
          const [failedSimilar] = await sql`
            SELECT id FROM hive_backlog
            WHERE status IN ('blocked', 'rejected')
            AND title ILIKE ${item.title.slice(0, 40) + "%"}
            AND completed_at > NOW() - INTERVAL '30 days'
            LIMIT 1
          `.catch(() => []);

          // Count affected companies
          let companiesAffected = 0;
          if (keywords.length > 0) {
            const pattern = keywords.join("|");
            const [compCount] = await sql`
              SELECT COUNT(DISTINCT company_id)::int as count FROM agent_actions
              WHERE status = 'failed' AND error ~* ${pattern}
              AND finished_at > NOW() - INTERVAL '7 days'
              AND company_id IS NOT NULL
            `.catch(() => [{ count: 0 }]);
            companiesAffected = Number(compCount?.count || 0);
          }

          const blocksAgents = detectBlockedAgents(item.title, item.description);
          const daysSinceCreated = Math.max(0, (Date.now() - new Date(item.created_at).getTime()) / 86400000);
          const previousAttempts = (item.notes || "").match(/\[attempt \d+\]/g)?.length || 0;

          scored.push(computeBacklogScore(item as Parameters<typeof computeBacklogScore>[0], {
            relatedErrors,
            companiesAffected,
            systemFailureRate: overallRate,
            hasSimilarFailed: !!failedSimilar,
            blocksAgents,
            daysSinceCreated,
            totalCompanies,
            previousAttempts,
          }));
        }

        // Sort by score descending
        scored.sort((a, b) => b.priority_score - a.priority_score);
        const top = scored[0];

        // Dispatch rules:
        // P0/P1: always dispatch (they beat company cycles)
        // P2/P3: only dispatch if no company cycles are pending (idle capacity)
        const shouldDispatch = top && (
          (top.priority === "P0" || top.priority === "P1") ||
          (needsCycle.length === 0)
        );

        if (shouldDispatch && top && remainingSlots > 0) {
          await dispatchToActions("feature_request", {
            source: "sentinel_backlog",
            company: "_hive",
            task: top.description,
            backlog_id: top.id,
            priority: top.priority,
            priority_score: top.priority_score,
            score_breakdown: top.score_breakdown,
            trace_id: traceId,
          }, ghPat);

          // Mark as dispatched
          await sql`
            UPDATE hive_backlog
            SET status = 'dispatched', dispatched_at = NOW()
            WHERE id = ${top.id}
          `.catch(() => {});

          dispatches.push({
            type: "brain",
            target: "hive_backlog_item",
            payload: {
              backlog_id: top.id,
              title: top.title,
              priority: top.priority,
              priority_score: top.priority_score,
              score_breakdown: top.score_breakdown,
            },
          });
          backlogDispatched++;
          remainingSlots--;
        }
      }
    }
  } catch (e: unknown) {
    console.warn("Check 13b (backlog dispatch) failed:", e instanceof Error ? e.message : String(e));
  }

  // 13c. Company cycle dispatch — remaining budget after Hive fixes + backlog
  for (const r of needsCycle) {
    if (cycleDispatches >= remainingSlots) break;
    await dispatchToActions("research_request", {
      source: "sentinel_cycle",
      company: r.slug,
      company_id: r.company_id,
      chain_to_ceo: true,
      trace_id: traceId,
    }, ghPat);
    dispatches.push({
      type: "brain",
      target: "cycle_start",
      payload: { company: r.slug, priority_score: r.priority_score },
    });
    cycleDispatches++;
  }

  // 14. Rate-limited agents → re-dispatch (company-scoped work goes direct to company repo)
  for (const r of rateLimited) {
    // Circuit breaker: skip if this agent+company has 3+ failures in 24h
    if (await isCircuitOpen(sql, r.agent as string, r.company_id as string)) {
      await sql`
        INSERT INTO agent_actions (agent, company_id, action_type, status, description, started_at, finished_at)
        VALUES (${r.agent}, ${r.company_id}, 'circuit_breaker', 'success',
          ${"Circuit breaker open: skipping " + r.agent + " rate-limit retry for " + r.slug + " (3+ failures in 24h)"},
          NOW(), NOW())
      `;
      circuitBreaks++;
      dispatches.push({ type: "circuit_breaker", target: r.agent as string, payload: { company: r.slug, reason: "3+_failures_24h" } });
      continue;
    }
    let eventType = "feature_request";
    if (r.agent === "engineer" && ["scaffold_company", "provision_company"].includes(r.action_type as string)) {
      eventType = "new_company";
    } else if (r.agent === "scout") {
      eventType = "research_request";
    } else if (r.agent === "ceo") {
      eventType = "cycle_start";
    }

    // Engineer feature_request/ops_escalation → direct to company repo (free Actions)
    if (r.github_repo && r.agent === "engineer" && eventType === "feature_request") {
      await dispatchToCompanyWorkflow(r.github_repo as string, "hive-build.yml", {
        company_slug: r.slug as string,
        trigger: "feature_request",
        task_summary: "Retry — previous run was rate-limited",
      }, ghPat);
      dispatches.push({ type: "company_actions", target: "feature_request", payload: { company: r.slug, reason: "rate_limited_retry" } });
    } else {
      // Brain agents (CEO, Scout, provision) must stay on Hive repo
      await dispatchToActions(eventType, {
        source: "sentinel_retry",
        company: r.slug,
        company_id: r.company_id,
        trace_id: traceId,
      }, ghPat);
      dispatches.push({ type: "brain", target: eventType, payload: { company: r.slug, reason: "rate_limited_retry" } });
    }
  }

  // 15. Unverified provisions → HTTP check
  for (const r of unverifiedProvisions) {
    if (r.vercel_url) {
      try {
        const res = await fetch(r.vercel_url as string, {
          redirect: "follow",
          signal: AbortSignal.timeout(10000),
        });
        if (res.status >= 400) {
          // Dispatch fix directly to company repo if available
          const [co] = await sql`SELECT github_repo FROM companies WHERE slug = ${r.slug} LIMIT 1`;
          if (co?.github_repo) {
            await dispatchToCompanyWorkflow(co.github_repo as string, "hive-fix.yml", {
              company_slug: r.slug as string,
              error_summary: `Deploy broken after provision (HTTP ${res.status})`,
              source: "sentinel",
            }, ghPat);
            dispatches.push({ type: "company_actions", target: "ops_escalation", payload: { company: r.slug, status: res.status } });
          } else {
            await dispatchToActions("ops_escalation", {
              source: "sentinel",
              company: r.slug,
              reason: "post_provision_deploy_broken",
              http_status: res.status,
              trace_id: traceId,
            }, ghPat);
            dispatches.push({ type: "brain", target: "ops_escalation", payload: { company: r.slug, status: res.status } });
          }
        }
      } catch {
        await dispatchToActions("ops_escalation", {
          source: "sentinel",
          company: r.slug,
          reason: "post_provision_deploy_broken",
          http_status: 0,
          trace_id: traceId,
        }, ghPat);
        dispatches.push({ type: "brain", target: "ops_escalation", payload: { company: r.slug, status: 0 } });
      }
    } else {
      await dispatchToActions("new_company", {
        source: "sentinel",
        company: r.slug,
        company_id: r.company_id,
        reason: "missing_url",
        trace_id: traceId,
      }, ghPat);
      dispatches.push({ type: "brain", target: "new_company", payload: { company: r.slug, reason: "missing_url" } });
    }
  }

  // 16. Missing metrics → trigger metrics cron
  if (missingMetrics.length > 0) {
    const cronSecret = process.env.CRON_SECRET;
    const baseUrl = process.env.NEXT_PUBLIC_URL || "https://hive-phi.vercel.app";
    try {
      await fetch(`${baseUrl}/api/cron/metrics`, {
        headers: { Authorization: `Bearer ${cronSecret}` },
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      // best-effort
    }
    dispatches.push({
      type: "internal",
      target: "metrics_cron",
      payload: { companies: missingMetrics.map((r) => r.slug as string) },
    });
  }

  // 31. Stats endpoint health — probe /api/stats on each company, create fix tasks for broken ones
  let statsEndpointsBroken = 0;
  const statsCompanies = await sql`
    SELECT c.id, c.slug, COALESCE('https://' || c.domain, c.vercel_url) as app_url, c.github_repo
    FROM companies c
    WHERE c.status IN ('mvp', 'active') AND c.vercel_url IS NOT NULL
  `;
  for (const sc of statsCompanies) {
    if (!sc.app_url) continue;
    const statsUrl = `${sc.app_url}/api/stats`;
    try {
      const res = await fetch(statsUrl, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data.ok || typeof data.views !== "number") {
        throw new Error("Invalid response format: missing ok/views fields");
      }
      // Stats endpoint is healthy — no action needed
    } catch (e: any) {
      statsEndpointsBroken++;
      // Check if we already have a pending fix task for this
      const [existingTask] = await sql`
        SELECT id FROM company_tasks
        WHERE company_id = ${sc.id} AND title LIKE '%stats endpoint%'
        AND status IN ('proposed', 'in_progress')
        LIMIT 1
      `;
      if (!existingTask) {
        // Create an engineering task to fix the stats endpoint
        await sql`
          INSERT INTO company_tasks (company_id, title, description, category, priority, status)
          VALUES (
            ${sc.id},
            'Fix /api/stats endpoint for metrics collection',
            ${`The /api/stats endpoint at ${statsUrl} is broken (${e.message}). This endpoint must return JSON: { ok: true, views: number, pricing_clicks: number, affiliate_clicks: number }. Copy the boilerplate from templates/boilerplate/src/app/api/stats/route.ts. Ensure the page_views, pricing_clicks, and affiliate_clicks tables exist in the company DB. Also ensure middleware.ts tracks pageviews by POSTing to /api/stats on each page navigation.`},
            'engineering', 2, 'proposed'
          )
        `;
        dispatches.push({
          type: "internal",
          target: "stats_endpoint_fix",
          payload: { company: sc.slug, error: e.message, task_created: true },
        });
      }
    }
  }

  // 32. Language consistency check — verify deployed site language matches content_language
  let languageMismatches = 0;
  const langCompanies = await sql`
    SELECT c.id, c.slug, c.content_language, COALESCE('https://' || c.domain, c.vercel_url) as app_url
    FROM companies c
    WHERE c.status IN ('mvp', 'active') AND c.vercel_url IS NOT NULL AND c.content_language IS NOT NULL
  `;
  for (const lc of langCompanies) {
    if (!lc.app_url) continue;
    try {
      const res = await fetch(lc.app_url as string, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const html = await res.text();
      const htmlLang = html.match(/<html[^>]*lang="([^"]+)"/)?.[1] || "";
      const expectedLang = lc.content_language as string;

      // Check html lang attribute
      const langMismatch = htmlLang && !htmlLang.startsWith(expectedLang);

      // Simple heuristic: check for common wrong-language patterns
      const isExpectedPt = expectedLang === "pt";
      const hasEnglishPatterns = /\b(Get started|Learn more|Sign up|Features|How it works|Ready to get started)\b/i.test(html);
      const hasPortuguesePatterns = /\b(Começar|Saber mais|Funcionalidades|Como funciona|Pronto para começar)\b/i.test(html);

      const contentMismatch = isExpectedPt ? hasEnglishPatterns && !hasPortuguesePatterns : hasPortuguesePatterns && !hasEnglishPatterns;

      if (langMismatch || contentMismatch) {
        languageMismatches++;
        const issue = langMismatch ? `html lang="${htmlLang}" but expected "${expectedLang}"` : `content appears to be in wrong language (expected ${expectedLang})`;
        const [existingTask] = await sql`
          SELECT id FROM company_tasks
          WHERE company_id = ${lc.id} AND title LIKE '%language%consistency%'
          AND status IN ('proposed', 'in_progress')
          LIMIT 1
        `;
        if (!existingTask) {
          await sql`
            INSERT INTO company_tasks (company_id, title, description, category, priority, status)
            VALUES (${lc.id}, 'Fix language consistency — wrong content language detected',
              ${`The deployed site at ${lc.app_url} has a language issue: ${issue}. All user-facing content must be in ${isExpectedPt ? "Portuguese" : "English"}. Check: html lang attribute, page text, meta tags, button labels, headings, error messages.`},
              'engineering', 2, 'proposed')
          `;
        }
      }
    } catch {
      // Site may be down — other checks handle this
    }
  }

  // 33. Stale record reconciliation — verify DB records match actual Vercel/GitHub state
  // Detects: renamed repos, renamed Vercel projects, stale URLs after rebrand
  let staleRecordsFixed = 0;
  if (vercelToken) {
    const teamId = await getSettingValue("vercel_team_id").catch(() => null);
    const teamParam = teamId ? `?teamId=${teamId}` : "";
    const reconCompanies = await sql`
      SELECT id, slug, vercel_project_id, vercel_url, github_repo
      FROM companies WHERE status IN ('mvp', 'active') AND vercel_project_id IS NOT NULL
    `;
    for (const rc of reconCompanies) {
      try {
        // Check Vercel project — get actual name and domains
        const vRes = await fetch(`https://api.vercel.com/v9/projects/${rc.vercel_project_id}${teamParam}`, {
          headers: { Authorization: `Bearer ${vercelToken}` },
          signal: AbortSignal.timeout(5000),
        });
        if (vRes.ok) {
          const vProject = await vRes.json();
          const actualName = vProject.name;
          const actualAlias = (vProject.alias || []).find((a: string) => a.endsWith(".vercel.app"));
          const actualUrl = actualAlias ? `https://${actualAlias}` : `https://${actualName}.vercel.app`;
          const storedUrl = rc.vercel_url as string;

          if (storedUrl && actualUrl !== storedUrl && !storedUrl.includes(actualName)) {
            // DB has wrong URL — update it
            await sql`UPDATE companies SET vercel_url = ${actualUrl}, updated_at = NOW() WHERE id = ${rc.id}`;
            staleRecordsFixed++;
            await sql`
              INSERT INTO agent_actions (agent, action_type, status, company_id, output)
              VALUES ('sentinel', 'stale_record_fix', 'success', ${rc.id},
                ${JSON.stringify({ field: "vercel_url", old: storedUrl, new: actualUrl })}::jsonb)
            `;
          }
        }

        // Check GitHub repo — verify it exists at the stored path
        if (rc.github_repo && ghPat) {
          const ghRes = await fetch(`https://api.github.com/repos/${rc.github_repo}`, {
            headers: { Authorization: `Bearer ${ghPat}`, Accept: "application/vnd.github+json" },
            signal: AbortSignal.timeout(5000),
          });
          if (ghRes.status === 301 || ghRes.status === 404) {
            // Repo was renamed or deleted — try to find it by slug
            const findRes = await fetch(`https://api.github.com/repos/carloshmiranda/${rc.slug}`, {
              headers: { Authorization: `Bearer ${ghPat}`, Accept: "application/vnd.github+json" },
              signal: AbortSignal.timeout(5000),
            });
            if (findRes.ok) {
              const repoData = await findRes.json();
              const actualRepo = repoData.full_name;
              if (actualRepo !== rc.github_repo) {
                await sql`UPDATE companies SET github_repo = ${actualRepo}, updated_at = NOW() WHERE id = ${rc.id}`;
                await sql`UPDATE infra SET resource_id = ${actualRepo} WHERE resource_id = ${rc.github_repo} AND service = 'github'`;
                staleRecordsFixed++;
                await sql`
                  INSERT INTO agent_actions (agent, action_type, status, company_id, output)
                  VALUES ('sentinel', 'stale_record_fix', 'success', ${rc.id},
                    ${JSON.stringify({ field: "github_repo", old: rc.github_repo, new: actualRepo })}::jsonb)
                `;
              }
            }
          }
        }
      } catch {
        // API errors — skip this company, will retry next run
      }
    }
  }

  // 36. Test coverage health — detect companies with no tests or broken tests
  let testCoverageIssues = 0;
  const testCompanies = await sql`
    SELECT c.id, c.slug, c.github_repo, c.capabilities,
      COALESCE((SELECT COUNT(*) FROM cycles cy WHERE cy.company_id = c.id AND cy.status = 'completed'), 0)::int as total_cycles
    FROM companies c
    WHERE c.status IN ('mvp', 'active') AND c.github_repo IS NOT NULL
  `;

  for (const tc of testCompanies) {
    const repo = tc.github_repo as string;
    const companyId = tc.id as string;
    const slug = tc.slug as string;
    const totalCycles = tc.total_cycles as number;

    let hasTestDir = false;
    let hasPlaywrightConfig = false;
    let hasTestFiles = false;
    let latestTestRun: { conclusion: string | null } | null = null;

    // Check if tests/ directory exists
    try {
      const testsRes = await fetch(`https://api.github.com/repos/${repo}/contents/tests`, {
        headers: { Authorization: `token ${ghPat}`, Accept: "application/vnd.github.v3+json" },
        signal: AbortSignal.timeout(5000),
      });
      if (testsRes.ok) {
        hasTestDir = true;
        hasTestFiles = true;
      }
    } catch { /* non-blocking */ }

    // Check if playwright.config.ts exists
    try {
      const playwrightRes = await fetch(`https://api.github.com/repos/${repo}/contents/playwright.config.ts`, {
        headers: { Authorization: `token ${ghPat}`, Accept: "application/vnd.github.v3+json" },
        signal: AbortSignal.timeout(5000),
      });
      if (playwrightRes.ok) {
        hasPlaywrightConfig = true;
        hasTestFiles = true;
      }
    } catch { /* non-blocking */ }

    // Also check src/__tests__ directory
    if (!hasTestFiles) {
      try {
        const srcTestsRes = await fetch(`https://api.github.com/repos/${repo}/contents/src/__tests__`, {
          headers: { Authorization: `token ${ghPat}`, Accept: "application/vnd.github.v3+json" },
          signal: AbortSignal.timeout(5000),
        });
        if (srcTestsRes.ok) {
          hasTestFiles = true;
        }
      } catch { /* non-blocking */ }
    }

    // Check latest post-deploy.yml run (test workflow)
    if (hasTestFiles) {
      try {
        const runsRes = await fetch(
          `https://api.github.com/repos/${repo}/actions/workflows/post-deploy.yml/runs?per_page=1&status=completed`,
          {
            headers: { Authorization: `token ${ghPat}`, Accept: "application/vnd.github.v3+json" },
            signal: AbortSignal.timeout(5000),
          }
        );
        if (runsRes.ok) {
          const runsData = await runsRes.json();
          const latestRun = runsData.workflow_runs?.[0];
          if (latestRun) {
            latestTestRun = { conclusion: latestRun.conclusion };
          }
        }
      } catch { /* non-blocking */ }
    }

    // Update company capabilities with test info
    const testCapabilities = {
      smoke: hasPlaywrightConfig || hasTestDir,
      unit: false, // Would need deeper analysis
      e2e: hasPlaywrightConfig,
    };
    try {
      await sql`
        UPDATE companies SET
          capabilities = jsonb_set(COALESCE(capabilities, '{}'), '{tests}', ${JSON.stringify(testCapabilities)}::jsonb),
          updated_at = NOW()
        WHERE id = ${companyId}
      `;
    } catch { /* non-blocking */ }

    // Create engineering tasks for issues
    if (!hasTestFiles && totalCycles >= 3) {
      // No test files at all — company has had enough cycles to warrant tests
      const taskTitle = `Add smoke tests for ${slug}`;
      const [existingTask] = await sql`
        SELECT id FROM company_tasks
        WHERE company_id = ${companyId} AND title = ${taskTitle}
        AND status NOT IN ('done', 'dismissed')
        LIMIT 1
      `;
      if (!existingTask) {
        await sql`
          INSERT INTO company_tasks (company_id, title, description, category, priority, status, source)
          VALUES (
            ${companyId},
            ${taskTitle},
            ${"This company has no test files (no tests/ directory, no playwright.config.ts, no src/__tests__/). Add Playwright smoke tests that verify: 1) Homepage loads with 200 status, 2) Key pages return 200, 3) API routes respond correctly. Use the boilerplate pattern from templates/boilerplate/ as reference. Install @playwright/test as devDependency and add a post-deploy.yml workflow."},
            'qa', 2, 'proposed', 'sentinel'
          )
        `;
        testCoverageIssues++;
        dispatches.push({
          type: "internal",
          target: "test_coverage",
          payload: { company: slug, issue: "no_tests", task_created: true },
        });
      }
    } else if (hasTestFiles && latestTestRun && latestTestRun.conclusion !== "success") {
      // Tests exist but are failing
      const taskTitle = `Fix failing tests for ${slug}`;
      const [existingTask] = await sql`
        SELECT id FROM company_tasks
        WHERE company_id = ${companyId} AND title = ${taskTitle}
        AND status NOT IN ('done', 'dismissed')
        LIMIT 1
      `;
      if (!existingTask) {
        await sql`
          INSERT INTO company_tasks (company_id, title, description, category, priority, status, source)
          VALUES (
            ${companyId},
            ${taskTitle},
            ${"The post-deploy.yml test workflow is failing (conclusion: " + (latestTestRun.conclusion || "unknown") + "). Investigate and fix the test suite. Common issues: 1) Playwright not installed in CI, 2) Missing env vars in workflow, 3) Tests targeting removed/changed pages, 4) Timeout issues. Check the latest GitHub Actions run logs for details."},
            'qa', 1, 'proposed', 'sentinel'
          )
        `;
        testCoverageIssues++;
        dispatches.push({
          type: "internal",
          target: "test_coverage",
          payload: { company: slug, issue: "tests_failing", conclusion: latestTestRun.conclusion, task_created: true },
        });
      }
    }
  }

  if (testCoverageIssues > 0) {
    await sql`
      INSERT INTO agent_actions (agent, action_type, description, status, started_at, finished_at)
      VALUES ('sentinel', 'test_coverage_check',
        ${`Test coverage check: ${testCoverageIssues} issues found across ${testCompanies.length} companies`},
        'success', NOW(), NOW())
    `.catch(() => {});
  }

  // --- HTTP health checks (parallel) ---
  const companiesWithUrls = await sql`
    SELECT slug, COALESCE('https://' || domain, vercel_url) as check_url FROM companies
    WHERE status IN ('mvp', 'active') AND vercel_url IS NOT NULL AND github_repo IS NOT NULL
  `;
  const brokenDeploys = await checkHttpHealth(
    companiesWithUrls.map((r) => ({ slug: r.slug as string, url: r.check_url as string }))
  );
  // 30. Broken deploys → try infra repair FIRST, then code fix as fallback
  // This prevents burning Claude tokens on hive-fix.yml when the issue is infrastructure
  // (duplicate Vercel projects, missing env vars, failed deploys — not code bugs)
  let infraRepairsAttempted = 0;
  for (const b of brokenDeploys) {
    // Step 1: Try infrastructure repair (free, no LLM)
    try {
      const repairRes = await fetch(`${baseUrl}/api/agents/repair-infra`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cronSecret}`, "Content-Type": "application/json" },
        body: JSON.stringify({ company_slug: b.slug, repair_type: "stale_escalation" }),
        signal: AbortSignal.timeout(30000),
      });
      const repairData = await repairRes.json();
      infraRepairsAttempted++;

      const repaired = repairData.repairs?.vercel_duplicates?.action === "unlinked_duplicates"
        || repairData.repairs?.vercel_deploy?.action === "redeployed";

      dispatches.push({
        type: "internal",
        target: "deploy_repair",
        payload: { company: b.slug, http_status: b.status, infra_repaired: repaired, repairs: repairData.repairs },
      });

      if (repaired) {
        // Infra repair handled it — skip code fix dispatch
        continue;
      }
    } catch (e: any) {
      console.warn(`Infra repair failed for ${b.slug}: ${e.message}`);
    }

    // Step 2: Infra repair didn't fix it — check circuit breaker before dispatching code fix
    const [failCount] = await sql`
      SELECT COUNT(*)::int as cnt FROM agent_actions
      WHERE company_id = (SELECT id FROM companies WHERE slug = ${b.slug})
        AND agent = 'engineer' AND status = 'failed'
        AND action_type IN ('error_fix', 'feature_request')
        AND started_at > NOW() - INTERVAL '24 hours'
    `;
    if ((failCount?.cnt || 0) >= 3) {
      // Circuit breaker: too many failed fixes, don't waste more tokens
      dispatches.push({ type: "circuit_break", target: "deploy_fix_skipped", payload: { company: b.slug, failures_24h: failCount?.cnt } });
      continue;
    }

    // Step 3: Dispatch code fix to company repo
    const [co] = await sql`SELECT github_repo FROM companies WHERE slug = ${b.slug} LIMIT 1`;
    if (co?.github_repo) {
      await dispatchToCompanyWorkflow(co.github_repo as string, "hive-fix.yml", {
        company_slug: b.slug,
        error_summary: `Deploy broken (HTTP ${b.status}) — infra repair attempted, issue appears to be code-level`,
        source: "sentinel",
      }, ghPat);
      dispatches.push({ type: "company_actions", target: "ops_escalation", payload: { company: b.slug, http_status: b.status } });
    } else {
      await dispatchToActions("ops_escalation", {
        source: "sentinel",
        company: b.slug,
        reason: "deploy_broken",
        http_status: b.status,
        trace_id: traceId,
      }, ghPat);
      dispatches.push({ type: "brain", target: "ops_escalation", payload: { company: b.slug, http_status: b.status } });
    }
  }

  // --- Deploy drift check ---
  const drift = await checkDeployDrift(vercelToken, ghPat);
  if (drift.drifted) {
    await dispatchToActions("deploy_drift", {
      source: "sentinel",
      main_sha: drift.mainSha,
      deploy_sha: drift.deploySha,
      trace_id: traceId,
    }, ghPat);
    dispatches.push({ type: "brain", target: "deploy_drift", payload: { main: drift.mainSha, deployed: drift.deploySha } });
  }

  // 26. Auto-approve safe evolver proposals
  // Safe = process/knowledge gap + medium/low severity + no financial keywords + pending >24h
  const UNSAFE_KEYWORDS = /\b(spend|delete|remove|kill|payment|stripe|billing)\b/i;
  let proposalsAutoApproved = 0;

  const safeProposals = await sql`
    SELECT id, title, proposed_fix, gap_type, severity
    FROM evolver_proposals
    WHERE status = 'pending'
    AND gap_type IN ('process', 'knowledge')
    AND severity IN ('medium', 'low')
    AND created_at < NOW() - INTERVAL '24 hours'
  `;

  for (const p of safeProposals) {
    // Check proposed_fix for unsafe financial keywords
    const fixText = typeof p.proposed_fix === "string" ? p.proposed_fix : JSON.stringify(p.proposed_fix);
    if (UNSAFE_KEYWORDS.test(fixText) || UNSAFE_KEYWORDS.test(p.title as string)) {
      continue;
    }

    await sql`
      UPDATE evolver_proposals
      SET status = 'approved', reviewed_at = NOW(), notes = 'Auto-approved by Sentinel (safe criteria met)'
      WHERE id = ${p.id}
    `;
    await sql`
      INSERT INTO agent_actions (agent, action_type, description, status, output, started_at, finished_at)
      VALUES ('sentinel', 'auto_approve_proposal', ${`Auto-approved safe evolver proposal: ${p.title}`},
        'success', ${JSON.stringify({ proposal_id: p.id, gap_type: p.gap_type, severity: p.severity })}::jsonb,
        NOW(), NOW())
    `;
    proposalsAutoApproved++;
    dispatches.push({ type: "auto_approve", target: "evolver_proposal", payload: { id: p.id, title: p.title } });
  }

  // Dispatch approved improvement proposals to Engineer (self-improvement)
  // Only dispatch capability proposals that haven't been dispatched yet.
  // Engineer works on Hive's own repo in a branch, creates a PR for review.
  const approvedImprovements = await sql`
    SELECT id, title, diagnosis, proposed_fix, gap_type, severity
    FROM evolver_proposals
    WHERE status = 'approved'
      AND gap_type IN ('capability', 'outcome')
      AND signal_source = 'sentinel_self_improvement'
      AND implemented_at IS NULL
      AND reviewed_at > NOW() - INTERVAL '7 days'
    ORDER BY
      CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
    LIMIT 1
  `;
  for (const imp of approvedImprovements) {
    const dispatchKey = `self_improve:${imp.id}`;
    if (isDuplicate("feature_request", dispatchKey)) continue;
    // Dispatch Engineer to work on Hive's own repo
    await dispatchToActions("feature_request", {
      company: "_hive",
      task: `Self-improvement: ${imp.title}`,
      description: `Diagnosis: ${imp.diagnosis}\n\nProposed fix: ${typeof imp.proposed_fix === 'string' ? imp.proposed_fix : JSON.stringify(imp.proposed_fix)}`,
      proposal_id: imp.id,
      branch: `hive/improvement/${(imp.title as string).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`,
    }, ghPat);
    // Mark as dispatched (set implemented_at to prevent re-dispatch, will be updated on completion)
    await sql`
      UPDATE evolver_proposals SET implemented_at = NOW(), notes = COALESCE(notes, '') || ' | Dispatched to Engineer'
      WHERE id = ${imp.id}
    `;
    dispatches.push({ type: "self_improvement", target: "engineer", payload: { proposal_id: imp.id, title: imp.title } });
  }

  // Reminder for critical/high severity proposals pending >48h
  const urgentPending = await sql`
    SELECT id, title, severity, gap_type
    FROM evolver_proposals
    WHERE status = 'pending'
    AND severity IN ('critical', 'high')
    AND created_at < NOW() - INTERVAL '48 hours'
  `;

  for (const p of urgentPending) {
    // Only log reminder once per 24h
    const [recentReminder] = await sql`
      SELECT id FROM agent_actions
      WHERE agent = 'sentinel' AND action_type = 'proposal_reminder'
      AND description ILIKE ${"%" + (p.id as string) + "%"}
      AND started_at > NOW() - INTERVAL '24 hours'
      LIMIT 1
    `;
    if (recentReminder) continue;

    await sql`
      INSERT INTO agent_actions (agent, action_type, description, status, output, started_at, finished_at)
      VALUES ('sentinel', 'proposal_reminder',
        ${`Reminder: ${p.severity} evolver proposal pending >48h: ${p.title} (${p.id})`},
        'success', ${JSON.stringify({ proposal_id: p.id, severity: p.severity, gap_type: p.gap_type })}::jsonb,
        NOW(), NOW())
    `;
    dispatches.push({ type: "reminder", target: "evolver_proposal", payload: { id: p.id, severity: p.severity, title: p.title } });
  }

  // 27. Playbook confidence time-decay + auto-prune
  // Entries unreferenced for 30+ days lose confidence. Below 0.15 → pruned (superseded).
  // This prevents stale playbook entries from cluttering agent context forever.
  let playbookDecayed = 0;
  let playbookPruned = 0;

  const stalePlaybook = await sql`
    SELECT id, confidence, last_referenced_at, created_at
    FROM playbook
    WHERE superseded_by IS NULL
      AND confidence > 0.15
      AND COALESCE(last_referenced_at, created_at) < NOW() - INTERVAL '30 days'
  `.catch(() => []);

  for (const entry of stalePlaybook) {
    // Decay: -0.02 per Sentinel run (runs every 4h, so ~0.12/day, but capped by 30-day window)
    const newConfidence = Math.max(0, Number(entry.confidence) - 0.02);
    await sql`
      UPDATE playbook SET confidence = ${newConfidence} WHERE id = ${entry.id}
    `.catch(() => {});
    playbookDecayed++;
  }

  // Auto-prune: mark entries below threshold as superseded (soft delete)
  const pruneCandidates = await sql`
    SELECT id, domain, insight FROM playbook
    WHERE superseded_by IS NULL AND confidence <= 0.15 AND confidence > 0
  `.catch(() => []);

  for (const entry of pruneCandidates) {
    // Find a higher-confidence entry in the same domain to supersede with
    const [replacement] = await sql`
      SELECT id FROM playbook
      WHERE domain = ${entry.domain} AND superseded_by IS NULL
        AND confidence > 0.5 AND id != ${entry.id}
      ORDER BY confidence DESC LIMIT 1
    `.catch(() => []);

    if (replacement) {
      await sql`
        UPDATE playbook SET superseded_by = ${replacement.id} WHERE id = ${entry.id}
      `.catch(() => {});
    } else {
      // No replacement — just zero out confidence so it won't be injected
      await sql`
        UPDATE playbook SET confidence = 0 WHERE id = ${entry.id}
      `.catch(() => {});
    }
    playbookPruned++;
  }

  if (playbookDecayed > 0 || playbookPruned > 0) {
    await sql`
      INSERT INTO agent_actions (agent, action_type, description, status, started_at, finished_at)
      VALUES ('sentinel', 'playbook_maintenance',
        ${`Playbook maintenance: ${playbookDecayed} entries decayed, ${playbookPruned} entries pruned (below 0.15 confidence)`},
        'success', NOW(), NOW())
    `.catch(() => {});
  }

  // 28. Venture Brain — cross-company intelligence (requires 2+ live companies)
  // Pure SQL + Node.js logic: no LLM call. Identifies cross-pollination opportunities,
  // detects portfolio patterns, creates directives for companies that can learn from each other.
  let ventureBrainDirectives = 0;
  const VB_MAX_DIRECTIVES = 3;

  try {
    const liveCompanies = await sql`
      SELECT id, slug, name, company_type FROM companies
      WHERE status IN ('mvp', 'active') AND github_repo IS NOT NULL
    `;

    if (liveCompanies.length >= 2) {
      // 28a. Cross-pollination: find high-confidence playbook entries from company A
      // that company B hasn't been told about yet (no venture_brain directive in 7 days)
      const crossPollination = await sql`
        SELECT p.id as playbook_id, p.domain, p.insight, p.confidence,
          p.source_company_id, sc.slug as source_slug, sc.name as source_name,
          tc.id as target_company_id, tc.slug as target_slug, tc.name as target_name
        FROM playbook p
        JOIN companies sc ON sc.id = p.source_company_id
        CROSS JOIN companies tc
        WHERE tc.status IN ('mvp', 'active') AND tc.github_repo IS NOT NULL
          AND tc.id != p.source_company_id
          AND p.confidence >= 0.7
          AND p.superseded_by IS NULL
          -- No venture_brain directive for this company in the last 7 days
          AND NOT EXISTS (
            SELECT 1 FROM directives d
            WHERE d.company_id = tc.id
              AND d.agent = 'venture_brain'
              AND d.created_at > NOW() - INTERVAL '7 days'
          )
          -- Haven't already sent this specific playbook insight to this company
          AND NOT EXISTS (
            SELECT 1 FROM directives d
            WHERE d.company_id = tc.id
              AND d.text ILIKE '%' || p.id || '%'
          )
        ORDER BY p.confidence DESC, p.applied_count ASC
        LIMIT ${VB_MAX_DIRECTIVES}
      `;

      for (const row of crossPollination) {
        if (ventureBrainDirectives >= VB_MAX_DIRECTIVES) break;
        await sql`
          INSERT INTO directives (company_id, agent, text, status)
          VALUES (
            ${row.target_company_id},
            'venture_brain',
            ${`[Venture Brain] From ${row.source_name}: Apply "${row.insight}" (domain: ${row.domain}, confidence: ${row.confidence}). Playbook ref: ${row.playbook_id}`},
            'open'
          )
        `;
        // Bump the playbook entry's applied_count and last_referenced_at
        await sql`
          UPDATE playbook
          SET applied_count = applied_count + 1, last_referenced_at = NOW()
          WHERE id = ${row.playbook_id}
        `;
        ventureBrainDirectives++;
        dispatches.push({
          type: "venture_brain",
          target: "cross_pollination",
          payload: { source: row.source_slug, target: row.target_slug, domain: row.domain, playbook_id: row.playbook_id },
        });
      }

      // 28b. Detect declining CEO scores — companies with avg score dropping over last 3 cycles
      // vs previous 3 cycles. If a peer is rising, suggest learning from the peer.
      if (ventureBrainDirectives < VB_MAX_DIRECTIVES) {
        const scoreTrends = await sql`
          WITH recent AS (
            SELECT company_id, AVG((ceo_review->>'score')::numeric) as avg_score
            FROM cycles
            WHERE status = 'complete' AND ceo_review IS NOT NULL
              AND ceo_review->>'score' IS NOT NULL
              AND started_at > NOW() - INTERVAL '21 days'
            GROUP BY company_id
            HAVING COUNT(*) >= 2
          ),
          previous AS (
            SELECT company_id, AVG((ceo_review->>'score')::numeric) as avg_score
            FROM cycles
            WHERE status = 'complete' AND ceo_review IS NOT NULL
              AND ceo_review->>'score' IS NOT NULL
              AND started_at BETWEEN NOW() - INTERVAL '42 days' AND NOW() - INTERVAL '21 days'
            GROUP BY company_id
            HAVING COUNT(*) >= 2
          )
          SELECT r.company_id, c.slug, c.name,
            r.avg_score as recent_score, p.avg_score as previous_score,
            (r.avg_score - p.avg_score) as score_delta
          FROM recent r
          JOIN previous p ON p.company_id = r.company_id
          JOIN companies c ON c.id = r.company_id
          WHERE c.status IN ('mvp', 'active') AND c.github_repo IS NOT NULL
          ORDER BY score_delta ASC
        `;

        // Find declining companies (delta < -1) and rising companies (delta > +1)
        const declining = scoreTrends.filter((r: any) => Number(r.score_delta) < -1);
        const rising = scoreTrends.filter((r: any) => Number(r.score_delta) > 1);

        for (const dec of declining) {
          if (ventureBrainDirectives >= VB_MAX_DIRECTIVES) break;
          // Check 7-day cooldown
          const [recentDirective] = await sql`
            SELECT id FROM directives
            WHERE company_id = ${dec.company_id} AND agent = 'venture_brain'
              AND created_at > NOW() - INTERVAL '7 days'
            LIMIT 1
          `;
          if (recentDirective) continue;

          // If there's a rising peer, mention it; otherwise just flag the decline
          const peer = rising.length > 0 ? rising[0] : null;
          const peerNote = peer
            ? ` Meanwhile, ${peer.name} is improving (score ${Number(peer.previous_score).toFixed(1)} -> ${Number(peer.recent_score).toFixed(1)}). Check their recent playbook entries for applicable tactics.`
            : "";

          await sql`
            INSERT INTO directives (company_id, agent, text, status)
            VALUES (
              ${dec.company_id},
              'venture_brain',
              ${`[Venture Brain] CEO score declining for ${dec.name}: ${Number(dec.previous_score).toFixed(1)} -> ${Number(dec.recent_score).toFixed(1)} (delta: ${Number(dec.score_delta).toFixed(1)}).${peerNote} Investigate root cause and adjust strategy.`},
              'open'
            )
          `;
          ventureBrainDirectives++;
          dispatches.push({
            type: "venture_brain",
            target: "score_decline",
            payload: { company: dec.slug, delta: Number(dec.score_delta), peer: peer?.slug || null },
          });
        }
      }

      // 28c. Cross-company error correlation: if company A fixed an error that company B still has
      if (ventureBrainDirectives < VB_MAX_DIRECTIVES) {
        const crossErrors = await sql`
          WITH failed_recent AS (
            SELECT aa.company_id, c.slug, c.name,
              REGEXP_REPLACE(aa.error, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', 'UUID', 'gi') as normalized_error
            FROM agent_actions aa
            JOIN companies c ON c.id = aa.company_id
            WHERE aa.status = 'failed'
              AND aa.error IS NOT NULL
              AND aa.started_at > NOW() - INTERVAL '7 days'
              AND c.status IN ('mvp', 'active')
          ),
          fixed AS (
            SELECT aa.company_id, c.slug as fix_slug, c.name as fix_name,
              REGEXP_REPLACE(aa.error, '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', 'UUID', 'gi') as normalized_error
            FROM agent_actions aa
            JOIN companies c ON c.id = aa.company_id
            WHERE aa.status = 'success'
              AND aa.error IS NOT NULL
              AND aa.action_type IN ('sentinel_retry', 'auto_resolve_escalation')
              AND aa.started_at > NOW() - INTERVAL '30 days'
          )
          SELECT DISTINCT f.company_id as failing_company_id, f.slug as failing_slug,
            fx.fix_slug, fx.fix_name, f.normalized_error
          FROM failed_recent f
          JOIN fixed fx ON fx.normalized_error = f.normalized_error AND fx.company_id != f.company_id
          WHERE NOT EXISTS (
            SELECT 1 FROM directives d
            WHERE d.company_id = f.company_id AND d.agent = 'venture_brain'
              AND d.created_at > NOW() - INTERVAL '7 days'
          )
          LIMIT ${VB_MAX_DIRECTIVES - ventureBrainDirectives}
        `;

        for (const row of crossErrors) {
          if (ventureBrainDirectives >= VB_MAX_DIRECTIVES) break;
          await sql`
            INSERT INTO directives (company_id, agent, text, status)
            VALUES (
              ${row.failing_company_id},
              'venture_brain',
              ${`[Venture Brain] Error correlation: ${row.fix_name} already fixed a similar error ("${(row.normalized_error as string).slice(0, 120)}..."). Apply the same fix approach.`},
              'open'
            )
          `;
          ventureBrainDirectives++;
          dispatches.push({
            type: "venture_brain",
            target: "error_correlation",
            payload: { failing: row.failing_slug, fixed_by: row.fix_slug },
          });
        }
      }

      // 28d. Write portfolio-level playbook entry if meaningful pattern detected
      // (only if we found cross-pollination or score trends worth noting)
      if (ventureBrainDirectives > 0) {
        const portfolioInsight = ventureBrainDirectives > 0
          ? `Venture Brain run: created ${ventureBrainDirectives} cross-company directive(s) across ${liveCompanies.length} live companies.`
          : null;
        if (portfolioInsight) {
          await sql`
            INSERT INTO agent_actions (agent, action_type, description, status, output, started_at, finished_at)
            VALUES ('sentinel', 'venture_brain',
              ${portfolioInsight},
              'success',
              ${JSON.stringify({ directives_created: ventureBrainDirectives, live_companies: liveCompanies.length })}::jsonb,
              NOW(), NOW())
          `;
        }
      }
    }
  } catch (e: any) {
    console.warn("Venture Brain check failed (non-blocking):", e.message);
  }

  // 29. Playbook consolidation — merge near-duplicate entries using text similarity
  // Same domain, not superseded, confidence > 0.2, Jaccard word overlap >= 0.6
  // Cross-company composites created when entries from different companies overlap >= 0.5
  let playbookMerged = 0;
  let playbookComposites = 0;
  const PB_MAX_MERGES = 10;
  const PB_MAX_COMPOSITES = 3;

  function jaccardSimilarity(a: string, b: string): number {
    const wordsA = new Set(a.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean));
    const wordsB = new Set(b.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean));
    if (wordsA.size === 0 || wordsB.size === 0) return 0;
    let intersection = 0;
    for (const w of wordsA) { if (wordsB.has(w)) intersection++; }
    const union = new Set([...wordsA, ...wordsB]).size;
    return union === 0 ? 0 : intersection / union;
  }

  try {
    // Fetch all active playbook entries grouped by domain
    const consolidationEntries = await sql`
      SELECT id, source_company_id, domain, insight, confidence, applied_count, reference_count
      FROM playbook
      WHERE superseded_by IS NULL AND confidence > 0.2
      ORDER BY domain, confidence DESC
    `;

    // Group by domain
    const byDomain: Record<string, typeof consolidationEntries> = {};
    for (const e of consolidationEntries) {
      const d = e.domain as string;
      if (!byDomain[d]) byDomain[d] = [];
      byDomain[d].push(e);
    }

    // Track already-superseded IDs this run to avoid double-merging
    const supersededThisRun = new Set<string>();

    for (const domain of Object.keys(byDomain)) {
      const entries = byDomain[domain];

      // --- Merge near-duplicates (same domain, Jaccard >= 0.6) ---
      for (let i = 0; i < entries.length && playbookMerged < PB_MAX_MERGES; i++) {
        const a = entries[i];
        if (supersededThisRun.has(a.id as string)) continue;
        const insightA = a.insight as string;
        if (insightA.split(/\s+/).length < 5) continue; // skip very short insights

        for (let j = i + 1; j < entries.length && playbookMerged < PB_MAX_MERGES; j++) {
          const b = entries[j];
          if (supersededThisRun.has(b.id as string)) continue;
          const insightB = b.insight as string;
          if (insightB.split(/\s+/).length < 5) continue;

          const similarity = jaccardSimilarity(insightA, insightB);
          if (similarity < 0.6) continue;

          // Winner = higher confidence (entries sorted by confidence DESC, so a >= b)
          const winner = a;
          const loser = b;
          const boostedConfidence = Math.min(1.0, Number(winner.confidence) + 0.05);
          const combinedApplied = Number(winner.applied_count) + Number(loser.applied_count);
          const combinedRefs = Number(winner.reference_count) + Number(loser.reference_count);

          await sql`
            UPDATE playbook
            SET superseded_by = ${winner.id}
            WHERE id = ${loser.id}
          `;

          await sql`
            UPDATE playbook
            SET confidence = ${boostedConfidence},
                applied_count = ${combinedApplied},
                reference_count = ${combinedRefs},
                last_referenced_at = NOW()
            WHERE id = ${winner.id}
          `;

          supersededThisRun.add(loser.id as string);
          playbookMerged++;
        }
      }

      // --- Cross-company composites (Jaccard >= 0.5, different companies) ---
      // Only consider entries from specific companies (source_company_id NOT NULL)
      const companyEntries = entries.filter(
        (e) => e.source_company_id != null && !supersededThisRun.has(e.id as string)
            && (e.insight as string).split(/\s+/).length >= 5
      );

      for (let i = 0; i < companyEntries.length && playbookComposites < PB_MAX_COMPOSITES; i++) {
        const a = companyEntries[i];
        const insightA = a.insight as string;

        for (let j = i + 1; j < companyEntries.length && playbookComposites < PB_MAX_COMPOSITES; j++) {
          const b = companyEntries[j];
          if (a.source_company_id === b.source_company_id) continue; // must be different companies
          const insightB = b.insight as string;

          const similarity = jaccardSimilarity(insightA, insightB);
          if (similarity < 0.5) continue;

          // Check if a portfolio-level composite already exists for this domain with similar content
          const [existingComposite] = await sql`
            SELECT id, insight FROM playbook
            WHERE domain = ${domain} AND source_company_id IS NULL
              AND superseded_by IS NULL AND confidence > 0.2
            ORDER BY confidence DESC LIMIT 1
          `;

          if (existingComposite && jaccardSimilarity(existingComposite.insight as string, insightA) >= 0.5) {
            continue; // similar composite already exists
          }

          const compositeConfidence = Math.min(1.0, Math.max(Number(a.confidence), Number(b.confidence)) + 0.05);
          // Use the longer insight as the composite (it likely has more detail)
          const compositeInsight = insightA.length >= insightB.length ? insightA : insightB;

          await sql`
            INSERT INTO playbook (source_company_id, domain, insight, confidence, evidence, applied_count, reference_count)
            VALUES (
              NULL,
              ${domain},
              ${compositeInsight},
              ${compositeConfidence},
              ${JSON.stringify({ composite_from: [a.id, b.id], created_by: "sentinel_consolidation" })}::jsonb,
              0,
              0
            )
          `;

          playbookComposites++;
        }
      }
    }

    if (playbookMerged > 0 || playbookComposites > 0) {
      await sql`
        INSERT INTO agent_actions (agent, action_type, description, status, started_at, finished_at)
        VALUES ('sentinel', 'playbook_consolidation',
          ${`Playbook consolidation: ${playbookMerged} duplicates merged, ${playbookComposites} cross-company composites created`},
          'success', NOW(), NOW())
      `.catch(() => {});
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("Check 29 (playbook consolidation) failed:", msg);
  }

  // 34. Agent performance regression detection
  // Compare per-agent success rates: last 7 days vs previous 7 days.
  // If any agent drops >15pp → create evolver_proposal (outcome gap).
  // If any agent has <30% success rate for 7+ days → create escalation approval.
  let agentRegressions = 0;
  let agentEscalations = 0;

  try {
    const agentRecentStats = await sql`
      SELECT agent,
        COUNT(*) FILTER (WHERE status = 'success')::int as successes,
        COUNT(*)::int as total
      FROM agent_actions
      WHERE status IN ('success', 'failed')
        AND finished_at > NOW() - INTERVAL '7 days'
      GROUP BY agent
      HAVING COUNT(*) >= 5
    `;

    const agentPriorStats = await sql`
      SELECT agent,
        COUNT(*) FILTER (WHERE status = 'success')::int as successes,
        COUNT(*)::int as total
      FROM agent_actions
      WHERE status IN ('success', 'failed')
        AND finished_at BETWEEN NOW() - INTERVAL '14 days' AND NOW() - INTERVAL '7 days'
      GROUP BY agent
      HAVING COUNT(*) >= 5
    `;

    const priorRates: Record<string, number> = {};
    for (const r of agentPriorStats) {
      priorRates[r.agent as string] = Number(r.successes) / Number(r.total);
    }

    for (const r of agentRecentStats) {
      const agent = r.agent as string;
      const recentRate = Number(r.successes) / Number(r.total);
      const priorRate = priorRates[agent];

      // Check for >15pp regression
      if (priorRate !== undefined && priorRate - recentRate > 0.15) {
        // Dedup: check if an evolver_proposal already exists for this agent regression
        const [existingProposal] = await sql`
          SELECT id FROM evolver_proposals
          WHERE title ILIKE ${"%" + agent + "%" + "regression%"}
            AND status IN ('pending', 'approved')
            AND created_at > NOW() - INTERVAL '7 days'
          LIMIT 1
        `;
        if (!existingProposal) {
          await sql`
            INSERT INTO evolver_proposals (gap_type, severity, title, diagnosis, signal_source, proposed_fix, status)
            VALUES (
              'outcome',
              'high',
              ${`Agent performance regression: ${agent}`},
              ${`${agent} success rate dropped from ${Math.round(priorRate * 100)}% to ${Math.round(recentRate * 100)}% (${Math.round((priorRate - recentRate) * 100)}pp drop over 7 days). Sample size: ${r.total} actions.`},
              'sentinel_agent_regression',
              ${JSON.stringify({
                action: `Investigate ${agent} agent failures and improve prompt or retry logic`,
                agent,
                recent_rate: Math.round(recentRate * 100),
                prior_rate: Math.round(priorRate * 100),
                drop_pp: Math.round((priorRate - recentRate) * 100),
              })}::jsonb,
              'pending'
            )
          `;
          agentRegressions++;
          dispatches.push({
            type: "evolver_proposal",
            target: "agent_regression",
            payload: { agent, recent: Math.round(recentRate * 100), prior: Math.round(priorRate * 100) },
          });
        }
      }

      // Check for sustained <30% success rate
      if (recentRate < 0.3) {
        // Dedup: check if an escalation approval already exists for this agent
        const [existingEscalation] = await sql`
          SELECT id FROM approvals
          WHERE gate_type = 'escalation'
            AND status = 'pending'
            AND title ILIKE ${"%" + agent + "%" + "success rate%"}
          LIMIT 1
        `;
        if (!existingEscalation) {
          await sql`
            INSERT INTO approvals (gate_type, title, description, context)
            VALUES (
              'escalation',
              ${`Agent critically underperforming: ${agent} at ${Math.round(recentRate * 100)}% success rate`},
              ${`The ${agent} agent has a ${Math.round(recentRate * 100)}% success rate over the last 7 days (${r.successes}/${r.total} actions succeeded). This is below the 30% critical threshold. Review agent configuration, API keys, and prompt quality.`},
              ${JSON.stringify({
                agent,
                success_rate: Math.round(recentRate * 100),
                successes: Number(r.successes),
                total: Number(r.total),
                detected_by: "sentinel",
              })}::jsonb
            )
          `;
          agentEscalations++;
          dispatches.push({
            type: "escalation",
            target: "agent_underperforming",
            payload: { agent, success_rate: Math.round(recentRate * 100) },
          });
        }
      }
    }

    if (agentRegressions > 0 || agentEscalations > 0) {
      await sql`
        INSERT INTO agent_actions (agent, action_type, description, status, started_at, finished_at)
        VALUES ('sentinel', 'agent_performance_check',
          ${`Agent performance check: ${agentRegressions} regressions detected, ${agentEscalations} critical escalations`},
          'success', NOW(), NOW())
      `.catch(() => {});
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("Check 34 (agent performance regression) failed:", msg);
  }

  // 37. Self-improvement proposals — analyze operational patterns and propose Hive improvements
  // Hive should build its own backlog from operational data, not wait for human sessions.
  // Each pattern check creates an evolver_proposal with gap_type 'capability' if it identifies
  // a systemic issue that could be fixed by a code/infrastructure change.
  let selfImprovementProposals = 0;
  try {
    const MAX_PROPOSALS_PER_RUN = 2;
    const proposals: Array<{ title: string; diagnosis: string; fix: string; severity: string }> = [];

    // Pattern A: Recurring errors without known fixes (>3 occurrences, no fix in error_patterns)
    const recurringErrors = await sql`
      SELECT error, agent, COUNT(*)::int as occurrences,
        COUNT(DISTINCT company_id)::int as affected_companies
      FROM agent_actions
      WHERE status = 'failed' AND error IS NOT NULL
        AND finished_at > NOW() - INTERVAL '7 days'
      GROUP BY error, agent
      HAVING COUNT(*) >= 3
      ORDER BY COUNT(*) DESC LIMIT 5
    `.catch(() => []);

    for (const re of recurringErrors) {
      if (proposals.length >= MAX_PROPOSALS_PER_RUN) break;
      // Check if we already have a fix for this pattern
      const errorNorm = (re.error as string).slice(0, 200);
      const [knownFix] = await sql`
        SELECT id FROM error_patterns WHERE resolved = true AND pattern ILIKE ${"%" + errorNorm.slice(0, 80) + "%"} LIMIT 1
      `.catch(() => []);
      if (!knownFix) {
        proposals.push({
          title: `Recurring unfixed error in ${re.agent}: ${errorNorm.slice(0, 60)}`,
          diagnosis: `${re.agent} has failed ${re.occurrences} times in 7 days across ${re.affected_companies} companies with: "${errorNorm}". No known fix exists in error_patterns.`,
          fix: `Investigate root cause of ${re.agent} error, implement fix, and record in error_patterns for future auto-resolution.`,
          severity: Number(re.occurrences) >= 10 ? "high" : "medium",
        });
      }
    }

    // Pattern B: Companies with zero metrics for 7+ days (metrics pipeline not delivering value)
    const zeroMetricsCompanies = await sql`
      SELECT c.slug, MAX(m.page_views)::int as max_views
      FROM companies c
      LEFT JOIN metrics m ON m.company_id = c.id AND m.date > CURRENT_DATE - 7
      WHERE c.status IN ('mvp', 'active')
      GROUP BY c.slug
      HAVING COALESCE(MAX(m.page_views), 0) = 0
    `.catch(() => []);
    if (zeroMetricsCompanies.length > 0 && proposals.length < MAX_PROPOSALS_PER_RUN) {
      proposals.push({
        title: `${zeroMetricsCompanies.length} companies have zero metrics for 7+ days`,
        diagnosis: `Companies with no pageview data: ${zeroMetricsCompanies.map((c) => c.slug).join(", ")}. The metrics pipeline (company /api/stats → Hive metrics cron) is not delivering value.`,
        fix: `Ensure all company repos have working /api/stats endpoints with pageview middleware. Consider adding Vercel Analytics drain as backup data source.`,
        severity: "high",
      });
    }

    // Pattern C: Agents with >50% timeout failures (need longer timeouts or architecture change)
    const timeoutAgents = await sql`
      SELECT agent, COUNT(*)::int as timeouts,
        (COUNT(*)::float / NULLIF((SELECT COUNT(*) FROM agent_actions WHERE agent = aa.agent AND finished_at > NOW() - INTERVAL '7 days'), 0))::float as timeout_pct
      FROM agent_actions aa
      WHERE status = 'failed' AND error ILIKE '%timeout%'
        AND finished_at > NOW() - INTERVAL '7 days'
      GROUP BY agent
      HAVING COUNT(*) >= 3
    `.catch(() => []);
    for (const ta of timeoutAgents) {
      if (proposals.length >= MAX_PROPOSALS_PER_RUN) break;
      if (Number(ta.timeout_pct) > 0.5) {
        proposals.push({
          title: `${ta.agent} has ${Math.round(Number(ta.timeout_pct) * 100)}% timeout rate`,
          diagnosis: `${ta.agent} timed out ${ta.timeouts} times in 7 days (${Math.round(Number(ta.timeout_pct) * 100)}% of all failures). This suggests the allocated time/turns is insufficient for the work being assigned.`,
          fix: `Increase max_turns or timeout for ${ta.agent}, or break tasks into smaller steps that complete within the current budget.`,
          severity: "medium",
        });
      }
    }

    // Pattern D: Tasks stuck in proposed/approved for >14 days (backlog not being executed)
    const stuckTasks = await sql`
      SELECT COUNT(*)::int as stuck_count,
        COUNT(DISTINCT company_id)::int as affected_companies
      FROM company_tasks
      WHERE status IN ('proposed', 'approved')
        AND created_at < NOW() - INTERVAL '14 days'
    `.catch(() => [{ stuck_count: 0, affected_companies: 0 }]);
    if (Number(stuckTasks[0]?.stuck_count) > 5 && proposals.length < MAX_PROPOSALS_PER_RUN) {
      proposals.push({
        title: `${stuckTasks[0].stuck_count} tasks stuck for 14+ days across ${stuckTasks[0].affected_companies} companies`,
        diagnosis: `Tasks are being created (by Sentinel, CEO, etc.) but not executed by Engineer/Growth. This means self-healing checks create tasks that never get done.`,
        fix: `Review task dispatch flow: are CEO cycles planning these tasks? Is Engineer picking them up? Consider auto-dispatching high-priority tasks directly to Engineer.`,
        severity: "high",
      });
    }

    // Write proposals as evolver_proposals (dedup by title)
    for (const p of proposals) {
      const [existing] = await sql`
        SELECT id FROM evolver_proposals
        WHERE title ILIKE ${p.title.slice(0, 50) + "%"}
          AND status IN ('pending', 'approved')
          AND created_at > NOW() - INTERVAL '14 days'
        LIMIT 1
      `;
      if (!existing) {
        await sql`
          INSERT INTO evolver_proposals (gap_type, severity, title, diagnosis, signal_source, proposed_fix, status)
          VALUES ('capability', ${p.severity}, ${p.title}, ${p.diagnosis}, 'sentinel_self_improvement', ${p.fix}, 'pending')
        `;
        selfImprovementProposals++;
      }
    }

    if (selfImprovementProposals > 0) {
      await sql`
        INSERT INTO agent_actions (agent, action_type, description, status, started_at, finished_at)
        VALUES ('sentinel', 'self_improvement', ${`Created ${selfImprovementProposals} self-improvement proposals`}, 'success', NOW(), NOW())
      `.catch(() => {});
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("Check 37 (self-improvement proposals) failed:", msg);
  }

  // 35. Auto-learn error patterns from successful fixes (ReasoningBank-lite)
  // Finds successful fix actions in the last 24h, looks for a preceding failed action
  // (same agent, same company, within 2h), and records the error->fix pattern.
  let errorPatternsLearned = 0;

  try {
    const successfulFixes = await sql`
      SELECT id, agent, company_id, action_type, description, output, finished_at
      FROM agent_actions
      WHERE status = 'success'
        AND action_type IN ('fix_code', 'execute_task', 'scaffold_company')
        AND finished_at > NOW() - INTERVAL '24 hours'
      ORDER BY finished_at DESC
      LIMIT 20
    `;

    const EP_SIMILARITY_THRESHOLD = 0.6;

    for (const fix of successfulFixes) {
      if (!fix.agent) continue;

      // Find a preceding failed action (same agent, same company, within 2h before success)
      const precedingFailures = fix.company_id
        ? await sql`
            SELECT id, error, description, action_type
            FROM agent_actions
            WHERE status = 'failed'
              AND agent = ${fix.agent}
              AND company_id = ${fix.company_id}
              AND finished_at BETWEEN ${fix.finished_at}::timestamptz - INTERVAL '2 hours' AND ${fix.finished_at}::timestamptz
            ORDER BY finished_at DESC
            LIMIT 1
          `
        : await sql`
            SELECT id, error, description, action_type
            FROM agent_actions
            WHERE status = 'failed'
              AND agent = ${fix.agent}
              AND company_id IS NULL
              AND finished_at BETWEEN ${fix.finished_at}::timestamptz - INTERVAL '2 hours' AND ${fix.finished_at}::timestamptz
            ORDER BY finished_at DESC
            LIMIT 1
          `;

      if (precedingFailures.length === 0 || !precedingFailures[0].error) continue;

      const failedAction = precedingFailures[0];
      const errorText = failedAction.error as string;
      const normalized = normalizeError(errorText);
      if (!normalized || normalized.length < 10) continue;

      // Derive fix summary from the successful action
      const fixSummary = (fix.description as string) ||
        (fix.output && typeof fix.output === "object" ? JSON.stringify(fix.output).slice(0, 200) : null) ||
        `Fixed ${failedAction.action_type} error in ${fix.agent} agent`;

      // Dedup: check if this pattern already exists with high similarity
      const existingPatterns = await sql`
        SELECT id, pattern FROM error_patterns
        WHERE agent = ${fix.agent} AND resolved = true
        ORDER BY last_seen_at DESC LIMIT 50
      `;

      let alreadyExists = false;
      for (const ep of existingPatterns) {
        const sim = errorSimilarity(normalized, ep.pattern as string);
        if (sim >= EP_SIMILARITY_THRESHOLD) {
          await sql`
            UPDATE error_patterns
            SET occurrences = occurrences + 1, last_seen_at = NOW()
            WHERE id = ${ep.id}
          `;
          alreadyExists = true;
          break;
        }
      }

      if (!alreadyExists) {
        await sql`
          INSERT INTO error_patterns (pattern, agent, fix_summary, fix_detail, source_action_id, resolved, auto_fixable)
          VALUES (
            ${normalized},
            ${fix.agent},
            ${fixSummary.slice(0, 500)},
            ${errorText.slice(0, 1000)},
            ${fix.id},
            true,
            true
          )
        `;
        errorPatternsLearned++;
      }
    }

    if (errorPatternsLearned > 0) {
      await sql`
        INSERT INTO agent_actions (agent, action_type, description, status, started_at, finished_at)
        VALUES ('sentinel', 'error_pattern_learning',
          ${`Auto-learned ${errorPatternsLearned} error->fix patterns from successful fixes`},
          'success', NOW(), NOW())
      `.catch(() => {});
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("Check 35 (error pattern learning) failed:", msg);
  }

  // Send Telegram notification if something interesting happened
  try {
    const { notifyHive } = await import("@/lib/telegram");
    const interesting = dispatches.length > 0 || staleRecordsFixed > 0 ||
      selfImprovementProposals > 0 || agentRegressions > 0 || statsEndpointsBroken > 0 ||
      languageMismatches > 0 || hiveFixesDispatched > 0 || backlogDispatched > 0;
    if (interesting) {
      const parts: string[] = [];
      if (hiveFixesDispatched > 0) parts.push(`🔧 ${hiveFixesDispatched} Hive fixes (priority)`);
      if (backlogDispatched > 0) parts.push(`📋 ${backlogDispatched} backlog item dispatched`);
      if (dispatches.length > 0) parts.push(`${dispatches.length} dispatches`);
      if (staleRecordsFixed > 0) parts.push(`${staleRecordsFixed} stale records fixed`);
      if (selfImprovementProposals > 0) parts.push(`${selfImprovementProposals} improvement proposals`);
      if (agentRegressions > 0) parts.push(`${agentRegressions} agent regressions`);
      if (statsEndpointsBroken > 0) parts.push(`${statsEndpointsBroken} broken stats endpoints`);
      if (languageMismatches > 0) parts.push(`${languageMismatches} language mismatches`);

      await notifyHive({
        agent: "sentinel",
        action: "health_check",
        status: "success",
        summary: parts.join(", "),
        details: dispatches.map((d: Dispatch) => `${d.type}: ${d.target}`).join("\n"),
      });
    }
  } catch { /* Telegram not configured — silently skip */ }

  return Response.json({
    ok: true,
    trace_id: traceId,
    dispatches: dispatches.length,
    approvals_expired: expiredApprovals.length,
    scout_proposals_cleaned: proposalCleanupCount,
    stuck_cycles_cleaned: stuckCycles.length,
    deploy_drift: drift.drifted,
    broken_deploys: brokenDeploys.length,
    anomalies_detected: anomalies.length,
    schema_drift: schemaDrift.length,
    recurring_escalations: recurringEscalations.length,
    auto_resolved: autoResolved,
    auto_dismissed_escalations: autoDismissed,
    circuit_breaks: circuitBreaks,
    dedup_skips: dedupSkips,
    active_claims: activeClaims.size,
    stale_reclaimed: staleRunning.length,
    proposals_auto_approved: proposalsAutoApproved,
    playbook_decayed: playbookDecayed,
    playbook_pruned: playbookPruned,
    venture_brain_directives: ventureBrainDirectives,
    infra_repairs_attempted: infraRepairsAttempted,
    stats_endpoints_broken: statsEndpointsBroken,
    language_mismatches: languageMismatches,
    stale_records_fixed: staleRecordsFixed,
    playbook_merged: playbookMerged,
    playbook_composites: playbookComposites,
    agent_regressions: agentRegressions,
    agent_escalations: agentEscalations,
    test_coverage_issues: testCoverageIssues,
    self_improvement_proposals: selfImprovementProposals,
    hive_fixes_dispatched: hiveFixesDispatched,
    backlog_dispatched: backlogDispatched,
    error_patterns_learned: errorPatternsLearned,
    details: dispatches,
  });

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    console.error("Sentinel failed:", message, stack);
    return Response.json({ ok: false, error: message, stack }, { status: 500 });
  }
}
