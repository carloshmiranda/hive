/**
 * Shared helpers for Sentinel cron endpoints (ADR-031 Phase 2).
 *
 * Extracted from the monolithic sentinel/route.ts so that
 * sentinel-urgent, sentinel-dispatch, and sentinel-janitor
 * can all reuse dispatch, dedup, and circuit-breaker logic.
 */

import { getDb } from "@/lib/db";
import { getSettingValue } from "@/lib/settings";
import { getGitHubToken } from "@/lib/github-app";
import { verifyCronAuth, qstashPublish } from "@/lib/qstash";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const REPO = "carloshmiranda/hive";
export const MAX_CYCLE_DISPATCHES = 2;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Dispatch = {
  type: string;
  target: string;
  payload: Record<string, unknown>;
};

export interface SentinelContext {
  sql: ReturnType<typeof getDb>;
  ghPat: string | null;
  vercelToken: string | null;
  baseUrl: string;
  cronSecret: string;
  traceId: string;
  dispatches: Dispatch[];
  activeClaims: Set<string>;
  dispatchedThisRun: Set<string>;
  dedupSkips: number;
  circuitBreaks: number;
}

// ---------------------------------------------------------------------------
// Context initialisation — shared by all sentinel endpoints
// ---------------------------------------------------------------------------

export async function initSentinelContext(
  request: Request,
  label: string
): Promise<SentinelContext> {
  const authErr = await verifyCronAuth(request);
  if (authErr) throw authErr;

  const sql = getDb();
  const ghPat = await getGitHubToken().catch(() => null);
  const vercelToken = await getSettingValue("vercel_token").catch(() => null);
  const baseUrl = process.env.NEXT_PUBLIC_URL || "https://hive-phi.vercel.app";
  const cronSecret = process.env.CRON_SECRET || "";
  const traceId = `${label}-${Date.now().toString(36)}`;

  const activeClaims = await getActiveClaims(ghPat);

  return {
    sql,
    ghPat,
    vercelToken,
    baseUrl,
    cronSecret,
    traceId,
    dispatches: [],
    activeClaims,
    dispatchedThisRun: new Set(),
    dedupSkips: 0,
    circuitBreaks: 0,
  };
}

// ---------------------------------------------------------------------------
// Dispatch dedup (claims system)
// ---------------------------------------------------------------------------

export function claimKey(eventType: string, company?: string): string {
  return `${eventType}:${company || "_global"}`;
}

export async function getActiveClaims(
  ghPat: string | null
): Promise<Set<string>> {
  if (!ghPat) return new Set();
  const claims = new Set<string>();

  try {
    const [inProgressRes, queuedRes] = await Promise.all(
      ["in_progress", "queued"].map((status) =>
        fetch(
          `https://api.github.com/repos/${REPO}/actions/runs?status=${status}&per_page=50`,
          {
            headers: {
              Authorization: `Bearer ${ghPat}`,
              Accept: "application/vnd.github.v3+json",
            },
            signal: AbortSignal.timeout(8000),
          }
        )
      )
    );

    // Non-company values in workflow run-names that should map to _global
    // e.g. "Evolver: evolve_trigger — all" → claimKey("evolve_trigger", "_global")
    // Without this, "evolve_trigger:all" ≠ "evolve_trigger:_global" and dedup fails
    const NON_COMPANY_VALUES = new Set([
      "all", "systemic", "manual", "weekly", "daily", "portfolio",
      "global", "hive", "sentinel", "unknown",
    ]);
    const normalizeCompany = (val: string): string | undefined =>
      NON_COMPANY_VALUES.has(val.toLowerCase()) ? undefined : val;

    for (const res of [inProgressRes, queuedRes]) {
      if (!res.ok) continue;
      const data = await res.json();
      for (const run of data.workflow_runs || []) {
        const match = run.name?.match(/:\s*(\w+)\s*[—–-]\s*(\w+)/);
        if (match) claims.add(claimKey(match[1], normalizeCompany(match[2])));
        if (run.event === "repository_dispatch" && run.display_title) {
          const dtMatch = run.display_title.match(
            /:\s*(\w+)\s*[—–-]\s*(\w+)/
          );
          if (dtMatch) claims.add(claimKey(dtMatch[1], normalizeCompany(dtMatch[2])));
        }
      }
    }
  } catch {
    console.log("[sentinel] Warning: could not fetch active runs for dedup");
  }

  return claims;
}

export function isDuplicate(
  ctx: SentinelContext,
  eventType: string,
  company?: string
): boolean {
  const key = claimKey(eventType, company);
  if (ctx.dispatchedThisRun.has(key)) {
    ctx.dedupSkips++;
    console.log(`[sentinel] Dedup skip (within-run): ${key}`);
    return true;
  }
  if (ctx.activeClaims.has(key)) {
    ctx.dedupSkips++;
    console.log(`[sentinel] Dedup skip (cross-run, already running): ${key}`);
    return true;
  }
  return false;
}

export function markDispatched(
  ctx: SentinelContext,
  eventType: string,
  company?: string
) {
  ctx.dispatchedThisRun.add(claimKey(eventType, company));
}

// ---------------------------------------------------------------------------
// Dispatch helpers
// ---------------------------------------------------------------------------

export async function dispatchToActions(
  ctx: SentinelContext,
  eventType: string,
  payload: Record<string, unknown>
) {
  if (!ctx.ghPat) return;
  const company = (payload.company as string) || undefined;
  if (isDuplicate(ctx, eventType, company)) return;
  markDispatched(ctx, eventType, company);

  await fetch(`https://api.github.com/repos/${REPO}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `token ${ctx.ghPat}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ event_type: eventType, client_payload: payload }),
  });

  import("@/lib/telegram")
    .then(({ notifyHive }) =>
      notifyHive({
        agent: (payload.agent as string) || eventType.split("_")[0],
        action: eventType,
        company,
        status: "started",
        summary: `Dispatched ${eventType} via GitHub Actions`,
      })
    )
    .catch((e: any) => {
      console.warn(
        `[sentinel] Telegram notify for ${eventType} failed: ${e?.message || e}`
      );
    });
}

export async function dispatchToWorker(
  ctx: SentinelContext,
  agent: string,
  companySlug: string,
  trigger: string
) {
  if (isDuplicate(ctx, `worker_${agent}`, companySlug)) return;
  markDispatched(ctx, `worker_${agent}`, companySlug);

  await qstashPublish(
    "/api/agents/dispatch",
    { company_slug: companySlug, agent, trigger },
    {
      deduplicationId: `sentinel-worker-${agent}-${companySlug}-${new Date().toISOString().slice(0, 13)}`,
    }
  ).catch((e: any) => {
    console.warn(
      `[sentinel] qstash dispatch worker ${agent}/${companySlug} failed: ${e?.message || e}`
    );
  });

  import("@/lib/telegram")
    .then(({ notifyHive }) =>
      notifyHive({
        agent,
        action: trigger,
        company: companySlug,
        status: "started",
        summary: `Dispatched ${agent} worker for ${companySlug}`,
      })
    )
    .catch((e: any) => {
      console.warn(
        `[sentinel] Telegram notify for worker ${agent}/${companySlug} failed: ${e?.message || e}`
      );
    });
}

export async function dispatchToCompanyWorkflow(
  ctx: SentinelContext,
  githubRepo: string,
  workflow: string,
  inputs: Record<string, string>
) {
  if (!ctx.ghPat) return;
  const company = inputs.company_slug;
  const workflowKey = workflow.replace(".yml", "");
  if (isDuplicate(ctx, `company_${workflowKey}`, company)) return;
  markDispatched(ctx, `company_${workflowKey}`, company);

  await fetch(
    `https://api.github.com/repos/${githubRepo}/actions/workflows/${workflow}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `token ${ctx.ghPat}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "main", inputs }),
    }
  );

  import("@/lib/telegram")
    .then(({ notifyHive }) =>
      notifyHive({
        agent: inputs.agent || workflowKey.replace("hive-", ""),
        action: `${workflowKey} workflow`,
        company,
        status: "started",
        summary: `Dispatched ${workflow} on ${githubRepo.split("/")[1]}`,
      })
    )
    .catch((e: any) => {
      console.warn(
        `[sentinel] Telegram notify for company workflow ${workflow}/${company} failed: ${e?.message || e}`
      );
    });
}

// ---------------------------------------------------------------------------
// Infrastructure checks
// ---------------------------------------------------------------------------

export async function checkDeployDrift(
  ctx: SentinelContext
): Promise<{ drifted: boolean; mainSha?: string; deploySha?: string }> {
  if (!ctx.vercelToken || !ctx.ghPat) return { drifted: false };

  try {
    const [mainRes, deployRes] = await Promise.all([
      fetch(`https://api.github.com/repos/${REPO}/commits/main`, {
        headers: {
          Authorization: `token ${ctx.ghPat}`,
          Accept: "application/vnd.github.v3+json",
        },
        signal: AbortSignal.timeout(10000),
      }),
      fetch(
        "https://api.vercel.com/v6/deployments?projectId=prj_n9JaPbWmRv0SKoHgkdXYOEGQtjRv&teamId=team_Z4AsGtjfy6pAjCOtvJqzMT8d&target=production&limit=1",
        {
          headers: { Authorization: `Bearer ${ctx.vercelToken}` },
          signal: AbortSignal.timeout(10000),
        }
      ),
    ]);

    if (!mainRes.ok || !deployRes.ok) return { drifted: false };

    const mainData = await mainRes.json();
    const deployData = await deployRes.json();
    const mainSha = mainData.sha?.slice(0, 12);
    const deploySha =
      deployData.deployments?.[0]?.meta?.githubCommitSha?.slice(0, 12);

    if (mainSha && deploySha && mainSha !== deploySha) {
      return { drifted: true, mainSha, deploySha };
    }
    return { drifted: false, mainSha, deploySha };
  } catch {
    return { drifted: false };
  }
}

// ---------------------------------------------------------------------------
// Deploy health — detect consecutive ERROR deployments (broken pipeline)
// ---------------------------------------------------------------------------

export async function checkDeployHealth(
  ctx: SentinelContext
): Promise<{
  healthy: boolean;
  consecutiveErrors: number;
  lastReadyAt?: string;
  latestError?: string;
}> {
  if (!ctx.vercelToken) return { healthy: true, consecutiveErrors: 0 };

  try {
    const res = await fetch(
      "https://api.vercel.com/v6/deployments?projectId=prj_n9JaPbWmRv0SKoHgkdXYOEGQtjRv&teamId=team_Z4AsGtjfy6pAjCOtvJqzMT8d&target=production&limit=10",
      {
        headers: { Authorization: `Bearer ${ctx.vercelToken}` },
        signal: AbortSignal.timeout(10000),
      }
    );
    if (!res.ok) return { healthy: true, consecutiveErrors: 0 };

    const data = await res.json();
    const deploys = data.deployments || [];

    let consecutiveErrors = 0;
    let lastReadyAt: string | undefined;

    for (const d of deploys) {
      if (d.state === "ERROR") {
        consecutiveErrors++;
      } else if (d.state === "READY") {
        if (!lastReadyAt) lastReadyAt = new Date(d.created).toISOString();
        break;
      } else {
        // BUILDING, QUEUED, CANCELED — stop counting
        break;
      }
    }

    // 3+ consecutive errors = pipeline is broken, escalate
    if (consecutiveErrors >= 3) {
      return {
        healthy: false,
        consecutiveErrors,
        lastReadyAt,
        latestError: deploys[0]?.meta?.githubCommitMessage?.slice(0, 100),
      };
    }

    return { healthy: true, consecutiveErrors, lastReadyAt };
  } catch {
    return { healthy: true, consecutiveErrors: 0 };
  }
}

export async function isCircuitOpen(
  sql: any,
  agent: string,
  companyId: string | null
): Promise<boolean> {
  if (!companyId) return false;

  // Check Redis cache first
  try {
    const cachedState = await import("@/lib/redis-cache").then(({ getCachedCircuitState }) =>
      getCachedCircuitState(companyId, agent)
    );
    if (cachedState !== null) {
      return cachedState;
    }
  } catch {
    // Fall through to DB query
  }

  // Cache miss or Redis unavailable - query DB
  const [result] = await sql`
    SELECT COUNT(*)::int as failures FROM agent_actions
    WHERE agent = ${agent} AND company_id = ${companyId}
    AND status = 'failed' AND started_at > NOW() - INTERVAL '48 hours'
  `;

  const isOpen = (result?.failures || 0) >= 3;

  // Cache the result
  try {
    await import("@/lib/redis-cache").then(({ setCachedCircuitState }) =>
      setCachedCircuitState(companyId, agent, isOpen)
    );
  } catch {
    // Cache write failure is non-fatal
  }

  return isOpen;
}

// Batch circuit breaker check: Redis-first with DB fallback.
// Returns a Set of "agent:companyId" keys where the circuit is open (3+ failures in 48h).
// Uses Redis cache to avoid repeated agent_actions scans during Sentinel dispatch loops.
export async function batchCheckCircuits(
  sql: any
): Promise<Set<string>> {
  const openCircuits = new Set<string>();

  try {
    // Step 1: Get all distinct agent+company pairs that have recent actions
    const activePairs = await sql`
      SELECT DISTINCT agent, company_id
      FROM agent_actions
      WHERE started_at > NOW() - INTERVAL '48 hours'
      AND company_id IS NOT NULL
    `.catch(() => []);

    if (activePairs.length === 0) {
      return openCircuits;
    }

    // Step 2: Check Redis cache for all pairs
    const cachePromises = activePairs.map(async (pair: any) => {
      const cachedState = await import("@/lib/redis-cache").then(({ getCachedCircuitState }) =>
        getCachedCircuitState(pair.company_id, pair.agent)
      ).catch(() => null);
      return { ...pair, cachedState };
    });

    const pairsWithCache = await Promise.all(cachePromises);
    const uncachedPairs = [];

    // Step 3: Collect cached results and identify uncached pairs
    for (const pair of pairsWithCache) {
      if (pair.cachedState === true) {
        openCircuits.add(`${pair.agent}:${pair.company_id}`);
      } else if (pair.cachedState === null) {
        uncachedPairs.push(pair);
      }
      // cachedState === false means circuit is closed (cached), no need to add to set
    }

    // Step 4: Query DB for uncached pairs only
    if (uncachedPairs.length > 0) {
      const dbRows = await sql`
        SELECT agent, company_id, COUNT(*)::int as failures
        FROM agent_actions
        WHERE status = 'failed' AND started_at > NOW() - INTERVAL '48 hours'
        AND company_id IS NOT NULL
        AND (agent, company_id) IN ${sql(uncachedPairs.map((p: any) => [p.agent, p.company_id]))}
        GROUP BY agent, company_id
        HAVING COUNT(*) >= 3
      `.catch(() => []);

      // Step 5: Update Redis cache with DB results
      const cacheUpdates = uncachedPairs.map((pair: any) => ({
        companyId: pair.company_id,
        agent: pair.agent,
        isOpen: dbRows.some((r: any) => r.agent === pair.agent && r.company_id === pair.company_id)
      }));

      // Batch update Redis cache
      await import("@/lib/redis-cache").then(({ batchSetCircuitStates }) =>
        batchSetCircuitStates(cacheUpdates)
      ).catch(() => {});

      // Add open circuits from DB to result set
      for (const row of dbRows) {
        openCircuits.add(`${row.agent}:${row.company_id}`);
      }
    }

    return openCircuits;
  } catch (error) {
    // Fallback to original DB-only query if anything fails
    console.warn("[batchCheckCircuits] Redis-enhanced check failed, falling back to DB-only:", error);

    const rows = await sql`
      SELECT agent, company_id, COUNT(*)::int as failures
      FROM agent_actions
      WHERE status = 'failed' AND started_at > NOW() - INTERVAL '48 hours'
      AND company_id IS NOT NULL
      GROUP BY agent, company_id
      HAVING COUNT(*) >= 3
    `.catch(() => []);

    const fallbackOpen = new Set<string>();
    for (const r of rows) {
      fallbackOpen.add(`${r.agent}:${r.company_id}`);
    }
    return fallbackOpen;
  }
}

// ---------------------------------------------------------------------------
// Agent action logging with circuit breaker cache invalidation
// ---------------------------------------------------------------------------

/**
 * Log an agent action to the database and invalidate circuit breaker cache if it's a failure.
 * This ensures that circuit breaker state stays accurate when new failures occur.
 */
export async function logAgentAction(
  sql: any,
  action: {
    agent: string;
    company_id?: string | null;
    cycle_id?: string | null;
    action_type: string;
    description: string;
    status: 'started' | 'success' | 'failed';
    error?: string | null;
    output?: string | null;
    started_at?: Date;
    finished_at?: Date;
  }
): Promise<void> {
  // Insert the agent action
  await sql`
    INSERT INTO agent_actions (
      agent, company_id, cycle_id, action_type, description,
      status, error, output, started_at, finished_at
    ) VALUES (
      ${action.agent},
      ${action.company_id || null},
      ${action.cycle_id || null},
      ${action.action_type},
      ${action.description},
      ${action.status},
      ${action.error || null},
      ${action.output || null},
      ${action.started_at || new Date()},
      ${action.finished_at || (action.status !== 'started' ? new Date() : null)}
    )
  `;

  // If this is a failed action with a company_id, invalidate the circuit breaker cache
  // for this specific agent+company pair to ensure the cache reflects the new failure
  if (action.status === 'failed' && action.company_id) {
    try {
      await import("@/lib/redis-cache").then(({ invalidateCircuitBreaker }) =>
        invalidateCircuitBreaker(action.company_id!, action.agent)
      );
    } catch {
      // Cache invalidation failure is non-fatal
    }
  }
}

// ---------------------------------------------------------------------------
// Healer Circuit Breaker (per-company, with error pattern dedup and exponential backoff)
// ---------------------------------------------------------------------------

/**
 * Create an escalation approval for a company that has persistent Healer failures.
 * This prevents the feedback loop by requiring manual intervention instead of re-dispatching.
 */
export async function createHealerEscalation(
  sql: any,
  companyId: string,
  context: {
    failureCount: number;
    consecutiveFailures: number;
    successRate: number;
    recentErrors: string[];
    company_slug?: string;
  }
): Promise<{ created: boolean; approvalId?: string }> {
  try {
    const companyName = context.company_slug || `company-${companyId.slice(0, 8)}`;

    // Check if there's already a pending escalation for this company
    const [existingEscalation] = await sql`
      SELECT id FROM approvals
      WHERE gate_type = 'escalation'
        AND company_id = ${companyId}
        AND status = 'pending'
        AND context->>'escalation_type' = 'healer_blocked'
      LIMIT 1
    `;

    if (existingEscalation) {
      console.log(`[createHealerEscalation] Escalation already exists for ${companyName}: ${existingEscalation.id}`);
      return { created: false };
    }

    const title = `Healer blocked for ${companyName} - Manual intervention required`;
    const description = `Healer has failed ${context.failureCount} times for ${companyName} with ${context.consecutiveFailures} consecutive failures (${Math.round(context.successRate * 100)}% success rate). Circuit breaker activated to prevent feedback loop.`;

    const escalationContext = {
      escalation_type: 'healer_blocked',
      company_id: companyId,
      company_slug: companyName,
      failure_count: context.failureCount,
      consecutive_failures: context.consecutiveFailures,
      success_rate: context.successRate,
      recent_errors: context.recentErrors.slice(0, 5), // Limit to 5 most recent
      created_by: 'sentinel_healer_circuit_breaker',
      actions_available: [
        'Clear healer_blocked flag and retry',
        'Investigate root cause manually',
        'Mark company for provisioning review',
        'Escalate to infrastructure team'
      ]
    };

    const [approval] = await sql`
      INSERT INTO approvals (
        company_id, gate_type, title, description, context, status
      ) VALUES (
        ${companyId},
        'escalation',
        ${title},
        ${description},
        ${JSON.stringify(escalationContext)},
        'pending'
      ) RETURNING id
    `;

    // Set the healer_blocked flag to prevent future dispatch
    await sql`
      UPDATE companies
      SET healer_blocked = true, updated_at = NOW()
      WHERE id = ${companyId}
    `;

    console.log(`[createHealerEscalation] Created escalation ${approval.id} for ${companyName}, set healer_blocked=true`);

    return { created: true, approvalId: approval.id };
  } catch (error) {
    console.error(`[createHealerEscalation] Error creating escalation for company ${companyId}:`, error);
    return { created: false };
  }
}

/**
 * Check if healer should be blocked for a specific company based on:
 * 1. healer_blocked flag (manual escalation state)
 * 2. Per-company failure count (not global)
 * 3. Error pattern deduplication (same error description)
 * 4. Exponential backoff (2h → 4h → 8h → 24h)
 * 5. Escalation thresholds (3+ consecutive failures, success rate < 30%)
 */
export async function checkHealerCompanyCircuitBreaker(
  sql: any,
  companyId: string
): Promise<{
  blocked: boolean;
  reason?: string;
  failures?: number;
  lastErrorPattern?: string;
  backoffHours?: number;
  needsEscalation?: boolean;
  successRate?: number;
  consecutiveFailures?: number;
}> {
  try {
    // Check if company has healer_blocked flag set (manual escalation state)
    const [company] = await sql`
      SELECT healer_blocked, slug FROM companies WHERE id = ${companyId} LIMIT 1
    `;

    if (company?.healer_blocked) {
      return {
        blocked: true,
        reason: `Healer blocked flag set for ${company.slug} - awaiting manual intervention (escalation approval)`
      };
    }

    // Get recent healer actions for this company (extended window for success rate calculation)
    const healerActions = await sql`
      SELECT
        status,
        description,
        started_at,
        finished_at
      FROM agent_actions
      WHERE agent = 'healer'
        AND company_id = ${companyId}
        AND finished_at > NOW() - INTERVAL '7 days'
      ORDER BY finished_at DESC
      LIMIT 20
    `;

    const recentHealerActions = healerActions.filter((action: any) =>
      action.finished_at && new Date(action.finished_at) > new Date(Date.now() - 48 * 60 * 60 * 1000)
    );

    const failedActions = recentHealerActions.filter((action: any) => action.status === 'failed');
    const successfulActions = recentHealerActions.filter((action: any) => action.status === 'success');
    const totalActions = recentHealerActions.length;
    const failureCount = failedActions.length;

    // Calculate success rate
    const successRate = totalActions > 0 ? successfulActions.length / totalActions : 1.0;

    // Check for consecutive failures
    let consecutiveFailures = 0;
    for (const action of recentHealerActions) {
      if (action.status === 'failed') {
        consecutiveFailures++;
      } else if (action.status === 'success') {
        break;
      }
    }

    // Rule 0: Escalation threshold check (3+ consecutive failures OR success rate < 30% with 5+ attempts)
    const shouldEscalate = (
      consecutiveFailures >= 3 ||
      (successRate < 0.30 && totalActions >= 5)
    );

    if (shouldEscalate) {
      return {
        blocked: true,
        reason: `Escalation threshold reached: ${consecutiveFailures} consecutive failures, ${Math.round(successRate * 100)}% success rate (${successfulActions.length}/${totalActions})`,
        failures: failureCount,
        needsEscalation: true,
        successRate,
        consecutiveFailures
      };
    }

    // Rule 1: If 2+ healer failures for this company in 48h, calculate backoff
    if (failureCount >= 2) {
      const mostRecentFailure = failedActions[0];
      const failureAgeHours = mostRecentFailure?.finished_at
        ? (Date.now() - new Date(mostRecentFailure.finished_at).getTime()) / (1000 * 60 * 60)
        : 48;

      // Exponential backoff: 2h → 4h → 8h → 24h (capped)
      const backoffHours = Math.min(24, Math.pow(2, failureCount));

      if (failureAgeHours < backoffHours) {
        return {
          blocked: true,
          reason: `Exponential backoff: ${failureCount} healer failures, next attempt in ${Math.ceil(backoffHours - failureAgeHours)}h`,
          failures: failureCount,
          backoffHours,
          successRate,
          consecutiveFailures
        };
      }
    }

    // Rule 2: Error pattern deduplication - check if last 2 healer actions had identical descriptions
    if (recentHealerActions.length >= 2) {
      const lastTwo = recentHealerActions.slice(0, 2);
      const lastTwoDescriptions = lastTwo.map((action: any) => action.description?.trim().toLowerCase()).filter(Boolean);

      if (lastTwoDescriptions.length === 2 && lastTwoDescriptions[0] === lastTwoDescriptions[1]) {
        // Check if any other agent succeeded on this company since the last healer failure
        const [lastSuccessfulAction] = await sql`
          SELECT finished_at FROM agent_actions
          WHERE company_id = ${companyId}
            AND agent != 'healer'
            AND status = 'success'
            AND finished_at > ${lastTwo[0].finished_at}
          ORDER BY finished_at DESC
          LIMIT 1
        `;

        if (!lastSuccessfulAction) {
          return {
            blocked: true,
            reason: `Error pattern deduplication: last 2 healer dispatches had identical error patterns, awaiting other agent success`,
            failures: failureCount,
            lastErrorPattern: lastTwoDescriptions[0],
            successRate,
            consecutiveFailures
          };
        }
      }
    }

    return {
      blocked: false,
      failures: failureCount,
      successRate,
      consecutiveFailures
    };
  } catch (error) {
    console.warn(`[checkHealerCompanyCircuitBreaker] Error for company ${companyId}:`, error);
    // On error, be conservative and allow healer dispatch
    return { blocked: false };
  }
}

/**
 * Get all companies that need circuit breaker analysis for healer dispatches.
 * Returns a Map of companyId -> circuit breaker result to avoid repeated DB queries.
 */
export async function batchCheckHealerCircuitBreakers(
  sql: any,
  companyIds: string[]
): Promise<Map<string, { blocked: boolean; reason?: string; failures?: number }>> {
  const results = new Map();

  // Process companies in parallel for efficiency
  const promises = companyIds.map(async (companyId) => {
    const result = await checkHealerCompanyCircuitBreaker(sql, companyId);
    return [companyId, result];
  });

  const circuitResults = await Promise.all(promises);

  for (const [companyId, result] of circuitResults) {
    results.set(companyId, result);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Growth task routing helpers
// ---------------------------------------------------------------------------

/**
 * Check if a company has growth tasks that require repo access (file writes).
 * Used by Sentinel to decide whether to route Growth to company workflow or Vercel worker.
 */
export async function hasFileWriteTasks(
  baseUrl: string,
  companySlug: string,
  ghPat: string | null
): Promise<boolean> {
  if (!ghPat) return false;

  try {
    // Use GitHub App token to query the Growth context API
    const response = await fetch(`${baseUrl}/api/agents/context?agent=growth&company_slug=${companySlug}`, {
      headers: {
        'Authorization': `Bearer ${ghPat}`,
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(8000)
    });

    if (!response.ok) return false;

    const data = await response.json();
    return data.data?.has_file_write_tasks === true;
  } catch (error) {
    console.warn(`[hasFileWriteTasks] Error checking tasks for ${companySlug}:`, error);
    // Default to requiring repo access on error to be safe
    return true;
  }
}

// ---------------------------------------------------------------------------
// Text similarity (used by playbook consolidation in janitor)
// ---------------------------------------------------------------------------

export function jaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set(
    a
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter(Boolean)
  );
  const wordsB = new Set(
    b
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter(Boolean)
  );
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  const union = new Set([...wordsA, ...wordsB]).size;
  return union === 0 ? 0 : intersection / union;
}

// ---------------------------------------------------------------------------
// Rate limit detection for retry dispatch
// ---------------------------------------------------------------------------

/**
 * Check if recent failures for a specific agent/company combo are all rate limit errors.
 * Used to skip retry dispatch when the failures are due to Claude API rate limits
 * rather than actual implementation problems.
 *
 * @param sql Database connection
 * @param agent Agent name (e.g., 'engineer', 'growth')
 * @param companyId Company ID
 * @param lookbackHours How far back to check for failures (default: 6 hours)
 * @returns Object with isRateLimited flag and reset time if available
 */
export async function checkRecentRateLimitFailures(
  sql: ReturnType<typeof getDb>,
  agent: string,
  companyId: string,
  lookbackHours: number = 6
): Promise<{ isRateLimited: boolean; resetTime?: Date; consecutiveFailures: number }> {
  try {
    // Get recent failures for this agent/company combo
    const recentFailures = await sql`
      SELECT description, error, finished_at
      FROM agent_actions
      WHERE agent = ${agent}
        AND company_id = ${companyId}
        AND status = 'failed'
        AND finished_at > NOW() - INTERVAL '${lookbackHours} hours'
      ORDER BY finished_at DESC
      LIMIT 10
    `;

    if (recentFailures.length === 0) {
      return { isRateLimited: false, consecutiveFailures: 0 };
    }

    const rateLimitPatterns = [
      /rate limit/i,
      /session limit/i,
      /usage cap/i,
      /too many/i,
      /quota/i,
      /limit reached/i,
      /max_tokens/i,
      /capacity/i,
      /you've hit your limit/i,
      /resets \d+[ap]m utc/i,
    ];

    let consecutiveRateLimitFailures = 0;
    let resetTime: Date | undefined;

    // Check if failures match rate limit patterns
    for (const failure of recentFailures) {
      const errorText = `${failure.description || ''} ${failure.error || ''}`.toLowerCase();
      const isRateLimit = rateLimitPatterns.some(pattern => pattern.test(errorText));

      if (isRateLimit) {
        consecutiveRateLimitFailures++;

        // Try to extract reset time from patterns like "resets 1pm UTC"
        if (!resetTime) {
          const resetMatch = errorText.match(/resets (\d+[ap]m) utc/i);
          if (resetMatch) {
            const timeStr = resetMatch[1];
            const hour = parseInt(timeStr);
            const isPm = timeStr.toLowerCase().includes('pm');
            const resetHour = isPm && hour !== 12 ? hour + 12 : (!isPm && hour === 12 ? 0 : hour);

            // Set reset time to the next occurrence of that hour UTC
            const now = new Date();
            resetTime = new Date(now);
            resetTime.setUTCHours(resetHour, 0, 0, 0);
            if (resetTime <= now) {
              resetTime.setUTCDate(resetTime.getUTCDate() + 1);
            }
          }
        }
      } else {
        // If we hit a non-rate-limit failure, stop counting consecutive rate limits
        break;
      }
    }

    // Consider it rate limited if:
    // 1. We have at least 2 recent failures, AND
    // 2. All recent failures (up to the first 5) are rate limit errors
    const isRateLimited = consecutiveRateLimitFailures >= 2 &&
                          consecutiveRateLimitFailures >= Math.min(recentFailures.length, 5);

    return {
      isRateLimited,
      resetTime,
      consecutiveFailures: consecutiveRateLimitFailures
    };
  } catch (error) {
    console.warn(`[checkRecentRateLimitFailures] Error checking rate limits for ${agent}/${companyId}:`, error);
    return { isRateLimited: false, consecutiveFailures: 0 };
  }
}
