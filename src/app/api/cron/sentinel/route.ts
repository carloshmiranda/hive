import { getDb } from "@/lib/db";
import { getSettingValue } from "@/lib/settings";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const REPO = "carloshmiranda/hive";
const MAX_CYCLE_DISPATCHES = 2;

type Dispatch = { type: string; target: string; payload: Record<string, unknown> };

async function dispatchToActions(eventType: string, payload: Record<string, unknown>) {
  const ghPat = process.env.GH_PAT;
  if (!ghPat) return;
  await fetch(`https://api.github.com/repos/${REPO}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `token ${ghPat}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ event_type: eventType, client_payload: payload }),
  });
}

async function dispatchToWorker(agent: string, companySlug: string, trigger: string) {
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
}

async function checkHttpHealth(
  companies: Array<{ slug: string; vercel_url: string }>
): Promise<Array<{ slug: string; url: string; status: number; error?: string }>> {
  const results = await Promise.all(
    companies.map(async (c) => {
      try {
        const res = await fetch(c.vercel_url, {
          redirect: "follow",
          signal: AbortSignal.timeout(10000),
        });
        if (res.status >= 400) {
          return { slug: c.slug, url: c.vercel_url, status: res.status };
        }
        return null;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "unknown";
        return { slug: c.slug, url: c.vercel_url, status: 0, error: msg };
      }
    })
  );
  return results.filter((r): r is NonNullable<typeof r> => r !== null);
}

async function checkDeployDrift(vercelToken: string | null): Promise<{
  drifted: boolean;
  mainSha?: string;
  deploySha?: string;
}> {
  const ghPat = process.env.GH_PAT;
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

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sql = getDb();
  const vercelToken = await getSettingValue("vercel_token");
  const dispatches: Dispatch[] = [];
  let cycleDispatches = 0;

  // --- Run all DB health checks ---

  // 1. Pipeline count
  const [pipeline] = await sql`
    SELECT COUNT(*) as cnt FROM companies
    WHERE status IN ('idea','approved','provisioning','mvp','active')
  `;
  const [pendingIdeas] = await sql`
    SELECT COUNT(*) as cnt FROM companies WHERE status = 'idea'
  `;
  const pipelineLow = parseInt(pipeline.cnt) < 3 && parseInt(pendingIdeas.cnt) === 0;

  // 2. Stale content (no growth success in 7 days)
  const staleContent = await sql`
    SELECT c.slug FROM companies c
    WHERE c.status IN ('mvp','active')
    AND NOT EXISTS (
      SELECT 1 FROM agent_actions aa
      WHERE aa.company_id = c.id AND aa.agent = 'growth'
      AND aa.status = 'success' AND aa.finished_at > NOW() - INTERVAL '7 days'
    )
  `;

  // 3. Stale leads (lead_list >5 days, no outreach)
  const staleLeads = await sql`
    SELECT c.slug FROM companies c
    WHERE c.status IN ('mvp','active')
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
    WHERE c.status IN ('mvp','active')
    AND NOT EXISTS (
      SELECT 1 FROM agent_actions aa
      WHERE aa.company_id = c.id AND aa.agent = 'ceo'
      AND aa.status = 'success' AND aa.finished_at > NOW() - INTERVAL '48 hours'
    )
  `;

  // 5. Unverified deploys in 24h
  const unverifiedDeploys = await sql`
    SELECT c.slug FROM companies c
    WHERE c.status IN ('mvp','active')
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
  const [failureStats] = await sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'failed') as failed,
      COUNT(*) as total
    FROM agent_actions
    WHERE finished_at > NOW() - INTERVAL '48 hours'
  `;
  const failRate = parseInt(failureStats.total) > 0
    ? parseInt(failureStats.failed) / parseInt(failureStats.total)
    : 0;
  const highFailureRate = failRate > 0.2 && parseInt(failureStats.total) >= 5;

  // 8. Stale research (no research in 14 days)
  const staleResearch = await sql`
    SELECT c.slug FROM companies c
    WHERE c.status IN ('mvp','active')
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
    SELECT aa.agent as source_agent, c.slug
    FROM agent_actions aa
    JOIN companies c ON c.id = aa.company_id
    WHERE aa.status = 'success' AND aa.agent = 'ceo'
    AND aa.output::text ILIKE '%needs_feature%true%'
    AND aa.finished_at > NOW() - INTERVAL '48 hours'
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

  // 13. Companies needing new cycle (no cycle in 24h)
  const needsCycle = await sql`
    SELECT c.slug, c.id as company_id FROM companies c
    WHERE c.status IN ('mvp', 'active')
    AND EXISTS (SELECT 1 FROM infra i WHERE i.company_id = c.id)
    AND NOT EXISTS (
      SELECT 1 FROM cycles cy
      WHERE cy.company_id = c.id
      AND cy.status IN ('running', 'completed')
      AND cy.started_at > NOW() - INTERVAL '24 hours'
    )
  `;

  // 13b. Stuck cycles (running >2h, auto-cleanup)
  const stuckCycles = await sql`
    UPDATE cycles
    SET status = 'failed',
        finished_at = NOW(),
        ceo_review = jsonb_build_object('timeout_reason', 'Cycle stuck in running state >2h, cleaned up by Sentinel')
    WHERE status = 'running' AND started_at < NOW() - INTERVAL '2 hours'
    RETURNING cycle_number, company_id
  `;

  // 14. Rate-limited agents (0 turns)
  const rateLimited = await sql`
    SELECT aa.agent, aa.action_type, aa.company_id, c.slug
    FROM agent_actions aa
    LEFT JOIN companies c ON c.id = aa.company_id
    WHERE aa.status = 'failed'
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
    WHERE c.status IN ('mvp', 'active')
    AND NOT EXISTS (
      SELECT 1 FROM metrics m
      WHERE m.company_id = c.id AND m.date > CURRENT_DATE - INTERVAL '2 days'
    )
  `;

  // --- Dispatch logic ---

  // 1. Pipeline low → Scout
  if (pipelineLow) {
    await dispatchToActions("pipeline_low", { source: "sentinel" });
    dispatches.push({ type: "brain", target: "pipeline_low", payload: { source: "sentinel" } });
  }

  // 2. Stale content → Growth worker
  for (const r of staleContent) {
    await dispatchToWorker("growth", r.slug, "sentinel_stale_content");
    dispatches.push({ type: "worker", target: "growth", payload: { company: r.slug } });
  }

  // 3. Stale leads → Outreach worker
  for (const r of staleLeads) {
    await dispatchToWorker("outreach", r.slug, "sentinel_stale_leads");
    dispatches.push({ type: "worker", target: "outreach", payload: { company: r.slug } });
  }

  // 4. No CEO review → CEO brain
  if (noCeoReview.length > 0) {
    const slug = noCeoReview[0].slug;
    await dispatchToActions("ceo_review", { source: "sentinel", company: slug });
    dispatches.push({ type: "brain", target: "ceo_review", payload: { company: slug } });
  }

  // 5. Unverified deploys → Ops worker
  for (const r of unverifiedDeploys) {
    await dispatchToWorker("ops", r.slug, "sentinel_unverified_deploy");
    dispatches.push({ type: "worker", target: "health_check", payload: { company: r.slug } });
  }

  // 6. Evolve due → Evolver brain
  if (evolveDue) {
    await dispatchToActions("evolve_trigger", { source: "sentinel" });
    dispatches.push({ type: "brain", target: "evolve_trigger", payload: { source: "sentinel" } });
  }

  // 7. High failure rate → Evolver brain (urgent)
  if (highFailureRate) {
    await dispatchToActions("evolve_trigger", { source: "sentinel", reason: "high_failure_rate" });
    dispatches.push({ type: "brain", target: "evolve_trigger", payload: { reason: "high_failure_rate" } });
  }

  // 8. Stale research → Scout research refresh
  if (staleResearch.length > 0) {
    const slug = staleResearch[0].slug;
    await dispatchToActions("research_request", { source: "sentinel", company: slug });
    dispatches.push({ type: "brain", target: "research_request", payload: { company: slug } });
  }

  // 9. Stuck approved → provision via Engineer
  for (const r of stuckApproved) {
    await dispatchToActions("new_company", { source: "sentinel", company: r.slug });
    dispatches.push({ type: "brain", target: "new_company", payload: { company: r.slug } });
  }

  // 9b. Orphaned MVPs → re-provision
  for (const r of orphanedMvps) {
    await dispatchToActions("new_company", { source: "sentinel", company: r.slug, reason: "orphaned_mvp" });
    dispatches.push({ type: "brain", target: "new_company", payload: { company: r.slug, reason: "orphaned_mvp" } });
  }

  // 10. Max turns exhaustion → Evolver
  if (maxTurnsHits.length > 0) {
    const agents = maxTurnsHits.map((r) => ({
      agent: r.agent as string,
      count: parseInt(r.cnt as string),
    }));
    await dispatchToActions("evolve_trigger", { source: "sentinel", reason: "max_turns_exhaustion", agents });
    dispatches.push({ type: "brain", target: "evolve_trigger", payload: { reason: "max_turns_exhaustion", agents } });
  }

  // 11. Chain dispatch gaps → re-dispatch engineer
  for (const r of chainGaps) {
    await dispatchToActions("feature_request", { source: "sentinel_recovery", company: r.slug });
    dispatches.push({ type: "brain", target: "feature_request", payload: { company: r.slug } });
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
    });
    dispatches.push({ type: "brain", target: "research_request", payload: { company: r.slug, reason: "stalled" } });
  }

  // 13. Companies needing new cycle (max 2 per run)
  for (const r of needsCycle) {
    if (cycleDispatches >= MAX_CYCLE_DISPATCHES) break;
    await dispatchToActions("research_request", {
      source: "sentinel_cycle",
      company: r.slug,
      company_id: r.company_id,
      chain_to_ceo: true,
    });
    dispatches.push({ type: "brain", target: "cycle_start", payload: { company: r.slug } });
    cycleDispatches++;
  }

  // 14. Rate-limited agents → re-dispatch
  for (const r of rateLimited) {
    let eventType = "feature_request";
    if (r.agent === "engineer" && ["scaffold_company", "provision_company"].includes(r.action_type)) {
      eventType = "new_company";
    } else if (r.agent === "scout") {
      eventType = "research_request";
    } else if (r.agent === "ceo") {
      eventType = "cycle_start";
    }
    await dispatchToActions(eventType, {
      source: "sentinel_retry",
      company: r.slug,
      company_id: r.company_id,
    });
    dispatches.push({ type: "brain", target: eventType, payload: { company: r.slug, reason: "rate_limited_retry" } });
  }

  // 15. Unverified provisions → HTTP check
  for (const r of unverifiedProvisions) {
    if (r.vercel_url) {
      try {
        const res = await fetch(r.vercel_url, {
          redirect: "follow",
          signal: AbortSignal.timeout(10000),
        });
        if (res.status >= 400) {
          await dispatchToActions("ops_escalation", {
            source: "sentinel",
            company: r.slug,
            reason: "post_provision_deploy_broken",
            http_status: res.status,
          });
          dispatches.push({ type: "brain", target: "ops_escalation", payload: { company: r.slug, status: res.status } });
        }
      } catch {
        await dispatchToActions("ops_escalation", {
          source: "sentinel",
          company: r.slug,
          reason: "post_provision_deploy_broken",
          http_status: 0,
        });
        dispatches.push({ type: "brain", target: "ops_escalation", payload: { company: r.slug, status: 0 } });
      }
    } else {
      await dispatchToActions("new_company", {
        source: "sentinel",
        company: r.slug,
        company_id: r.company_id,
        reason: "missing_url",
      });
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

  // --- HTTP health checks (parallel) ---
  const companiesWithUrls = await sql`
    SELECT slug, vercel_url FROM companies
    WHERE status IN ('mvp', 'active') AND vercel_url IS NOT NULL
  `;
  const brokenDeploys = await checkHttpHealth(
    companiesWithUrls.map((r) => ({ slug: r.slug as string, vercel_url: r.vercel_url as string }))
  );
  for (const b of brokenDeploys) {
    await dispatchToActions("ops_escalation", {
      source: "sentinel",
      company: b.slug,
      reason: "deploy_broken",
      http_status: b.status,
    });
    dispatches.push({ type: "brain", target: "ops_escalation", payload: { company: b.slug, http_status: b.status } });
  }

  // --- Deploy drift check ---
  const drift = await checkDeployDrift(vercelToken);
  if (drift.drifted) {
    await dispatchToActions("deploy_drift", {
      source: "sentinel",
      main_sha: drift.mainSha,
      deploy_sha: drift.deploySha,
    });
    dispatches.push({ type: "brain", target: "deploy_drift", payload: { main: drift.mainSha, deployed: drift.deploySha } });
  }

  return Response.json({
    ok: true,
    dispatches: dispatches.length,
    stuck_cycles_cleaned: stuckCycles.length,
    deploy_drift: drift.drifted,
    broken_deploys: brokenDeploys.length,
    details: dispatches,
  });
}
