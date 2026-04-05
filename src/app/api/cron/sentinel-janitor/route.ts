/**
 * Sentinel Janitor — ADR-031 Phase 2
 *
 * Runs daily at 2am UTC. Handles maintenance, intelligence gathering,
 * playbook management, and self-improvement checks that don't need
 * to run frequently.
 *
 * Checks extracted from the monolithic sentinel/route.ts:
 *  6  — Evolver staleness (>10 cycles since last evolve)
 *  8  — Stale research dispatch
 * 10  — Max turns exhaustion detection
 * 17  — Dispatch loop detection
 * 19  — Evolver staleness with success rate drop
 * 20  — Boilerplate migration check
 * 21  — Missing product spec
 * 22  — Empty task backlog
 * 23  — Auto-assess companies
 * 24  — Schema drift detection
 * 25  — Recurring escalation auto-resolve
 * 26  — Auto-dismiss resolved escalations
 * 26e — Auto-approve safe evolver proposals
 * 27  — Playbook decay/prune
 * 28  — Venture Brain (cross-pollination, score trends, error correlation)
 * 29  — Playbook consolidation
 * 34  — Agent performance regression detection
 * 35  — Error pattern learning from successful fixes
 * 37  — Self-improvement proposals
 * 39  — Auto-decompose blocked backlog items
 * 42  — Evolver proposal completion tracking
 * 46  — Close decomposed parents when all sub-tasks done
 * 48  — Database performance monitoring (pg_stat_statements + cache hit ratio)
 *      Self-improvement routing (approved proposals -> backlog)
 *      Telegram notification + BACKLOG.md regeneration
 */

import { getBoilerplateGaps } from "@/lib/capabilities";
import { SCHEMA_MAP, getExpectedTables } from "@/lib/schema-map";
import { findCapabilityForProblem } from "@/lib/hive-capabilities";
import { normalizeError, errorSimilarity } from "@/lib/error-normalize";
import boilerplateManifest from "../../../../../templates/boilerplate-manifest.json";
import {
  initSentinelContext,
  dispatchToActions,
  isCircuitOpen,
  jaccardSimilarity,
  REPO,
  type SentinelContext,
  type Dispatch,
} from "@/lib/sentinel-helpers";
import { setSentryTags } from "@/lib/sentry-tags";
import { normalizePlaybookDomain } from "@/lib/playbook-domains";
import { getSettingValue } from "@/lib/settings";
import { isCompanySpecific } from "@/lib/backlog-planner";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  setSentryTags({
    action_type: "cron",
    route: "/api/cron/sentinel-janitor",
  });

  let ctx: SentinelContext;
  try {
    ctx = await initSentinelContext(request, "sentinel-janitor");
  } catch (authErr: any) {
    return Response.json({ error: authErr.message || "Unauthorized" }, { status: 401 });
  }

  try {
    const sql = ctx.sql;
    const ghPat = ctx.ghPat;
    const baseUrl = ctx.baseUrl;
    const cronSecret = ctx.cronSecret;
    const traceId = ctx.traceId;
    const dispatches = ctx.dispatches;

    // -----------------------------------------------------------------------
    // Check 6: Evolver staleness (>10 cycles since last evolve)
    // -----------------------------------------------------------------------
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

    // -----------------------------------------------------------------------
    // Check 10: Max turns exhaustion detection
    // -----------------------------------------------------------------------
    const maxTurnsHits = await sql`
      SELECT agent, COUNT(*) as cnt
      FROM agent_actions
      WHERE status = 'failed' AND error ILIKE '%max_turns%'
      AND finished_at > NOW() - INTERVAL '48 hours'
      GROUP BY agent HAVING COUNT(*) >= 2
    `;

    // -----------------------------------------------------------------------
    // Check 7 (partial): High failure rate >20% in 48h (used by check 19)
    // -----------------------------------------------------------------------
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

    // -----------------------------------------------------------------------
    // Check 19: Evolver staleness with success rate drop
    // -----------------------------------------------------------------------
    const evolverNeeded = evolveDue || highFailureRate || maxTurnsHits.length > 0;
    if (!evolverNeeded) {
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
      if (priorRate - recentRate > 0.15 && parseInt(recentStats.t) >= 10) {
        const [lastEvolverRun] = await sql`
          SELECT MAX(finished_at) as last_run FROM agent_actions
          WHERE agent = 'evolver' AND finished_at > NOW() - INTERVAL '48 hours'
        `;
        if (!lastEvolverRun?.last_run) {
          await dispatchToActions(ctx, "evolve_trigger", {
            source: "sentinel-janitor",
            reason: "success_rate_drop",
            recent_rate: Math.round(recentRate * 100),
            prior_rate: Math.round(priorRate * 100),
            trace_id: traceId,
          });
          dispatches.push({
            type: "brain",
            target: "evolve_trigger",
            payload: { reason: "success_rate_drop", recent: Math.round(recentRate * 100), prior: Math.round(priorRate * 100) },
          });
        }
      }
    }

    // Dispatch evolver if due and not recently run (6 + 10)
    const [lastEvolverDispatch] = await sql`
      SELECT MAX(started_at) as last_run FROM agent_actions
      WHERE agent = 'evolver' AND started_at > NOW() - INTERVAL '48 hours'
    `;
    if (evolveDue && !lastEvolverDispatch?.last_run) {
      await dispatchToActions(ctx, "evolve_trigger", { source: "sentinel-janitor", trace_id: traceId });
      dispatches.push({ type: "brain", target: "evolve_trigger", payload: { source: "sentinel-janitor" } });
    }
    // Check max turns exhaustion but respect the same 48h dedup window
    if (maxTurnsHits.length > 0 && !lastEvolverDispatch?.last_run) {
      const agents = maxTurnsHits.map((r) => ({
        agent: r.agent as string,
        count: parseInt(r.cnt as string),
      }));
      await dispatchToActions(ctx, "evolve_trigger", { source: "sentinel-janitor", reason: "max_turns_exhaustion", agents, trace_id: traceId });
      dispatches.push({ type: "brain", target: "evolve_trigger", payload: { reason: "max_turns_exhaustion", agents } });
    }

    // -----------------------------------------------------------------------
    // Check 8: Stale research dispatch (companies without research >14 days)
    // -----------------------------------------------------------------------
    const staleResearch = await sql`
      SELECT c.slug FROM companies c
      WHERE c.status IN ('mvp','active') AND c.github_repo IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM research_reports rr
        WHERE rr.company_id = c.id AND rr.updated_at > NOW() - INTERVAL '14 days'
      )
    `;
    if (staleResearch.length > 0) {
      const slug = staleResearch[0].slug;
      await dispatchToActions(ctx, "research_request", { source: "sentinel-janitor", company: slug, trace_id: traceId });
      dispatches.push({ type: "brain", target: "research_request", payload: { company: slug } });
    }

    // -----------------------------------------------------------------------
    // Check 17: Dispatch loop detection (>5 same-agent actions in 30 min)
    // -----------------------------------------------------------------------
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
              ${JSON.stringify({ agent: r.agent, company: r.slug, count: parseInt(r.cnt), detected_by: "sentinel-janitor" })}::jsonb
            )
            ON CONFLICT DO NOTHING
          `;
        }
      }
      dispatches.push({ type: "escalation", target: "dispatch_loop", payload: { loops: loopDetails } });
    }

    // -----------------------------------------------------------------------
    // Check 20: Boilerplate migration detection
    // -----------------------------------------------------------------------
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

      const [existingApproval] = await sql`
        SELECT id FROM approvals
        WHERE company_id = ${co.id}
          AND gate_type = 'capability_migration'
          AND status IN ('pending', 'approved')
        LIMIT 1
      `;
      if (existingApproval) continue;

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

    // -----------------------------------------------------------------------
    // Check 21: Missing product spec
    // -----------------------------------------------------------------------
    const companiesMissingSpec = await sql`
      SELECT c.id, c.slug FROM companies c
      WHERE c.status IN ('mvp', 'active')
      AND c.github_repo IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM research_reports rr
        WHERE rr.company_id = c.id AND rr.report_type = 'product_spec'
      )
    `;
    for (const co of companiesMissingSpec) {
      const [recent] = await sql`
        SELECT id FROM agent_actions
        WHERE company_id = ${co.id} AND agent = 'ceo'
        AND action_type = 'product_spec_generation'
        AND started_at > NOW() - INTERVAL '24 hours'
        LIMIT 1
      `;
      if (recent) continue;

      await dispatchToActions(ctx, "cycle_start", {
        source: "sentinel-janitor",
        company: co.slug,
        directive: "Generate product_spec with mission, what_we_build, and vision. Use existing market_research and competitive_analysis reports as input. This is priority 1 for this cycle.",
        trace_id: traceId,
      });
      dispatches.push({ type: "brain", target: "ceo_product_spec", payload: { company: co.slug } });
    }

    // -----------------------------------------------------------------------
    // Check 22: Empty task backlog
    // -----------------------------------------------------------------------
    const companiesNoTasks = await sql`
      SELECT c.id, c.slug FROM companies c
      WHERE c.status IN ('mvp', 'active')
      AND c.github_repo IS NOT NULL
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

      await dispatchToActions(ctx, "cycle_start", {
        source: "sentinel-janitor",
        company: co.slug,
        directive: "Generate task backlog with proposed_tasks. Include 5-10 tasks across engineering, growth, research, qa, and ops categories based on company lifecycle stage.",
        trace_id: traceId,
      });
      dispatches.push({ type: "brain", target: "ceo_task_backlog", payload: { company: co.slug } });
    }

    // -----------------------------------------------------------------------
    // Check 23: Auto-assess companies
    // -----------------------------------------------------------------------
    const unassessedCompanies = await sql`
      SELECT c.id, c.slug FROM companies c
      WHERE c.status IN ('mvp', 'active') AND c.github_repo IS NOT NULL
      AND (c.last_assessed_at IS NULL OR c.last_assessed_at < NOW() - INTERVAL '7 days')
    `;
    for (const co of unassessedCompanies) {
      try {
        await fetch(`${baseUrl}/api/companies/${co.id}/assess`, {
          method: "POST",
          headers: {
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
        // Non-blocking — assessment will retry next run
      }
    }

    // -----------------------------------------------------------------------
    // Check 24: Schema drift detection
    // -----------------------------------------------------------------------
    const schemaDrift: Array<{ table: string; issue: string }> = [];
    try {
      const expected = getExpectedTables();
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
        for (const liveCol of liveColNames) {
          if (!SCHEMA_MAP[table].columns[liveCol]) {
            schemaDrift.push({ table, issue: `Column '${table}.${liveCol}' exists in DB but not in schema map — update schema.sql` });
          }
        }
      }

      if (schemaDrift.length > 0) {
        console.warn(`Schema drift detected (${schemaDrift.length} issues):`, schemaDrift);

        const currentDriftHash = JSON.stringify(schemaDrift.map(d => `${d.table}:${d.issue}`).sort());
        const lastDriftCheck = await sql`
          SELECT error FROM agent_actions
          WHERE agent = 'sentinel' AND action_type = 'schema_drift_check'
          AND started_at > NOW() - INTERVAL '6 hours'
          ORDER BY started_at DESC
          LIMIT 1
        `;

        let shouldLogFailure = true;
        if (lastDriftCheck.length > 0) {
          try {
            const lastDrift = JSON.parse(lastDriftCheck[0].error);
            const lastDriftHash = JSON.stringify(lastDrift.map((d: any) => `${d.table}:${d.issue}`).sort());
            if (currentDriftHash === lastDriftHash) {
              console.log('Schema drift deduplication: same issues as last run, skipping log');
              shouldLogFailure = false;
            }
          } catch (e) {
            console.log('Could not parse last drift check for deduplication, logging anyway');
          }
        }

        if (shouldLogFailure) {
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
        }

        if (shouldLogFailure && schemaDrift.length >= 3) {
          await dispatchToActions(ctx, "healer_trigger", {
            source: "sentinel-janitor",
            error_class: "schema_mismatch",
            drift: schemaDrift,
            trace_id: traceId,
          });
          dispatches.push({ type: "brain", target: "healer_trigger", payload: { error_class: "schema_mismatch", count: schemaDrift.length } });
        }
      }
    } catch (e: any) {
      console.warn("Schema drift check failed (non-blocking):", e.message);
    }

    // -----------------------------------------------------------------------
    // Check 25: Recurring escalation auto-resolve
    // -----------------------------------------------------------------------
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
    const SKIP_AUTO_RESOLVE = ["capability_migration", "escalation", "ops_escalation", "new_company", "kill_company"];
    for (const esc of recurringEscalations) {
      if (SKIP_AUTO_RESOLVE.includes(esc.gate_type as string)) continue;

      const [retryCount] = await sql`
        SELECT COUNT(*)::int as attempts
        FROM agent_actions
        WHERE company_id = ${esc.company_id}
          AND agent = 'sentinel'
          AND action_type = 'auto_resolve_escalation'
          AND status IN ('failed', 'success', 'skipped')
          AND started_at > NOW() - INTERVAL '48 hours'
      `;

      if (retryCount && retryCount.attempts >= 3) {
        const [alreadySkipped] = await sql`
          SELECT 1 FROM agent_actions
          WHERE company_id = ${esc.company_id}
            AND agent = 'sentinel'
            AND action_type = 'auto_resolve_escalation'
            AND status = 'skipped'
            AND started_at > NOW() - INTERVAL '48 hours'
          LIMIT 1
        `;
        if (!alreadySkipped) {
          await sql`
            INSERT INTO agent_actions (company_id, agent, action_type, description, status, output, started_at, finished_at)
            VALUES (
              ${esc.company_id}, 'sentinel', 'auto_resolve_escalation',
              ${`Skipped auto-resolve for ${esc.gate_type} on ${esc.slug} - max attempts (3) exceeded in 48h`},
              'skipped',
              ${JSON.stringify({ reason: 'max_attempts_exceeded', attempts: retryCount.attempts, gate_type: esc.gate_type })}::jsonb,
              NOW(), NOW()
            )
          `;
        }
        continue;
      }

      const description = (esc.latest_description as string) || "";
      const capability = findCapabilityForProblem(description);

      if (capability) {
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

    // -----------------------------------------------------------------------
    // Check 26: Auto-dismiss resolved escalations
    // -----------------------------------------------------------------------
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
          if (recentCount < 3) {
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

            if (successRate >= 0.4) {
              shouldDismiss = true;
              dismissReason = `Agent performance recovered: ${agent} now at ${Math.round(successRate * 100)}% success rate (${successes}/${total} in 7d)`;
            }
          }
        }

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

    // -----------------------------------------------------------------------
    // Check 42: Mark evolver proposals as implemented when backlog items complete
    // -----------------------------------------------------------------------
    let evolverProposalsMarked = 0;
    try {
      const completedEvolverBacklog = await sql`
        SELECT
          hb.id as backlog_id,
          hb.title,
          hb.source,
          hb.completed_at,
          hb.status,
          CAST(REGEXP_REPLACE(hb.description, '.*evolver proposal ([0-9a-f-]+).*', '\\1', 'i') AS UUID) as evolver_proposal_id
        FROM hive_backlog hb
        WHERE hb.status = 'done'
          AND hb.source LIKE '%evolver%'
          AND hb.description ~ 'evolver proposal [0-9a-f-]+'
          AND hb.completed_at > NOW() - INTERVAL '7 days'
          AND EXISTS (
            SELECT 1 FROM evolver_proposals ep
            WHERE ep.id = CAST(REGEXP_REPLACE(hb.description, '.*evolver proposal ([0-9a-f-]+).*', '\\1', 'i') AS UUID)
              AND ep.status = 'approved'
              AND ep.implemented_at IS NULL
          )
        ORDER BY hb.completed_at DESC
        LIMIT 10
      `;

      for (const item of completedEvolverBacklog) {
        try {
          await sql`
            UPDATE evolver_proposals
            SET implemented_at = NOW(),
                status = 'implemented',
                notes = COALESCE(notes, '') || ${` | [Step 5] Backlog item #${item.backlog_id} completed at ${item.completed_at}`}
            WHERE id = ${item.evolver_proposal_id}
              AND status = 'approved'
              AND implemented_at IS NULL
          `;

          evolverProposalsMarked++;
          console.log(`[sentinel-janitor] Check 42: Marked evolver proposal ${item.evolver_proposal_id} as implemented (backlog item: "${item.title?.slice(0, 60)}")`);
        } catch (proposalUpdateErr: any) {
          console.warn(`[sentinel-janitor] Check 42: Failed to mark evolver proposal ${item.evolver_proposal_id} as implemented: ${proposalUpdateErr.message}`);
        }
      }

      if (evolverProposalsMarked > 0) {
        await sql`
          INSERT INTO agent_actions (agent, action_type, description, status, started_at, finished_at)
          VALUES (
            'sentinel',
            'evolver_proposal_completion',
            ${`Check 42: Marked ${evolverProposalsMarked} approved evolver proposals as implemented after backlog completion`},
            'success',
            NOW(),
            NOW()
          )
        `.catch(() => {});
      }
    } catch (check42Err: any) {
      console.warn(`[sentinel-janitor] Check 42 failed: ${check42Err.message}`);
    }

    // -----------------------------------------------------------------------
    // Check 26 evolver: Auto-approve safe evolver proposals
    // -----------------------------------------------------------------------
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

    // -----------------------------------------------------------------------
    // Self-improvement routing: Route approved proposals to backlog
    // -----------------------------------------------------------------------
    const approvedSelfImprovements = await sql`
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
    for (const imp of approvedSelfImprovements) {
      const [existing] = await sql`
        SELECT id FROM hive_backlog
        WHERE title ILIKE ${(imp.title as string).slice(0, 50) + "%"}
          AND status NOT IN ('done', 'rejected')
        LIMIT 1
      `.catch(() => []);
      if (existing) continue;

      const priority = imp.severity === "critical" ? "P0" : imp.severity === "high" ? "P1" : "P2";
      const impDescription = `Diagnosis: ${imp.diagnosis}\n\nProposed fix: ${typeof imp.proposed_fix === 'string' ? imp.proposed_fix : JSON.stringify(imp.proposed_fix)}`;
      // Skip company-specific proposals — they belong in the company's task backlog, not hive_backlog
      if (await isCompanySpecific(imp.title as string, impDescription, sql).catch(() => false)) continue;
      await sql`
        INSERT INTO hive_backlog (title, description, priority, category, status)
        VALUES (
          ${(imp.title as string).slice(0, 200)},
          ${impDescription.slice(0, 2000)},
          ${priority}, 'infra', 'ready'
        )
      `.catch(() => {});
      await sql`
        UPDATE evolver_proposals SET implemented_at = NOW(),
          notes = COALESCE(notes, '') || ' | Routed to hive_backlog for planning + dispatch'
        WHERE id = ${imp.id}
      `;
      dispatches.push({ type: "self_improvement", target: "backlog", payload: { proposal_id: imp.id, title: imp.title, routed: "backlog" } });
    }

    // Check for approved prompt_update proposals that haven't been implemented
    const approvedPromptUpdates = await sql`
      SELECT id, title, proposed_fix
      FROM evolver_proposals
      WHERE status = 'approved'
        AND implemented_at IS NULL
        AND proposed_fix->>'type' = 'prompt_update'
        AND reviewed_at > NOW() - INTERVAL '14 days'
      LIMIT 5
    `;

    for (const prompt of approvedPromptUpdates) {
      try {
        const targetAgent = prompt.proposed_fix?.target;
        if (targetAgent) {
          await sql`
            UPDATE agent_prompts SET is_active = false WHERE agent = ${targetAgent} AND is_active = true
          `;
          await sql`
            UPDATE agent_prompts SET is_active = true
            WHERE agent = ${targetAgent}
            AND id = (SELECT id FROM agent_prompts WHERE agent = ${targetAgent} ORDER BY version DESC LIMIT 1)
          `;
        }
        await sql`UPDATE evolver_proposals SET status = 'implemented', implemented_at = NOW() WHERE id = ${prompt.id}`;
        dispatches.push({ type: "prompt_update", target: targetAgent || "unknown", payload: { proposal_id: prompt.id, title: prompt.title, activated: true } });
      } catch (e) {
        console.error(`Failed to activate prompt for proposal ${prompt.id}:`, e);
      }
    }

    // Check for approved proposals that need routing through hive_backlog
    const approvedImplementationProposals = await sql`
      SELECT id, title, diagnosis, proposed_fix, severity, gap_type
      FROM evolver_proposals
      WHERE status = 'approved'
        AND implemented_at IS NULL
        AND (
          proposed_fix->>'type' = 'setup_action'
          OR proposed_fix->>'type' = 'knowledge_gap'
          OR (gap_type IN ('capability', 'outcome') AND signal_source = 'sentinel_self_improvement')
        )
        AND reviewed_at > NOW() - INTERVAL '14 days'
      ORDER BY
        CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
      LIMIT 5
    `;

    for (const proposal of approvedImplementationProposals) {
      const [existing] = await sql`
        SELECT id FROM hive_backlog
        WHERE title ILIKE ${(proposal.title as string).slice(0, 50) + "%"}
          AND status NOT IN ('done', 'rejected')
        LIMIT 1
      `.catch(() => []);
      if (existing) continue;

      const proposalType = proposal.proposed_fix?.type || proposal.gap_type;
      const priority = (proposalType === 'setup_action' || proposal.severity === 'critical') ? 'P1' : 'P2';
      const category = proposalType === 'setup_action' ? 'infra' : 'improvement';
      const proposalDescription = `Diagnosis: ${proposal.diagnosis}\n\nProposed fix: ${typeof proposal.proposed_fix === 'string' ? proposal.proposed_fix : JSON.stringify(proposal.proposed_fix)}`;

      // Skip company-specific proposals — they belong in the company's task backlog, not hive_backlog
      if (await isCompanySpecific(proposal.title as string, proposalDescription, sql).catch(() => false)) continue;

      await sql`
        INSERT INTO hive_backlog (title, description, priority, category, status, source)
        VALUES (
          ${(proposal.title as string).slice(0, 200)},
          ${proposalDescription.slice(0, 2000)},
          ${priority}, ${category}, 'ready', ${`evolver_${proposalType}`}
        )
      `.catch(() => {});
      await sql`
        UPDATE evolver_proposals SET implemented_at = NOW(),
          notes = COALESCE(notes, '') || ' | Routed to hive_backlog for automated implementation'
        WHERE id = ${proposal.id}
      `;
      dispatches.push({ type: proposalType, target: "backlog", payload: { proposal_id: proposal.id, title: proposal.title, routed: "backlog" } });
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

    // -----------------------------------------------------------------------
    // Check 27: Playbook confidence time-decay + auto-prune
    // -----------------------------------------------------------------------
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
      const newConfidence = Math.max(0, Number(entry.confidence) - 0.02);
      await sql`
        UPDATE playbook SET confidence = ${newConfidence} WHERE id = ${entry.id}
      `.catch(() => {});
      playbookDecayed++;
    }

    const pruneCandidates = await sql`
      SELECT id, domain, insight FROM playbook
      WHERE superseded_by IS NULL AND confidence <= 0.15 AND confidence > 0
    `.catch(() => []);

    for (const entry of pruneCandidates) {
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

    // -----------------------------------------------------------------------
    // Check 28: Venture Brain — cross-company intelligence (requires 2+ live companies)
    // -----------------------------------------------------------------------
    let ventureBrainDirectives = 0;
    const VB_MAX_DIRECTIVES = 3;

    try {
      const liveCompanies = await sql`
        SELECT id, slug, name, company_type FROM companies
        WHERE status IN ('mvp', 'active') AND github_repo IS NOT NULL
      `;

      if (liveCompanies.length >= 2) {
        // 28a. Cross-pollination
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
            AND (p.content_language IS NULL OR p.content_language = tc.content_language OR tc.content_language IS NULL)
            AND NOT EXISTS (
              SELECT 1 FROM directives d
              WHERE d.company_id = tc.id
                AND d.agent = 'venture_brain'
                AND d.created_at > NOW() - INTERVAL '7 days'
            )
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

        // 28b. Detect declining CEO scores
        if (ventureBrainDirectives < VB_MAX_DIRECTIVES) {
          const scoreTrends = await sql`
            WITH recent AS (
              SELECT company_id, AVG((COALESCE(ceo_review->'review'->>'score', ceo_review->>'score'))::numeric) as avg_score
              FROM cycles
              WHERE status = 'complete' AND ceo_review IS NOT NULL
                AND COALESCE(ceo_review->'review'->>'score', ceo_review->>'score') IS NOT NULL
                AND started_at > NOW() - INTERVAL '21 days'
              GROUP BY company_id
              HAVING COUNT(*) >= 2
            ),
            previous AS (
              SELECT company_id, AVG((COALESCE(ceo_review->'review'->>'score', ceo_review->>'score'))::numeric) as avg_score
              FROM cycles
              WHERE status = 'complete' AND ceo_review IS NOT NULL
                AND COALESCE(ceo_review->'review'->>'score', ceo_review->>'score') IS NOT NULL
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

          const declining = scoreTrends.filter((r: any) => Number(r.score_delta) < -1);
          const rising = scoreTrends.filter((r: any) => Number(r.score_delta) > 1);

          for (const dec of declining) {
            if (ventureBrainDirectives >= VB_MAX_DIRECTIVES) break;
            const [recentDirective] = await sql`
              SELECT id FROM directives
              WHERE company_id = ${dec.company_id} AND agent = 'venture_brain'
                AND created_at > NOW() - INTERVAL '7 days'
              LIMIT 1
            `;
            if (recentDirective) continue;

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

        // 28c. Cross-company error correlation
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
        if (ventureBrainDirectives > 0) {
          const portfolioInsight = `Venture Brain run: created ${ventureBrainDirectives} cross-company directive(s) across ${liveCompanies.length} live companies.`;
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
    } catch (e: any) {
      console.warn("Venture Brain check failed (non-blocking):", e.message);
    }

    // -----------------------------------------------------------------------
    // Check 29: Playbook consolidation
    // -----------------------------------------------------------------------
    let playbookMerged = 0;
    let playbookComposites = 0;
    const PB_MAX_MERGES = 10;
    const PB_MAX_COMPOSITES = 3;

    try {
      const consolidationEntries = await sql`
        SELECT id, source_company_id, domain, insight, confidence, applied_count, reference_count, content_language
        FROM playbook
        WHERE superseded_by IS NULL AND confidence > 0.2
        ORDER BY domain, confidence DESC
      `;

      // Normalize aliased domains in the DB (e.g. ops → operations)
      const aliasedIds: string[] = [];
      const aliasUpdates: Map<string, string> = new Map();
      for (const e of consolidationEntries) {
        const canonical = normalizePlaybookDomain(e.domain as string);
        if (canonical !== (e.domain as string)) {
          aliasedIds.push(e.id as string);
          aliasUpdates.set(e.id as string, canonical);
          e.domain = canonical;
        }
      }
      if (aliasedIds.length > 0) {
        await sql`
          UPDATE playbook SET domain = 'operations'
          WHERE id = ANY(${aliasedIds}) AND domain != 'operations'
        `;
      }

      const byDomain: Record<string, typeof consolidationEntries> = {};
      for (const e of consolidationEntries) {
        const d = e.domain as string;
        if (!byDomain[d]) byDomain[d] = [];
        byDomain[d].push(e);
      }

      const supersededThisRun = new Set<string>();

      for (const domain of Object.keys(byDomain)) {
        const entries = byDomain[domain];

        // Merge near-duplicates (same domain, Jaccard >= 0.6)
        for (let i = 0; i < entries.length && playbookMerged < PB_MAX_MERGES; i++) {
          const a = entries[i];
          if (supersededThisRun.has(a.id as string)) continue;
          const insightA = a.insight as string;
          if (insightA.split(/\s+/).length < 5) continue;

          for (let j = i + 1; j < entries.length && playbookMerged < PB_MAX_MERGES; j++) {
            const b = entries[j];
            if (supersededThisRun.has(b.id as string)) continue;
            const insightB = b.insight as string;
            if (insightB.split(/\s+/).length < 5) continue;

            const similarity = jaccardSimilarity(insightA, insightB);
            if (similarity < 0.6) continue;

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

        // Cross-company composites (Jaccard >= 0.5, different companies)
        const companyEntries = entries.filter(
          (e) => e.source_company_id != null && !supersededThisRun.has(e.id as string)
              && (e.insight as string).split(/\s+/).length >= 5
        );

        for (let i = 0; i < companyEntries.length && playbookComposites < PB_MAX_COMPOSITES; i++) {
          const a = companyEntries[i];
          const insightA = a.insight as string;

          for (let j = i + 1; j < companyEntries.length && playbookComposites < PB_MAX_COMPOSITES; j++) {
            const b = companyEntries[j];
            if (a.source_company_id === b.source_company_id) continue;
            const langA = a.content_language as string | null;
            const langB = b.content_language as string | null;
            if (langA && langB && langA !== langB) continue;

            const insightB = b.insight as string;

            const similarity = jaccardSimilarity(insightA, insightB);
            if (similarity < 0.5) continue;

            const [existingComposite] = await sql`
              SELECT id, insight FROM playbook
              WHERE domain = ${domain} AND source_company_id IS NULL
                AND superseded_by IS NULL AND confidence > 0.2
              ORDER BY confidence DESC LIMIT 1
            `;

            if (existingComposite && jaccardSimilarity(existingComposite.insight as string, insightA) >= 0.5) {
              continue;
            }

            const compositeConfidence = Math.min(1.0, Math.max(Number(a.confidence), Number(b.confidence)) + 0.05);
            const compositeInsight = insightA.length >= insightB.length ? insightA : insightB;
            const compositeLang = (langA && langB && langA === langB) ? langA : (langA || langB || null);

            await sql`
              INSERT INTO playbook (source_company_id, domain, insight, confidence, evidence, applied_count, reference_count, content_language)
              VALUES (
                NULL,
                ${domain},
                ${compositeInsight},
                ${compositeConfidence},
                ${JSON.stringify({ composite_from: [a.id, b.id], created_by: "sentinel_consolidation" })}::jsonb,
                0,
                0,
                ${compositeLang}
              )
            `;

            playbookComposites++;
          }
        }
      }

      if (playbookMerged > 0 || playbookComposites > 0 || aliasedIds.length > 0) {
        const parts = [];
        if (aliasedIds.length > 0) parts.push(`${aliasedIds.length} domains normalized`);
        if (playbookMerged > 0) parts.push(`${playbookMerged} duplicates merged`);
        if (playbookComposites > 0) parts.push(`${playbookComposites} cross-company composites created`);
        await sql`
          INSERT INTO agent_actions (agent, action_type, description, status, started_at, finished_at)
          VALUES ('sentinel', 'playbook_consolidation',
            ${`Playbook consolidation: ${parts.join(", ")}`},
            'success', NOW(), NOW())
        `.catch(() => {});
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn("Check 29 (playbook consolidation) failed:", msg);
    }

    // -----------------------------------------------------------------------
    // Check 34: Agent performance regression detection
    // -----------------------------------------------------------------------
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

        if (priorRate !== undefined && priorRate - recentRate > 0.15) {
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

        if (recentRate < 0.3) {
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
                  detected_by: "sentinel-janitor",
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

    // -----------------------------------------------------------------------
    // Check 35: Auto-learn error patterns from successful fixes
    // -----------------------------------------------------------------------
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

        const fixSummary = (fix.description as string) ||
          (fix.output && typeof fix.output === "object" ? JSON.stringify(fix.output).slice(0, 200) : null) ||
          `Fixed ${failedAction.action_type} error in ${fix.agent} agent`;

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

    // -----------------------------------------------------------------------
    // Check 37: Self-improvement proposals
    // -----------------------------------------------------------------------
    let selfImprovementProposals = 0;
    try {
      const MAX_PROPOSALS_PER_RUN = 2;
      const proposals: Array<{ title: string; diagnosis: string; fix: string; severity: string }> = [];

      // Pattern A: Recurring errors without known fixes
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

      // Pattern B: Companies with zero metrics for 7+ days
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
          diagnosis: `Companies with no pageview data: ${zeroMetricsCompanies.map((c) => c.slug).join(", ")}. The metrics pipeline (company /api/stats -> Hive metrics cron) is not delivering value.`,
          fix: `Ensure all company repos have working /api/stats endpoints with pageview middleware. Consider adding Vercel Analytics drain as backup data source.`,
          severity: "high",
        });
      }

      // Pattern C: Agents with >50% timeout failures
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

      // Pattern D: Tasks stuck in proposed/approved for >14 days
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

    // -----------------------------------------------------------------------
    // Check 39: Auto-decompose blocked backlog items
    // -----------------------------------------------------------------------
    try {
      const blockedItems = await sql`
        SELECT id, title, description, priority, category, spec, notes
        FROM hive_backlog
        WHERE status = 'blocked'
          AND notes LIKE '%Too many failed attempts%'
          AND NOT (notes LIKE '%auto-decomposed%')
          AND title NOT ILIKE '%email domain%'
        LIMIT 5
      `;

      let decomposedCount = 0;
      for (const item of blockedItems) {
        try {
          const { generateSpec } = await import("@/lib/backlog-planner");
          let spec = item.spec;
          if (!spec || !spec.approach) {
            spec = await generateSpec(
              { id: item.id, title: item.title, description: item.description, priority: item.priority, category: item.category, notes: item.notes },
              sql
            );
          }
          if (spec && Array.isArray(spec.approach) && spec.approach.length >= 2) {
            const steps = spec.approach as string[];
            const subItems: { title: string; description: string }[] = [];
            for (let i = 0; i < steps.length; i += 2) {
              const chunk = steps.slice(i, i + 2);
              const stepNums = chunk.map((_: string, j: number) => i + j + 1).join("-");
              subItems.push({
                title: `${item.title} (step ${stepNums}/${steps.length})`,
                description: `Parent: ${item.title}\n\n${chunk.join("\n")}`,
              });
            }
            if (subItems.length >= 2) {
              for (const sub of subItems) {
                await sql`
                  INSERT INTO hive_backlog (title, description, priority, category, status, source, spec)
                  VALUES (
                    ${(sub.title as string).slice(0, 200)}, ${(sub.description as string).slice(0, 2000)},
                    ${item.priority}, ${item.category || "feature"}, 'ready', 'auto_decompose',
                    ${JSON.stringify({ complexity: "S", estimated_turns: 15, acceptance_criteria: ["npx next build passes"] })}
                  )
                `.catch(() => {});
              }
              await sql`
                UPDATE hive_backlog
                SET notes = COALESCE(notes, '') || ${` [auto-decomposed] Sentinel check 39 split into ${subItems.length} sub-tasks.`}
                WHERE id = ${item.id}
              `.catch(() => {});
              decomposedCount++;
              dispatches.push({ type: "internal", target: "backlog_decompose", payload: { item_id: item.id, title: item.title, sub_tasks: subItems.length } });
            }
          }
        } catch (decompErr: any) {
          console.warn(`[sentinel-janitor] Check 39: decompose failed for "${item.title}": ${decompErr.message}`);
        }
      }

      if (decomposedCount > 0) {
        await sql`
          INSERT INTO agent_actions (agent, action_type, description, status, started_at, finished_at)
          VALUES ('sentinel', 'backlog_decompose',
            ${`Check 39: Decomposed ${decomposedCount} blocked items into sub-tasks`},
            'success', NOW(), NOW())
        `.catch(() => {});
      }
    } catch (check39Err: any) {
      console.warn(`[sentinel-janitor] Check 39 failed: ${check39Err.message}`);
    }

    // -----------------------------------------------------------------------
    // Check 46: Close decomposed parents when all sub-tasks are done
    // -----------------------------------------------------------------------
    try {
      // Find blocked parents that have child sub-tasks (via parent_id FK or legacy notes pattern)
      const decomposedParents = await sql`
        SELECT DISTINCT p.id, p.title, p.notes, p.github_issue_number
        FROM hive_backlog p
        WHERE p.status = 'blocked'
        AND (
          EXISTS (SELECT 1 FROM hive_backlog c WHERE c.parent_id = p.id)
          OR p.notes LIKE '%[decomposed]%'
          OR p.notes LIKE '%[auto-decomposed]%'
        )
      `;

      let parentsClosed = 0;
      for (const parent of decomposedParents) {
        // Use parent_id FK for child lookup (preferred), fall back to legacy regex
        const [result] = await sql`
          SELECT
            COUNT(*) FILTER (WHERE status IN ('done', 'rejected')) as completed,
            COUNT(*) as total
          FROM hive_backlog
          WHERE parent_id = ${parent.id}
        `;

        // If no children found via FK, try legacy UUID extraction from notes
        if (!result || result.total === 0) {
          const subTaskIds = (parent.notes || "").match(/[0-9a-f]{8}(?=-[0-9a-f]{4})/g) || [];
          if (subTaskIds.length === 0) continue;
          const [legacyResult] = await sql`
            SELECT
              COUNT(*) FILTER (WHERE status IN ('done', 'rejected')) as completed,
              COUNT(*) as total
            FROM hive_backlog
            WHERE id::text LIKE ANY(${subTaskIds.map((id: string) => id + '%')})
          `;
          if (!legacyResult || legacyResult.total === 0 || legacyResult.completed !== legacyResult.total) continue;
        } else if (result.completed !== result.total) {
          continue;
        }

        await sql`
          UPDATE hive_backlog
          SET status = 'done', completed_at = NOW(),
              notes = COALESCE(notes, '') || ' [parent-closed] All sub-tasks completed.'
          WHERE id = ${parent.id} AND status = 'blocked'
        `;
        parentsClosed++;
        // Sync GitHub Issue (fire-and-forget)
        if (parent.github_issue_number) {
          import("@/lib/github-issues").then(({ syncBacklogStatus }) =>
            syncBacklogStatus(parent.github_issue_number, "done")
          ).catch(() => {});
        }
        console.log(`[sentinel-janitor] Check 46: Closed decomposed parent "${parent.title}"`);
      }
      if (parentsClosed > 0) {
        await sql`
          INSERT INTO agent_actions (agent, company_id, action_type, description, status, output, started_at, finished_at)
          VALUES ('sentinel', NULL, 'janitor_check',
            ${`Check 46: Closed ${parentsClosed} decomposed parents (all sub-tasks done)`},
            'success', NULL, now(), now())
        `;
      }
    } catch (check46Err: any) {
      console.warn(`[sentinel-janitor] Check 46 failed: ${check46Err.message}`);
    }

    // -----------------------------------------------------------------------
    // Check 50: Blocked item recovery — unblock transient failures after 48h
    // -----------------------------------------------------------------------
    let blockedRecovered = 0;
    try {
      // Recover items blocked >48h from transient failures (not permanently blocked)
      const recoverableBlocked = await sql`
        UPDATE hive_backlog
        SET status = 'ready', dispatched_at = NULL,
            notes = COALESCE(notes, '') || ' [janitor-recovered] Unblocked after 48h cooldown.'
        WHERE status = 'blocked'
          AND updated_at < NOW() - INTERVAL '48 hours'
          AND notes NOT LIKE '%[ci_impossible]%'
          AND notes NOT LIKE '%Cost-risk%'
          AND notes NOT LIKE '%Requires manual action%'
          AND notes NOT LIKE '%[decomposed]%'
          AND notes NOT LIKE '%[auto-decomposed]%'
          AND notes NOT LIKE '%[janitor-recovered]%'
          AND notes NOT LIKE '%needs approval%'
          AND NOT EXISTS (SELECT 1 FROM hive_backlog c WHERE c.parent_id = hive_backlog.id)
        RETURNING id, title, github_issue_number
      `;
      blockedRecovered = recoverableBlocked.length;
      for (const item of recoverableBlocked) {
        if (item.github_issue_number) {
          import("@/lib/github-issues").then(({ syncBacklogStatus }) =>
            syncBacklogStatus(item.github_issue_number, "ready")
          ).catch(() => {});
        }
      }
      if (blockedRecovered > 0) {
        console.log(`[sentinel-janitor] Check 50: Recovered ${blockedRecovered} blocked items after 48h cooldown`);
      }
    } catch (check50Err: any) {
      console.warn(`[sentinel-janitor] Check 50 failed: ${check50Err.message}`);
    }

    // -----------------------------------------------------------------------
    // Backlog Health Check: Handle duplicates and stale items
    // -----------------------------------------------------------------------
    let duplicatesRejected = 0;
    let staleItemsDeprioritized = 0;

    try {
      // Query ready items for duplicate detection and staleness check
      const readyItems = await sql`
        SELECT
          id,
          title,
          description,
          priority,
          notes,
          created_at,
          github_issue_number,
          COALESCE(ARRAY_LENGTH(STRING_TO_ARRAY(notes, '[janitor]'), 1) - 1, 0) as attempt_count,
          LENGTH(COALESCE(notes, '')) as notes_length
        FROM hive_backlog
        WHERE status = 'ready'
        ORDER BY created_at ASC
      `;

      // Handle duplicates (similarity > 0.8)
      const processedItems = new Set<string>();

      for (let i = 0; i < readyItems.length; i++) {
        for (let j = i + 1; j < readyItems.length; j++) {
          const item1 = readyItems[i];
          const item2 = readyItems[j];

          // Skip if either item is already processed
          if (processedItems.has(item1.id) || processedItems.has(item2.id)) continue;

          const titleSimilarity = jaccardSimilarity(item1.title, item2.title);
          const descSimilarity = jaccardSimilarity(
            item1.description || "",
            item2.description || ""
          );
          const avgSimilarity = (titleSimilarity + descSimilarity) / 2;

          if (avgSimilarity > 0.8) {
            // Determine which to keep based on notes/attempts (more context)
            const item1Context = (item1.attempt_count || 0) + (item1.notes_length || 0);
            const item2Context = (item2.attempt_count || 0) + (item2.notes_length || 0);

            const keepItem = item1Context >= item2Context ? item1 : item2;
            const rejectItem = item1Context >= item2Context ? item2 : item1;

            await sql`
              UPDATE hive_backlog
              SET
                status = 'rejected',
                notes = COALESCE(notes, '') || ${` [janitor] Duplicate of ${keepItem.id} — ${keepItem.title.slice(0, 50)} (similarity: ${avgSimilarity.toFixed(2)})`}
              WHERE id = ${rejectItem.id}
            `;

            // Close GitHub issue for rejected duplicate
            if (rejectItem.github_issue_number) {
              import("@/lib/github-issues").then(({ syncBacklogStatus }) =>
                syncBacklogStatus(rejectItem.github_issue_number, "rejected")
              ).catch(() => {});
            }

            duplicatesRejected++;
            console.log(`[sentinel-janitor] Backlog Health: Rejected duplicate item "${rejectItem.title}" (similarity: ${avgSimilarity.toFixed(2)} with "${keepItem.title}")`);

            // Mark rejected item as processed to avoid double-processing
            processedItems.add(rejectItem.id);
          }
        }
      }

      // Handle stale items (ready for 14+ days, never dispatched)
      const fourteenDaysAgo = new Date();
      fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);

      for (const item of readyItems) {
        if (processedItems.has(item.id) || new Date(item.created_at) > fourteenDaysAgo) continue;

        // Check if item was ever dispatched by looking for agent_actions
        const [dispatchCheck] = await sql`
          SELECT 1 FROM agent_actions
          WHERE description ILIKE ${'%' + item.id + '%'}
          OR description ILIKE ${'%' + item.title.slice(0, 30) + '%'}
          LIMIT 1
        `;

        if (!dispatchCheck) {
          const daysStale = Math.floor((Date.now() - new Date(item.created_at).getTime()) / (1000 * 60 * 60 * 24));

          // Downgrade priority by one level (P1→P2, P2→P3). Don't downgrade P0.
          let newPriority = item.priority;
          if (item.priority === 'P1') newPriority = 'P2';
          else if (item.priority === 'P2') newPriority = 'P3';
          // P0 and P3 stay the same (P0 doesn't downgrade, P3 is already lowest)

          if (newPriority !== item.priority) {
            await sql`
              UPDATE hive_backlog
              SET
                priority = ${newPriority},
                notes = COALESCE(notes, '') || ${` [janitor] Stale for ${daysStale} days — deprioritizing`}
              WHERE id = ${item.id}
            `;

            staleItemsDeprioritized++;
            console.log(`[sentinel-janitor] Backlog Health: Deprioritized stale item "${item.title}" (${daysStale} days, ${item.priority}→${newPriority})`);
          }
        }
      }

      if (duplicatesRejected > 0 || staleItemsDeprioritized > 0) {
        await sql`
          INSERT INTO agent_actions (agent, action_type, description, status, started_at, finished_at)
          VALUES ('sentinel', 'backlog_health',
            ${`Backlog Health: Rejected ${duplicatesRejected} duplicates, deprioritized ${staleItemsDeprioritized} stale items`},
            'success', NOW(), NOW())
        `;
      }

    } catch (backlogHealthErr: any) {
      console.warn(`[sentinel-janitor] Backlog Health check failed: ${backlogHealthErr.message}`);
    }

    // -----------------------------------------------------------------------
    // Check 48: Database Performance Monitoring
    // -----------------------------------------------------------------------
    let slowQueriesFound = 0;
    let cacheHitRatioPct = 0;
    let dbPerformanceIssues: string[] = [];

    try {
      // Enable required extensions
      await sql`CREATE EXTENSION IF NOT EXISTS pg_stat_statements`.catch(() => {
        console.warn("[sentinel-janitor] pg_stat_statements extension not available on this Neon instance");
      });

      await sql`CREATE EXTENSION IF NOT EXISTS neon`.catch(() => {
        console.warn("[sentinel-janitor] neon extension not available on this Neon instance");
      });

      // Query slow queries from pg_stat_statements
      try {
        const slowQueries = await sql`
          SELECT
            SUBSTR(query, 1, 100) AS query_snippet,
            calls,
            ROUND(mean_exec_time, 2) AS mean_exec_time_ms,
            ROUND(total_exec_time, 2) AS total_exec_time_ms
          FROM pg_stat_statements
          WHERE calls > 5  -- Only queries that ran more than 5 times
          ORDER BY mean_exec_time DESC
          LIMIT 20
        `;

        slowQueriesFound = slowQueries.length;

        // Log top 5 slowest queries for monitoring
        const topSlow = slowQueries.slice(0, 5);
        if (topSlow.length > 0) {
          console.log(`[sentinel-janitor] Top slow queries:`, topSlow.map(q =>
            `${q.query_snippet}... (${q.mean_exec_time_ms}ms avg, ${q.calls} calls)`
          ).join('; '));
        }

        // Flag queries with >1000ms average execution time
        const criticalSlow = slowQueries.filter(q => Number(q.mean_exec_time_ms) > 1000);
        if (criticalSlow.length > 0) {
          dbPerformanceIssues.push(`${criticalSlow.length} queries with >1s avg execution time`);
        }

        // Flag queries with >10000 total execution time (high cumulative impact)
        const highImpact = slowQueries.filter(q => Number(q.total_exec_time_ms) > 10000);
        if (highImpact.length > 0) {
          dbPerformanceIssues.push(`${highImpact.length} queries with high cumulative impact (>10s total)`);
        }

      } catch (statErr) {
        console.warn("[sentinel-janitor] pg_stat_statements query failed:", statErr instanceof Error ? statErr.message : "unknown");
      }

      // Query cache hit ratio from neon extension
      try {
        const [cacheStats] = await sql`
          SELECT
            ROUND(
              (blks_hit::numeric / NULLIF(blks_hit + blks_read, 0)) * 100,
              2
            ) AS cache_hit_ratio_pct
          FROM neon_stat_file_cache
        `;

        if (cacheStats?.cache_hit_ratio_pct) {
          cacheHitRatioPct = Number(cacheStats.cache_hit_ratio_pct);
          console.log(`[sentinel-janitor] Cache hit ratio: ${cacheHitRatioPct}%`);

          // Flag if cache hit ratio is below target (99%+)
          if (cacheHitRatioPct < 99) {
            dbPerformanceIssues.push(`Cache hit ratio below target: ${cacheHitRatioPct}% (target: 99%+)`);
          }
        }

      } catch (cacheErr) {
        console.warn("[sentinel-janitor] neon cache stats query failed:", cacheErr instanceof Error ? cacheErr.message : "unknown");
      }

      // Log performance summary
      if (dbPerformanceIssues.length > 0 || slowQueriesFound > 10) {
        const description = `DB Performance Check: ${slowQueriesFound} queries analyzed, cache hit ratio ${cacheHitRatioPct}%${
          dbPerformanceIssues.length > 0 ? `, Issues: ${dbPerformanceIssues.join('; ')}` : ''
        }`;

        await sql`
          INSERT INTO agent_actions (agent, action_type, description, status, started_at, finished_at, output)
          VALUES ('sentinel', 'db_performance_check', ${description}, 'success', NOW(), NOW(),
            ${JSON.stringify({
              slow_queries_count: slowQueriesFound,
              cache_hit_ratio_pct: cacheHitRatioPct,
              issues: dbPerformanceIssues
            })}::jsonb)
        `;

        // Create escalation if there are critical performance issues
        if (dbPerformanceIssues.length > 0) {
          dispatches.push({
            type: "ops_escalation",
            target: "ops",
            payload: {
              source: "db_performance",
              issues: dbPerformanceIssues,
              slow_queries: slowQueriesFound,
              cache_hit_ratio: cacheHitRatioPct
            }
          });
        }
      }

    } catch (dbPerfErr: any) {
      console.warn(`[sentinel-janitor] Database performance check failed: ${dbPerfErr.message}`);
    }

    // -----------------------------------------------------------------------
    // Check 53: GSC pending verification completion
    // When Engineer closes the meta tag task, auto-complete GSC verification
    // -----------------------------------------------------------------------
    let gscVerificationsCompleted = 0;
    try {
      const pendingGscCompanies = await sql`
        SELECT id, slug, capabilities
        FROM companies
        WHERE capabilities->'gsc_integration'->>'pending_verification_token' IS NOT NULL
          AND status NOT IN ('killed', 'idea')
      `;

      for (const company of pendingGscCompanies) {
        try {
          // Check if the meta tag engineering task is closed
          const [openTask] = await sql`
            SELECT id FROM company_tasks
            WHERE company_id = ${company.id}
              AND title ILIKE '%site verification%'
              AND category = 'engineering'
              AND status NOT IN ('done', 'dismissed', 'cancelled')
            LIMIT 1
          `;

          if (openTask) continue; // Task still open — Engineer hasn't deployed yet

          // Task is done (or doesn't exist anymore) — trigger Phase B verification
          console.log(`[sentinel-janitor] Check 53: Triggering GSC verification for ${company.slug} (meta tag task closed)`);

          const verifyRes = await fetch(`${baseUrl}/api/gsc/verify-property`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${cronSecret}`,
            },
            body: JSON.stringify({ company_slug: company.slug, step: "verify" }),
          });

          if (verifyRes.ok) {
            const verifyData = await verifyRes.json();
            if (verifyData.verified) {
              gscVerificationsCompleted++;
              dispatches.push({
                type: "gsc_verified",
                target: company.slug,
                payload: { verified: true, property_added: verifyData.property_added },
              });
            }
          } else {
            console.warn(`[sentinel-janitor] Check 53: verify-property failed for ${company.slug}: ${verifyRes.status}`);
          }
        } catch (perCompanyErr: any) {
          console.warn(`[sentinel-janitor] Check 53: error for ${company.slug}: ${perCompanyErr.message}`);
        }
      }

      if (gscVerificationsCompleted > 0) {
        await sql`
          INSERT INTO agent_actions (agent, action_type, description, status, started_at, finished_at)
          VALUES ('sentinel', 'gsc_verification_complete',
            ${`Check 53: Auto-completed GSC property verification for ${gscVerificationsCompleted} company/companies`},
            'success', NOW(), NOW())
        `.catch(() => {});
        console.log(`[sentinel-janitor] Check 53: Completed GSC verification for ${gscVerificationsCompleted} companies`);
      }
    } catch (check53Err: any) {
      console.warn(`[sentinel-janitor] Check 53 failed: ${check53Err.message}`);
    }

    // -----------------------------------------------------------------------
    // Telegram notification
    // -----------------------------------------------------------------------
    try {
      const { notifyHive } = await import("@/lib/telegram");
      const interesting = dispatches.length > 0 ||
        selfImprovementProposals > 0 || agentRegressions > 0 ||
        proposalsAutoApproved > 0 || ventureBrainDirectives > 0 ||
        duplicatesRejected > 0 || staleItemsDeprioritized > 0 ||
        gscVerificationsCompleted > 0 ||
        dbPerformanceIssues.length > 0;
      if (interesting) {
        const parts: string[] = [];
        if (dispatches.length > 0) parts.push(`${dispatches.length} dispatches`);
        if (selfImprovementProposals > 0) parts.push(`${selfImprovementProposals} improvement proposals`);
        if (agentRegressions > 0) parts.push(`${agentRegressions} agent regressions`);
        if (proposalsAutoApproved > 0) parts.push(`${proposalsAutoApproved} proposals auto-approved`);
        if (ventureBrainDirectives > 0) parts.push(`${ventureBrainDirectives} venture brain directives`);
        if (playbookMerged > 0) parts.push(`${playbookMerged} playbook merges`);
        if (errorPatternsLearned > 0) parts.push(`${errorPatternsLearned} error patterns learned`);
        if (duplicatesRejected > 0) parts.push(`${duplicatesRejected} duplicates rejected`);
        if (staleItemsDeprioritized > 0) parts.push(`${staleItemsDeprioritized} stale items deprioritized`);
        if (gscVerificationsCompleted > 0) parts.push(`${gscVerificationsCompleted} GSC properties verified`);
        if (dbPerformanceIssues.length > 0) parts.push(`${dbPerformanceIssues.length} DB performance issues`);

        await notifyHive({
          agent: "sentinel-janitor",
          action: "daily_maintenance",
          status: "success",
          summary: parts.join(", "),
          details: dispatches.map((d: Dispatch) => `${d.type}: ${d.target}`).join("\n"),
        });
      }
    } catch { /* Telegram not configured — silently skip */ }

    // -----------------------------------------------------------------------
    // Check 49: Auto-sync backlog items to GitHub Issues
    // Items without github_issue_number get Issues created (batch of 5 per run)
    // -----------------------------------------------------------------------
    let issuesSynced = 0;
    try {
      const unlinked = await sql`
        SELECT id, title, priority, category, theme, notes
        FROM hive_backlog
        WHERE github_issue_number IS NULL
        AND status NOT IN ('done', 'rejected')
        ORDER BY
          CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,
          created_at ASC
        LIMIT 5
      `;
      if (unlinked.length > 0) {
        const { createBacklogIssue } = await import("@/lib/github-issues");
        for (const item of unlinked) {
          try {
            const issue = await createBacklogIssue({
              id: item.id,
              title: item.title,
              description: item.notes || item.title,
              priority: item.priority || "P2",
              category: item.category || "feature",
              theme: item.theme || null,
            });
            if (issue) {
              await sql`
                UPDATE hive_backlog
                SET github_issue_number = ${issue.number}, github_issue_url = ${issue.url}
                WHERE id = ${item.id}
              `;
              issuesSynced++;
            }
          } catch { /* per-item non-blocking */ }
          // Rate limit: 1s between API calls
          if (issuesSynced < unlinked.length) await new Promise(r => setTimeout(r, 1000));
        }
        if (issuesSynced > 0) {
          console.log(`[sentinel-janitor] Check 49: Synced ${issuesSynced}/${unlinked.length} backlog items to GitHub Issues`);
        }
      }
    } catch (check49Err: any) {
      console.warn(`[sentinel-janitor] Check 49 failed: ${check49Err?.message}`);
    }

    // -----------------------------------------------------------------------
    // Check 51: Ghost pr_open recovery — detect pr_open items whose PR is
    // closed/merged on GitHub and sync status to done or ready
    // -----------------------------------------------------------------------
    let ghostPrFixed = 0;
    try {
      const stuckPrOpen = await sql`
        SELECT id, title, pr_number, github_issue_number
        FROM hive_backlog
        WHERE status = 'pr_open'
          AND pr_number IS NOT NULL
          AND updated_at < NOW() - INTERVAL '2 hours'
        LIMIT 10
      `;

      if (stuckPrOpen.length > 0) {
        const { getGitHubToken } = await import("@/lib/github-app");
        const { syncBacklogStatus } = await import("@/lib/github-issues");
        const ghToken = await getGitHubToken().catch(() => null);

        if (ghToken) {
          for (const item of stuckPrOpen) {
            try {
              const repo = "carloshmiranda/hive";
              const res = await fetch(
                `https://api.github.com/repos/${repo}/pulls/${item.pr_number}`,
                {
                  headers: {
                    Authorization: `token ${ghToken}`,
                    Accept: "application/vnd.github+json",
                  },
                  signal: AbortSignal.timeout(8000),
                }
              );
              if (!res.ok) continue;
              const pr = await res.json();

              if (pr.state === "closed") {
                const newStatus = pr.merged ? "done" : "ready";
                const noteFragment = pr.merged
                  ? ` [janitor] PR #${item.pr_number} merged — marked done.`
                  : ` [janitor] PR #${item.pr_number} closed unmerged — reset to ready.`;

                await sql`
                  UPDATE hive_backlog
                  SET status = ${newStatus},
                      completed_at = ${pr.merged ? new Date(pr.merged_at) : null},
                      dispatched_at = NULL,
                      notes = COALESCE(notes, '') || ${noteFragment}
                  WHERE id = ${item.id}
                `;

                if (item.github_issue_number) {
                  await syncBacklogStatus(item.github_issue_number, newStatus).catch(() => {});
                }

                ghostPrFixed++;
                console.log(`[sentinel-janitor] Check 51: ${item.title} — PR #${item.pr_number} was ${pr.state}${pr.merged ? " (merged)" : ""} → ${newStatus}`);
              }
            } catch { /* per-item non-blocking */ }
          }
        }
      }

      if (ghostPrFixed > 0) {
        console.log(`[sentinel-janitor] Check 51: Fixed ${ghostPrFixed} ghost pr_open items`);
      }
    } catch (check51Err: any) {
      console.warn(`[sentinel-janitor] Check 51 failed: ${check51Err?.message}`);
    }

    // -----------------------------------------------------------------------
    // Check 52: Dependency vulnerability scanning (GitHub Dependabot alerts)
    // -----------------------------------------------------------------------
    let vulnAlertsFound = 0;
    try {
      if (ghPat) {
        const activeCompanies = await sql`
          SELECT id, name, slug, github_repo
          FROM companies
          WHERE github_repo IS NOT NULL AND status NOT IN ('killed', 'idea')
          LIMIT 10
        ` as Array<{ id: string; name: string; slug: string; github_repo: string }>;

        for (const company of activeCompanies) {
          try {
            const alertsRes = await fetch(
              `https://api.github.com/repos/${company.github_repo}/dependabot/alerts?state=open&severity=critical,high&per_page=10`,
              { headers: { Authorization: `token ${ghPat}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } }
            );

            if (!alertsRes.ok) continue; // repo may not have Dependabot enabled

            const alerts: Array<{ number: number; security_advisory: { summary: string; severity: string }; dependency: { package: { name: string } } }> = await alertsRes.json();
            const criticalOrHigh = Array.isArray(alerts) ? alerts.filter(a => ["critical", "high"].includes(a.security_advisory?.severity)) : [];

            if (criticalOrHigh.length > 0) {
              vulnAlertsFound += criticalOrHigh.length;
              const summaries = criticalOrHigh.slice(0, 3).map(a =>
                `${a.security_advisory.severity.toUpperCase()}: ${a.dependency.package.name} — ${a.security_advisory.summary}`
              ).join("; ");

              // Dedup: don't create if an open vuln task already exists for this company
              const [existingVulnTask] = await sql`
                SELECT id FROM company_tasks
                WHERE company_id = ${company.id}
                  AND status NOT IN ('done', 'dismissed')
                  AND title ILIKE ${"Fix dependency vulnerabilities%"}
                LIMIT 1
              `;

              if (!existingVulnTask) {
                const vulnTitle = `Fix dependency vulnerabilities in ${company.name}`;
                const vulnDesc = `${criticalOrHigh.length} open Dependabot alert(s) — ${summaries}`;
                const [vulnTask] = await sql`
                  INSERT INTO company_tasks (company_id, category, title, description, priority, status, source)
                  VALUES (
                    ${company.id}, 'engineering', ${vulnTitle}, ${vulnDesc}, 0, 'proposed', 'sentinel'
                  )
                  RETURNING id
                `;
                if (vulnTask?.id && company.github_repo) {
                  import("@/lib/github-issues").then(({ syncNewCompanyTaskIssue }) =>
                    syncNewCompanyTaskIssue(sql, vulnTask.id, company.slug, company.github_repo, {
                      title: vulnTitle, description: vulnDesc,
                      priority: 0, category: "engineering", source: "sentinel", acceptance: null,
                    })
                  ).catch(() => {});
                }
                console.log(`[sentinel-janitor] Check 52: Created vuln task for ${company.slug} (${criticalOrHigh.length} alerts)`);
              }
            }
          } catch { /* per-company non-blocking */ }
        }
      }

      if (vulnAlertsFound > 0) {
        console.log(`[sentinel-janitor] Check 52: Found ${vulnAlertsFound} critical/high CVEs across company repos`);
      }
    } catch (check52Err: any) {
      console.warn(`[sentinel-janitor] Check 52 failed: ${check52Err?.message}`);
    }

    // -----------------------------------------------------------------------
    // Check: backfill company task GitHub issues
    // -----------------------------------------------------------------------
    let taskIssuesBackfilled = 0;
    try {
      const unlinkedTasks = await sql`
        SELECT ct.id, ct.title, ct.description, ct.priority, ct.category, ct.source, ct.acceptance,
          c.slug, c.github_repo
        FROM company_tasks ct
        JOIN companies c ON c.id = ct.company_id
        WHERE ct.github_issue_number IS NULL
          AND ct.status NOT IN ('done', 'dismissed', 'cancelled')
          AND c.github_repo IS NOT NULL
        ORDER BY ct.priority ASC, ct.created_at ASC
        LIMIT 5
      ` as Array<{ id: string; title: string; description: string; priority: number; category: string; source: string; acceptance: string | null; slug: string; github_repo: string }>;

      if (unlinkedTasks.length > 0) {
        const { syncNewCompanyTaskIssue } = await import("@/lib/github-issues");
        for (const ct of unlinkedTasks) {
          await syncNewCompanyTaskIssue(sql, ct.id, ct.slug, ct.github_repo, {
            title: ct.title,
            description: ct.description,
            priority: ct.priority,
            category: ct.category,
            source: ct.source,
            acceptance: ct.acceptance,
          }).catch(() => {});
          taskIssuesBackfilled++;
        }
        console.log(`[sentinel-janitor] Backfill: linked ${taskIssuesBackfilled} company tasks to GitHub Issues`);
      }
    } catch (backfillErr: any) {
      console.warn(`[sentinel-janitor] Backfill check failed: ${backfillErr?.message}`);
    }

    // -----------------------------------------------------------------------
    // Check: Missing Neon DB auto-provision
    // Detect active companies missing Neon DB and trigger provisioning
    // -----------------------------------------------------------------------
    let neonProvisionsTriggered = 0;
    try {
      const companiesMissingNeon = await sql`
        SELECT c.id, c.slug
        FROM companies c
        WHERE c.status IN ('mvp', 'approved')
        AND NOT EXISTS (
          SELECT 1 FROM infra i
          WHERE i.company_id = c.id AND i.service = 'neon' AND i.status = 'active'
        )
        AND c.neon_project_id IS NULL
      `;
      for (const company of companiesMissingNeon) {
        console.warn(`[sentinel-janitor] missing Neon DB for ${company.slug}, triggering provision`);
        fetch(`${baseUrl}/api/agents/provision`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${cronSecret}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ company_id: company.id, company_slug: company.slug }),
        }).catch(() => {});
        neonProvisionsTriggered++;
      }
      if (neonProvisionsTriggered > 0) {
        console.log(`[sentinel-janitor] Neon self-heal: triggered provisioning for ${neonProvisionsTriggered} companies`);
      }
    } catch (neonHealErr: any) {
      console.warn(`[sentinel-janitor] Neon self-heal check failed: ${neonHealErr.message}`);
    }

    // -----------------------------------------------------------------------
    // Check: Auto-dismiss proposed tasks stale for >14 days with no cycle assignment
    // -----------------------------------------------------------------------
    let staleTasksDismissed = 0;
    try {
      const staleTasks = await sql`
        UPDATE company_tasks
        SET status = 'dismissed', updated_at = NOW()
        WHERE status = 'proposed'
          AND created_at < NOW() - INTERVAL '14 days'
          AND cycle_id IS NULL
        RETURNING id, company_id, title
      `;
      staleTasksDismissed = staleTasks.length;
      console.warn(`[janitor] dismissed ${staleTasksDismissed} stale proposed tasks`);
    } catch (staleTasksErr: any) {
      console.warn(`[janitor] stale task dismiss failed: ${staleTasksErr.message}`);
    }

    // -----------------------------------------------------------------------
    // Check: Enable Vercel Web Analytics for companies that don't have it
    // Runs silently — fires PUT /v9/projects/{id}/web-analytics for any company
    // with a vercel_project_id. Idempotent — safe to re-run every day.
    // -----------------------------------------------------------------------
    let analyticsEnabled = 0;
    try {
      const [vercelToken, teamId] = await Promise.all([
        getSettingValue("vercel_token").catch(() => null),
        getSettingValue("vercel_team_id").catch(() => null),
      ]);
      if (vercelToken) {
        const teamParam = teamId ? `?teamId=${teamId}` : "";
        const projectsForAnalytics = await sql`
          SELECT slug, vercel_project_id FROM companies
          WHERE status IN ('mvp', 'active', 'idea')
            AND vercel_project_id IS NOT NULL
            AND vercel_project_id LIKE 'prj_%'
        `;
        for (const co of projectsForAnalytics) {
          try {
            const res = await fetch(
              `https://api.vercel.com/v9/projects/${co.vercel_project_id}/web-analytics${teamParam}`,
              {
                method: "PUT",
                headers: { Authorization: `Bearer ${vercelToken}`, "Content-Type": "application/json" },
                body: JSON.stringify({ enabled: true }),
              }
            );
            if (res.ok) analyticsEnabled++;
          } catch {
            // Non-fatal — skip
          }
        }
        if (analyticsEnabled > 0) {
          console.log(`[janitor] enabled web analytics on ${analyticsEnabled} projects`);
        }
      }
    } catch (analyticsErr: any) {
      console.warn(`[janitor] analytics enable check failed: ${analyticsErr.message}`);
    }

    // -----------------------------------------------------------------------
    // Check: Auto-expire stale new_company proposals pending >21 days
    // Prevents dashboard accumulation — Carlos should review within 3 weeks
    // -----------------------------------------------------------------------
    let staleProposalsExpired = 0;
    try {
      const expiredProposals = await sql`
        UPDATE approvals
        SET status = 'expired', decided_at = NOW(),
            decision_note = 'auto-expired: pending review for >21 days'
        WHERE gate_type = 'new_company'
          AND status = 'pending'
          AND created_at < NOW() - INTERVAL '21 days'
        RETURNING id, title
      `;
      staleProposalsExpired = expiredProposals.length;
      if (staleProposalsExpired > 0) {
        console.warn(`[janitor] expired ${staleProposalsExpired} stale new_company proposals`);
      }
    } catch (staleProposalsErr: any) {
      console.warn(`[janitor] stale proposal expire failed: ${staleProposalsErr.message}`);
    }

    // -----------------------------------------------------------------------
    // Check: Flag companies with >15 open tasks for CEO to drain
    // -----------------------------------------------------------------------
    let overflowCompanies: { slug: string; open_cnt: number }[] = [];
    try {
      const overflowRows = await sql`
        SELECT c.slug, COUNT(*)::int as open_cnt
        FROM company_tasks ct JOIN companies c ON c.id = ct.company_id
        WHERE ct.status NOT IN ('done','dismissed','cancelled')
        AND c.status = 'mvp'
        GROUP BY c.slug HAVING COUNT(*) > 15
        ORDER BY open_cnt DESC
      `;
      overflowCompanies = overflowRows as { slug: string; open_cnt: number }[];
      if (overflowCompanies.length > 0) {
        console.warn('[janitor] task overflow companies:', JSON.stringify(overflowCompanies));
      }
    } catch (overflowErr: any) {
      console.warn(`[janitor] task overflow check failed: ${overflowErr.message}`);
    }

    // -----------------------------------------------------------------------
    // Regenerate BACKLOG.md from database
    // -----------------------------------------------------------------------
    let backlogRegenerated = false;
    try {
      const { regenerateBacklogMd } = await import("@/lib/backlog-planner");
      await regenerateBacklogMd(sql);
      backlogRegenerated = true;
      console.log("[sentinel-janitor] BACKLOG.md regenerated from database");
    } catch (error) {
      console.warn("[sentinel-janitor] Failed to regenerate BACKLOG.md:", error instanceof Error ? error.message : "unknown");
    }

    // -----------------------------------------------------------------------
    // Response
    // -----------------------------------------------------------------------
    return Response.json({
      ok: true,
      tier: "janitor",
      traceId,
      dispatches: ctx.dispatches,
      dedupSkips: ctx.dedupSkips,
      circuitBreaks: ctx.circuitBreaks,
      schema_drift: schemaDrift.length,
      recurring_escalations: recurringEscalations.length,
      auto_resolved: autoResolved,
      auto_dismissed_escalations: autoDismissed,
      proposals_auto_approved: proposalsAutoApproved,
      evolver_proposals_marked: evolverProposalsMarked,
      playbook_decayed: playbookDecayed,
      playbook_pruned: playbookPruned,
      venture_brain_directives: ventureBrainDirectives,
      playbook_merged: playbookMerged,
      playbook_composites: playbookComposites,
      agent_regressions: agentRegressions,
      agent_escalations: agentEscalations,
      self_improvement_proposals: selfImprovementProposals,
      error_patterns_learned: errorPatternsLearned,
      github_issues_synced: issuesSynced,
      blocked_items_recovered: blockedRecovered,
      backlog_regenerated: backlogRegenerated,
      backlog_duplicates_rejected: duplicatesRejected,
      backlog_stale_deprioritized: staleItemsDeprioritized,
      ghost_pr_fixed: ghostPrFixed,
      gsc_verifications_completed: gscVerificationsCompleted,
      vuln_alerts_found: vulnAlertsFound,
      task_issues_backfilled: taskIssuesBackfilled,
      db_slow_queries_found: slowQueriesFound,
      db_cache_hit_ratio_pct: cacheHitRatioPct,
      db_performance_issues: dbPerformanceIssues.length,
      neon_provisions_triggered: neonProvisionsTriggered,
      stale_tasks_dismissed: staleTasksDismissed,
      stale_proposals_expired: staleProposalsExpired,
      analytics_enabled: analyticsEnabled,
      task_overflow_companies: overflowCompanies,
    });

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    console.error("Sentinel Janitor failed:", message, stack);
    return Response.json({ ok: false, error: message, stack }, { status: 500 });
  }
}

// QStash sends POST — re-export GET handler for dual-mode auth
export { GET as POST };
