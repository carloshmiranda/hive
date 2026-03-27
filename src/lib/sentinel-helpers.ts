/**
 * Shared helpers for Sentinel cron endpoints (ADR-031 Phase 2).
 *
 * Extracted from the monolithic sentinel/route.ts so that
 * sentinel-urgent, sentinel-dispatch, and sentinel-janitor
 * can all reuse dispatch, dedup, and circuit-breaker logic.
 */

import { getDb } from "@/lib/db";
import { getSettingValue } from "@/lib/settings";
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
  const ghPat = await getSettingValue("github_token").catch(() => null);
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
              Authorization: `token ${ghPat}`,
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

export async function isCircuitOpen(
  sql: any,
  agent: string,
  companyId: string | null
): Promise<boolean> {
  if (!companyId) return false;
  const [result] = await sql`
    SELECT COUNT(*)::int as failures FROM agent_actions
    WHERE agent = ${agent} AND company_id = ${companyId}
    AND status = 'failed' AND started_at > NOW() - INTERVAL '24 hours'
  `;
  return (result?.failures || 0) >= 3;
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
