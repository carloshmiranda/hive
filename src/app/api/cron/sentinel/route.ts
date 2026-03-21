import { getDb } from "@/lib/db";
import { getSettingValue } from "@/lib/settings";
import { getBoilerplateGaps } from "@/lib/capabilities";
import boilerplateManifest from "../../../../../templates/boilerplate-manifest.json";

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

async function dispatchToCompanyWorkflow(
  githubRepo: string,
  workflow: string,
  inputs: Record<string, string>
) {
  const ghPat = process.env.GH_PAT;
  if (!ghPat) return;
  await fetch(`https://api.github.com/repos/${githubRepo}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `token ${ghPat}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: "main", inputs }),
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
  // NOTE: Many checks below query companies with status IN ('mvp','active').
  // Companies without infra (github_repo IS NULL) should be EXCLUDED from dispatch-triggering
  // checks. Only check 9b (orphaned MVPs) intentionally includes them to trigger provisioning.

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

  // 13c. Failed agent tasks with unfinished CEO plan work — re-dispatch
  // When Engineer/Growth fails, the tasks from ceo_plan are lost. Detect and retry.
  const failedWithPlanWork = await sql`
    SELECT DISTINCT aa.agent, aa.action_type, aa.company_id, c.slug, c.github_repo
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
    });
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
        });
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
    });
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
    });
    dispatches.push({ type: "brain", target: "ceo_task_backlog", payload: { company: co.slug } });
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
    // Log as escalation — don't dispatch more agents (that would feed the loop)
    for (const r of dispatchLoops) {
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
    dispatches.push({ type: "escalation", target: "dispatch_loop", payload: { loops: loopDetails } });
  }

  // --- Dispatch logic ---

  // 1. Pipeline low → Scout
  if (pipelineLow) {
    await dispatchToActions("pipeline_low", { source: "sentinel" });
    dispatches.push({ type: "brain", target: "pipeline_low", payload: { source: "sentinel" } });
  }

  // 2. Stale content → Growth on company repo (free Actions) with Vercel fallback
  for (const r of staleContent) {
    if (r.github_repo) {
      try {
        await dispatchToCompanyWorkflow(r.github_repo, "hive-growth.yml", {
          company_slug: r.slug,
          trigger: "sentinel_stale_content",
          task_summary: `Content refresh for ${r.slug}`,
        });
        dispatches.push({ type: "company_actions", target: "growth", payload: { company: r.slug, repo: r.github_repo } });
        continue;
      } catch {
        // Fall through to Vercel serverless
      }
    }
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

  // 7. High failure rate → Evolver brain (urgent) + Healer (fix code)
  if (highFailureRate) {
    await dispatchToActions("evolve_trigger", { source: "sentinel", reason: "high_failure_rate" });
    dispatches.push({ type: "brain", target: "evolve_trigger", payload: { reason: "high_failure_rate" } });
    // Healer fixes code, Evolver proposes process improvements — both run
    await dispatchToActions("healer_trigger", { source: "sentinel", scope: "systemic", reason: "high_failure_rate" });
    dispatches.push({ type: "brain", target: "healer_trigger", payload: { reason: "high_failure_rate" } });
  }

  // 7b. Errors exist but below 20% threshold → Healer only (no Evolver)
  if (!highFailureRate && parseInt(failureStats.failed) >= 3) {
    // Check that Healer hasn't already run in last 24h
    const [lastHeal] = await sql`
      SELECT MAX(finished_at) as last_run FROM agent_actions
      WHERE agent = 'healer' AND finished_at > NOW() - INTERVAL '24 hours'
    `;
    if (!lastHeal?.last_run) {
      await dispatchToActions("healer_trigger", { source: "sentinel", scope: "systemic", reason: "errors_detected" });
      dispatches.push({ type: "brain", target: "healer_trigger", payload: { reason: "errors_detected" } });
    }
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

  // 13c. Failed agent tasks → re-dispatch directly to company repo (free Actions)
  for (const r of failedWithPlanWork) {
    if (r.github_repo && r.agent === "engineer") {
      await dispatchToCompanyWorkflow(r.github_repo as string, "hive-build.yml", {
        company_slug: r.slug as string,
        trigger: "feature_request",
        task_summary: "Retry — previous build failed",
      });
      dispatches.push({ type: "company_actions", target: "feature_request", payload: { company: r.slug, reason: "failed_task_recovery" } });
    } else if (r.github_repo && r.agent === "growth") {
      await dispatchToCompanyWorkflow(r.github_repo as string, "hive-growth.yml", {
        company_slug: r.slug as string,
        trigger: "sentinel_retry",
        task_summary: "Retry — previous growth run failed",
      });
      dispatches.push({ type: "company_actions", target: "growth", payload: { company: r.slug, reason: "failed_task_recovery" } });
    } else {
      // Fallback to Hive repo dispatch if no company repo
      const eventType = r.agent === "engineer" ? "feature_request" : "growth_trigger";
      await dispatchToActions(eventType, {
        source: "sentinel_retry",
        company: r.slug,
        company_id: r.company_id,
        reason: "failed_task_recovery",
      });
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
    await dispatchToActions("evolve_trigger", { source: "sentinel", reason: "max_turns_exhaustion", agents });
    dispatches.push({ type: "brain", target: "evolve_trigger", payload: { reason: "max_turns_exhaustion", agents } });
  }

  // 11. Chain dispatch gaps → dispatch directly to company repo (free Actions)
  for (const r of chainGaps) {
    if (r.github_repo) {
      await dispatchToCompanyWorkflow(r.github_repo as string, "hive-build.yml", {
        company_slug: r.slug as string,
        trigger: "feature_request",
        task_summary: "Chain gap recovery — CEO planned features not yet built",
      });
      dispatches.push({ type: "company_actions", target: "feature_request", payload: { company: r.slug, repo: r.github_repo } });
    } else {
      await dispatchToActions("feature_request", { source: "sentinel_recovery", company: r.slug });
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

  // 14. Rate-limited agents → re-dispatch (company-scoped work goes direct to company repo)
  for (const r of rateLimited) {
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
      });
      dispatches.push({ type: "company_actions", target: "feature_request", payload: { company: r.slug, reason: "rate_limited_retry" } });
    } else {
      // Brain agents (CEO, Scout, provision) must stay on Hive repo
      await dispatchToActions(eventType, {
        source: "sentinel_retry",
        company: r.slug,
        company_id: r.company_id,
      });
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
            });
            dispatches.push({ type: "company_actions", target: "ops_escalation", payload: { company: r.slug, status: res.status } });
          } else {
            await dispatchToActions("ops_escalation", {
              source: "sentinel",
              company: r.slug,
              reason: "post_provision_deploy_broken",
              http_status: res.status,
            });
            dispatches.push({ type: "brain", target: "ops_escalation", payload: { company: r.slug, status: res.status } });
          }
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
    WHERE status IN ('mvp', 'active') AND vercel_url IS NOT NULL AND github_repo IS NOT NULL
  `;
  const brokenDeploys = await checkHttpHealth(
    companiesWithUrls.map((r) => ({ slug: r.slug as string, vercel_url: r.vercel_url as string }))
  );
  for (const b of brokenDeploys) {
    // Dispatch fix directly to company repo (free Actions)
    const [co] = await sql`SELECT github_repo FROM companies WHERE slug = ${b.slug} LIMIT 1`;
    if (co?.github_repo) {
      await dispatchToCompanyWorkflow(co.github_repo as string, "hive-fix.yml", {
        company_slug: b.slug,
        error_summary: `Deploy broken (HTTP ${b.status})`,
        source: "sentinel",
      });
      dispatches.push({ type: "company_actions", target: "ops_escalation", payload: { company: b.slug, http_status: b.status } });
    } else {
      await dispatchToActions("ops_escalation", {
        source: "sentinel",
        company: b.slug,
        reason: "deploy_broken",
        http_status: b.status,
      });
      dispatches.push({ type: "brain", target: "ops_escalation", payload: { company: b.slug, http_status: b.status } });
    }
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
    anomalies_detected: anomalies.length,
    details: dispatches,
  });
}
