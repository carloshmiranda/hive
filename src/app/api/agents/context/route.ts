import { NextRequest } from "next/server";
import { validateOIDC } from "@/lib/oidc";
import { getDb, json, err } from "@/lib/db";
import { computeValidationScore, normalizeBusinessType } from "@/lib/validation";
import { getCapabilitySummary } from "@/lib/hive-capabilities";
import { checkForbidden } from "@/lib/phase-gate";

// GET /api/agents/context?agent=build|growth|fix&company_slug=X
export async function GET(req: NextRequest) {
  const result = await validateOIDC(req);
  if (result instanceof Response) return result;

  const { searchParams } = new URL(req.url);
  const agent = searchParams.get("agent");
  const slug = searchParams.get("company_slug");

  if (!agent || !slug) {
    return err("Missing agent or company_slug query params", 400);
  }

  const sql = getDb();

  const [company] = await sql`
    SELECT id, name, slug, description, capabilities, company_type, created_at
    FROM companies WHERE slug = ${slug} LIMIT 1
  `.catch(() => []);

  if (!company) {
    return json({});
  }

  if (agent === "build") {
    return json(await buildContext(sql, company));
  } else if (agent === "growth") {
    return json(await growthContext(sql, company));
  } else if (agent === "fix") {
    return json(await fixContext(sql, company));
  }

  return err(`Unknown agent type: ${agent}`, 400);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildContext(sql: any, company: any) {
  const [cycle, reports, proposal, playbook, tasks, metrics] = await Promise.all([
    sql`
      SELECT id, cycle_number, ceo_plan FROM cycles
      WHERE company_id = ${company.id} AND status = 'running'
      ORDER BY started_at DESC LIMIT 1
    `.catch(() => []),
    sql`
      SELECT report_type, summary, content FROM research_reports
      WHERE company_id = ${company.id}
        AND report_type IN ('market_research','competitive_analysis','seo_keywords','product_spec')
      ORDER BY updated_at DESC
    `.catch(() => []),
    sql`
      SELECT context FROM approvals
      WHERE company_id = ${company.id} AND gate_type = 'new_company'
      ORDER BY created_at DESC LIMIT 1
    `.catch(() => []),
    sql`
      SELECT domain, insight FROM playbook
      WHERE confidence >= 0.6 ORDER BY confidence DESC LIMIT 5
    `.catch(() => []),
    sql`
      SELECT id, title, description, priority, acceptance, status
      FROM company_tasks
      WHERE company_id = ${company.id} AND category = 'engineering'
        AND status IN ('proposed', 'approved')
      ORDER BY priority ASC, created_at ASC LIMIT 5
    `.catch(() => []),
    sql`
      SELECT date, page_views, signups, waitlist_signups, waitlist_total,
        revenue, mrr, customers, pricing_page_views, pricing_cta_clicks,
        affiliate_clicks, affiliate_revenue
      FROM metrics WHERE company_id = ${company.id}
      ORDER BY date DESC LIMIT 14
    `.catch(() => []),
  ]);

  const research: Record<string, { summary: string; content: unknown }> = {};
  for (const r of reports) {
    research[r.report_type] = { summary: r.summary, content: r.content };
  }

  // Compute validation score and phase
  const businessType = normalizeBusinessType(company.company_type);
  const validation = computeValidationScore(businessType, metrics, company.created_at);

  // Phase gate: filter out tasks that violate the current validation phase
  type Task = { id: string; title: string; description: string; priority: number; acceptance: string; status: string };
  let filteredTasks = tasks as Task[];
  const gatedTasks: string[] = [];
  if (validation.forbidden && validation.forbidden.length > 0) {
    filteredTasks = [];
    for (const task of tasks as Task[]) {
      const violations = checkForbidden(`${task.title}: ${task.description}`, validation.forbidden, validation.phase);
      if (violations.length > 0) {
        gatedTasks.push(`${task.title} (violates: ${violations[0].rule})`);
      } else {
        filteredTasks.push(task);
      }
    }
  }

  return {
    description: company.description,
    business_type: businessType,
    validation,
    cycle: cycle[0] ? { id: cycle[0].id, cycle_number: cycle[0].cycle_number, ceo_plan: cycle[0].ceo_plan } : null,
    research,
    proposal: proposal[0]?.context?.proposal || null,
    playbook: playbook.map((p: { domain: string; insight: string }) => `${p.domain}: ${p.insight}`),
    engineering_tasks: filteredTasks,
    ...(gatedTasks.length > 0 ? { phase_gated_tasks: gatedTasks } : {}),
    metrics: metrics.slice(0, 7),
    hive_capabilities: getCapabilitySummary(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function growthContext(sql: any, company: any) {
  const [cycle, reports, metrics, playbook, proposals, tasks] = await Promise.all([
    sql`
      SELECT ceo_plan FROM cycles
      WHERE company_id = ${company.id} ORDER BY started_at DESC LIMIT 1
    `.catch(() => []),
    sql`
      SELECT report_type, summary, content FROM research_reports
      WHERE company_id = ${company.id}
        AND report_type IN ('market_research','competitive_analysis','seo_keywords',
          'visibility_snapshot','llm_visibility','content_performance','product_spec')
      ORDER BY updated_at DESC
    `.catch(() => []),
    sql`
      SELECT date, mrr, customers, page_views, signups, waitlist_total, waitlist_signups
      FROM metrics WHERE company_id = ${company.id}
        AND date >= CURRENT_DATE - INTERVAL '7 days'
      ORDER BY date DESC LIMIT 14
    `.catch(() => []),
    sql`
      SELECT domain, insight FROM playbook
      WHERE confidence >= 0.6 ORDER BY confidence DESC LIMIT 10
    `.catch(() => []),
    sql`
      SELECT proposed_fix FROM evolver_proposals
      WHERE status = 'approved'
        AND (affected_companies @> ARRAY['growth'] OR affected_companies IS NULL)
        AND implemented_at IS NULL LIMIT 3
    `.catch(() => []),
    sql`
      SELECT id, title, description, priority, acceptance, status
      FROM company_tasks
      WHERE company_id = ${company.id} AND category = 'growth'
        AND status IN ('proposed', 'approved')
      ORDER BY priority ASC, created_at ASC LIMIT 5
    `.catch(() => []),
  ]);

  const research: Record<string, { summary: string; content: unknown }> = {};
  for (const r of reports) {
    research[r.report_type] = { summary: r.summary, content: r.content };
  }

  // Compute validation so Growth knows phase constraints
  const businessType = normalizeBusinessType(company.company_type);
  const growthMetrics = await sql`
    SELECT date, page_views, signups, waitlist_signups, waitlist_total,
      revenue, mrr, customers, pricing_page_views, pricing_cta_clicks,
      affiliate_clicks, affiliate_revenue
    FROM metrics WHERE company_id = ${company.id}
    ORDER BY date DESC LIMIT 14
  `.catch(() => []);
  const validation = computeValidationScore(businessType, growthMetrics as Parameters<typeof computeValidationScore>[1], company.created_at);

  // Phase gate: filter out growth tasks that violate the current validation phase
  type GrowthTask = { id: string; title: string; description: string; priority: number; acceptance: string; status: string };
  let filteredGrowthTasks = tasks as GrowthTask[];
  const gatedGrowthTasks: string[] = [];
  if (validation.forbidden && validation.forbidden.length > 0) {
    filteredGrowthTasks = [];
    for (const task of tasks as GrowthTask[]) {
      const violations = checkForbidden(`${task.title}: ${task.description}`, validation.forbidden, validation.phase);
      if (violations.length > 0) {
        gatedGrowthTasks.push(`${task.title} (violates: ${violations[0].rule})`);
      } else {
        filteredGrowthTasks.push(task);
      }
    }
  }

  return {
    company: {
      name: company.name,
      slug: company.slug,
      description: company.description,
      capabilities: company.capabilities,
    },
    validation,
    ceo_plan: cycle[0]?.ceo_plan || null,
    research,
    metrics: metrics.map((m: Record<string, unknown>) => ({
      date: m.date, mrr: m.mrr, customers: m.customers,
      page_views: m.page_views, signups: m.signups, waitlist: m.waitlist_total,
    })),
    playbook: playbook.map((p: { domain: string; insight: string }) => `${p.domain}: ${p.insight}`),
    evolver_proposals: proposals.map((p: { proposed_fix: string }) => p.proposed_fix),
    growth_tasks: filteredGrowthTasks,
    ...(gatedGrowthTasks.length > 0 ? { phase_gated_tasks: gatedGrowthTasks } : {}),
    hive_capabilities: getCapabilitySummary(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fixContext(sql: any, company: any) {
  const [errors, fixes, patterns] = await Promise.all([
    sql`
      SELECT agent, error, description, action_type, finished_at
      FROM agent_actions WHERE company_id = ${company.id} AND status = 'failed'
        AND finished_at > NOW() - INTERVAL '48 hours'
      ORDER BY finished_at DESC LIMIT 10
    `.catch(() => []),
    sql`
      SELECT description FROM agent_actions
      WHERE company_id = ${company.id}
        AND action_type IN ('error_fix', 'ops_escalation')
        AND status = 'success' AND finished_at > NOW() - INTERVAL '30 days'
      ORDER BY finished_at DESC LIMIT 5
    `.catch(() => []),
    sql`
      SELECT description FROM agent_actions
      WHERE action_type = 'error_fix' AND status = 'success'
        AND company_id != ${company.id}
        AND finished_at > NOW() - INTERVAL '60 days'
      ORDER BY finished_at DESC LIMIT 5
    `.catch(() => []),
  ]);

  return {
    errors,
    previous_fixes: fixes.map((f: { description: string }) => f.description),
    cross_company_patterns: patterns.map((p: { description: string }) => p.description),
    hive_capabilities: getCapabilitySummary(),
  };
}
