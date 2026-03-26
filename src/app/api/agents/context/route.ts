import { NextRequest } from "next/server";
import { validateOIDC } from "@/lib/oidc";
import { getDb, json, err } from "@/lib/db";
import { computeValidationScore, normalizeBusinessType } from "@/lib/validation";
import { getCapabilitySummary } from "@/lib/hive-capabilities";
import { checkForbidden } from "@/lib/phase-gate";
import { normalizeError, errorSimilarity } from "@/lib/error-normalize";
import { getCachedContext, setCachedContext, type AgentType } from "@/lib/cache";

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

  if (!['build', 'growth', 'fix'].includes(agent)) {
    return err(`Unknown agent type: ${agent}`, 400);
  }

  const sql = getDb();

  const [company] = await sql`
    SELECT id, name, slug, description, capabilities, company_type, market, content_language, created_at
    FROM companies WHERE slug = ${slug} LIMIT 1
  `.catch(() => []);

  if (!company) {
    return json({});
  }

  // Get the current running cycle ID for cache key
  const [currentCycle] = await sql`
    SELECT id FROM cycles
    WHERE company_id = ${company.id} AND status = 'running'
    ORDER BY started_at DESC LIMIT 1
  `.catch(() => []);

  const cycleId = currentCycle?.id || null;
  const agentType = agent as AgentType;

  // Try cache first
  const cached = await getCachedContext(company.id, agentType, cycleId);
  if (cached) {
    return json(cached);
  }

  // Cache miss - compute context from DB
  let contextData;
  if (agent === "build") {
    contextData = await buildContext(sql, company);
  } else if (agent === "growth") {
    contextData = await growthContext(sql, company);
  } else if (agent === "fix") {
    contextData = await fixContext(sql, company);
  } else {
    return err(`Unknown agent type: ${agent}`, 400);
  }

  // Store in cache for future requests
  await setCachedContext(company.id, agentType, contextData, cycleId);

  return json(contextData);
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
      WHERE confidence >= 0.6
        AND (content_language IS NULL OR content_language = ${company.content_language || 'en'})
      ORDER BY confidence DESC LIMIT 5
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

  // Context optimization: use summaries by default, full content only when requested
  // Research reports can be 10-50KB each; summaries are ~200 bytes
  const research: Record<string, { summary: string; content?: unknown }> = {};
  for (const r of reports) {
    research[r.report_type] = { summary: r.summary };
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
    content_language: company.content_language || "en",
    market: company.market || "global",
    language_rule: `ALL user-facing content MUST be in ${(company.content_language || "en") === "pt" ? "Portuguese" : "English"}. This includes: page text, meta tags, alt text, error messages, button labels, headings. Do NOT mix languages.`,
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
      WHERE confidence >= 0.6
        AND (content_language IS NULL OR content_language = ${company.content_language || 'en'})
      ORDER BY confidence DESC LIMIT 10
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

  // Context optimization: summaries only (saves 20-50KB per Growth context call)
  const research: Record<string, { summary: string }> = {};
  for (const r of reports) {
    research[r.report_type] = { summary: r.summary };
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
      content_language: company.content_language || "en",
      market: company.market || "global",
    },
    language_rule: `ALL content MUST be written in ${(company.content_language || "en") === "pt" ? "Portuguese" : "English"}. Blog posts, SEO pages, social media, meta tags — everything in one language. Do NOT mix languages.`,
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

  // Look up known fixes from error_patterns for each recent error
  const SIMILARITY_THRESHOLD = 0.6;
  type KnownFix = {
    error_pattern: string;
    fix_summary: string;
    fix_detail: string | null;
    occurrences: number;
    auto_fixable: boolean;
    similarity: number;
  };
  const knownFixes: KnownFix[] = [];

  if (errors.length > 0) {
    const resolvedPatterns = await sql`
      SELECT pattern, agent, fix_summary, fix_detail, occurrences, auto_fixable
      FROM error_patterns
      WHERE resolved = true
      ORDER BY occurrences DESC, last_seen_at DESC
      LIMIT 100
    `.catch(() => []);

    if (resolvedPatterns.length > 0) {
      const seenPatterns = new Set<string>();
      for (const error of errors) {
        if (!error.error) continue;
        const normalized = normalizeError(error.error as string);
        if (!normalized) continue;

        for (const rp of resolvedPatterns) {
          const rpPattern = rp.pattern as string;
          if (seenPatterns.has(rpPattern)) continue;
          const sim = errorSimilarity(normalized, rpPattern);
          if (sim >= SIMILARITY_THRESHOLD) {
            seenPatterns.add(rpPattern);
            knownFixes.push({
              error_pattern: rpPattern,
              fix_summary: rp.fix_summary as string,
              fix_detail: (rp.fix_detail as string) || null,
              occurrences: rp.occurrences as number,
              auto_fixable: rp.auto_fixable as boolean,
              similarity: Math.round(sim * 100) / 100,
            });
          }
        }
      }
      // Sort by similarity DESC, limit to top 5
      knownFixes.sort((a, b) => b.similarity - a.similarity || b.occurrences - a.occurrences);
      knownFixes.splice(5);
    }
  }

  return {
    errors,
    previous_fixes: fixes.map((f: { description: string }) => f.description),
    cross_company_patterns: patterns.map((p: { description: string }) => p.description),
    ...(knownFixes.length > 0 ? { known_fixes: knownFixes } : {}),
    hive_capabilities: getCapabilitySummary(),
  };
}
