import { NextRequest } from "next/server";
import { validateOIDC } from "@/lib/oidc";
import { getDb, json, err } from "@/lib/db";
import { computeValidationScore, normalizeBusinessType, checkCEOScoreKillTrigger } from "@/lib/validation";
import { getCapabilitySummary } from "@/lib/hive-capabilities";
import { checkForbidden } from "@/lib/phase-gate";
import { normalizeError, errorSimilarity } from "@/lib/error-normalize";
import { getCachedContext, setCachedContext, type AgentType } from "@/lib/cache";
import { selectEntriesWithMMR, type PlaybookEntry } from "@/lib/mmr";
import { cachedPlaybook, cachedCompanyList } from "@/lib/redis-cache";
import { calculateWoWGrowthRates, generateGrowthSummary } from "@/lib/growth-metrics";
import { setSentryTags } from "@/lib/sentry-tags";

// Domain mappings for agent-specific playbook filtering
function getAgentDomains(agent: string): string[] | null {
  switch (agent) {
    case 'build':
    case 'fix':
      return ['engineering', 'infrastructure', 'payments', 'auth', 'deployment'];
    case 'growth':
      return ['growth', 'seo', 'email_marketing', 'content', 'social'];
    case 'ceo':
    case 'scout':
    case 'evolver':
      return null; // No filtering - all domains
    default:
      return null;
  }
}

// GET /api/agents/context?agent=build|growth|fix&company_slug=X
export async function GET(req: NextRequest) {
  setSentryTags({
    action_type: "agent_api",
    route: "/api/agents/context",
  });

  const result = await validateOIDC(req);
  if (result instanceof Response) return result;

  const { searchParams } = new URL(req.url);
  const agent = searchParams.get("agent");
  const slug = searchParams.get("company_slug");

  // Portfolio-level agents (scout, evolver) don't need a company_slug
  const PORTFOLIO_AGENTS = ['scout', 'evolver'];
  const COMPANY_AGENTS = ['build', 'growth', 'fix', 'ceo'];
  const ALL_AGENTS = [...COMPANY_AGENTS, ...PORTFOLIO_AGENTS];

  if (!agent) {
    return err("Missing agent query param", 400);
  }
  if (!ALL_AGENTS.includes(agent)) {
    return err(`Unknown agent type: ${agent}`, 400);
  }
  if (COMPANY_AGENTS.includes(agent) && !slug) {
    return err(`Agent type '${agent}' requires company_slug query param`, 400);
  }

  // Add agent tag to Sentry
  setSentryTags({ agent });

  const sql = getDb();
  const agentType = agent as AgentType;

  // Portfolio-level agents don't need a company
  if (PORTFOLIO_AGENTS.includes(agent)) {
    const cacheKey = `_portfolio:${agent}`;
    const cached = await getCachedContext(cacheKey, agentType);
    if (cached) return json(cached);

    let contextData;
    if (agent === "scout") {
      contextData = await scoutContext(sql);
    } else {
      contextData = await evolverContext(sql);
    }
    await setCachedContext(cacheKey, agentType, contextData);
    return json(contextData);
  }

  // Company-level agents
  const [company] = await sql`
    SELECT id, name, slug, description, capabilities, company_type, market, content_language, created_at
    FROM companies WHERE slug = ${slug} LIMIT 1
  `.catch(() => []);

  if (!company) {
    return json({});
  }

  // Add company_id tag to Sentry
  setSentryTags({ company_id: company.id });

  // Get the current running cycle ID for cache key
  const [currentCycle] = await sql`
    SELECT id FROM cycles
    WHERE company_id = ${company.id} AND status = 'running'
    ORDER BY started_at DESC LIMIT 1
  `.catch(() => []);

  const cycleId = currentCycle?.id || null;

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
  } else if (agent === "ceo") {
    contextData = await ceoContext(sql, company);
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
    cachedPlaybook('engineering', () =>
      sql`
        SELECT domain, insight FROM playbook
        WHERE confidence >= 0.6
          AND (content_language IS NULL OR content_language = ${company.content_language || 'en'})
          AND domain = ANY(${['engineering', 'infrastructure', 'payments', 'auth', 'deployment']})
        ORDER BY confidence DESC LIMIT 5
      `.catch(() => [])
    ),
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
    playbook: (playbook as any[]).map((p: { domain: string; insight: string }) => `${p.domain}: ${p.insight}`),
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
    cachedPlaybook('growth', () =>
      sql`
        SELECT domain, insight FROM playbook
        WHERE confidence >= 0.6
          AND (content_language IS NULL OR content_language = ${company.content_language || 'en'})
          AND domain = ANY(${['growth', 'seo', 'email_marketing', 'content', 'social']})
        ORDER BY confidence DESC LIMIT 10
      `.catch(() => [])
    ),
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
    playbook: (playbook as any[]).map((p: { domain: string; insight: string }) => `${p.domain}: ${p.insight}`),
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

// ─── CEO context (per-company, strategic planning + review) ───
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ceoContext(sql: any, company: any) {
  const [cycle, reports, allPlaybookEntries, engTasks, growthTasks, metrics, directives, recentCycles, portfolioData] = await Promise.all([
    sql`
      SELECT id, cycle_number, ceo_plan, ceo_review FROM cycles
      WHERE company_id = ${company.id}
      ORDER BY started_at DESC LIMIT 1
    `.catch(() => []),
    sql`
      SELECT report_type, summary FROM research_reports
      WHERE company_id = ${company.id}
        AND report_type IN ('market_research','competitive_analysis','seo_keywords','product_spec')
      ORDER BY updated_at DESC
    `.catch(() => []),
    cachedPlaybook(null, () =>
      sql`
        SELECT domain, insight, confidence FROM playbook
        WHERE (content_language IS NULL OR content_language = ${company.content_language || 'en'})
          AND superseded_by IS NULL
          AND confidence >= 0.3
        ORDER BY confidence DESC
      `.catch(() => [])
    ),
    sql`
      SELECT id, title, status, priority FROM company_tasks
      WHERE company_id = ${company.id} AND category = 'engineering'
        AND status IN ('proposed', 'approved', 'in_progress')
      ORDER BY priority ASC LIMIT 10
    `.catch(() => []),
    sql`
      SELECT id, title, status, priority FROM company_tasks
      WHERE company_id = ${company.id} AND category = 'growth'
        AND status IN ('proposed', 'approved', 'in_progress')
      ORDER BY priority ASC LIMIT 5
    `.catch(() => []),
    sql`
      SELECT date, page_views, signups, waitlist_signups, waitlist_total,
        revenue, mrr, customers, pricing_page_views, pricing_cta_clicks,
        affiliate_clicks, affiliate_revenue
      FROM metrics WHERE company_id = ${company.id}
      ORDER BY date DESC LIMIT 14
    `.catch(() => []),
    sql`
      SELECT id, text FROM directives
      WHERE company_id = ${company.id} AND status = 'open'
      ORDER BY created_at DESC LIMIT 5
    `.catch(() => []),
    sql`
      SELECT cycle_number, ceo_review->>'score' as score,
             ceo_review->>'agent_grades' as agent_grades
      FROM cycles WHERE company_id = ${company.id}
        AND ceo_review IS NOT NULL
      ORDER BY started_at DESC LIMIT 3
    `.catch(() => []),
    // Portfolio summary data
    getPortfolioSummary(sql),
  ]);

  const research: Record<string, string> = {};
  for (const r of reports) {
    research[r.report_type] = r.summary;
  }

  const businessType = normalizeBusinessType(company.company_type);
  const validation = computeValidationScore(businessType, metrics, company.created_at);

  // Apply MMR to select diverse, relevant playbook entries
  const selectedPlaybook = selectEntriesWithMMR(allPlaybookEntries as PlaybookEntry[], 10, 0.7);

  // Calculate WoW growth rates
  const growthRates = calculateWoWGrowthRates(metrics);
  const growthSummary = generateGrowthSummary(growthRates);

  // Add portfolio context with current company highlighted
  const portfolioContext = await enrichPortfolioWithContext(sql, portfolioData, company.id);

  // Check for CEO score kill evaluation trigger
  const ceoScoreKillTrigger = checkCEOScoreKillTrigger(recentCycles.map((c: { cycle_number: number; score: string }) => ({
    cycle_number: c.cycle_number,
    score: c.score
  })));

  // Combine all kill evaluation triggers
  const allKillEvaluationTriggers = [...validation.kill_evaluation_triggers];
  if (ceoScoreKillTrigger) {
    allKillEvaluationTriggers.push(ceoScoreKillTrigger);
  }

  return {
    company: {
      name: company.name,
      slug: company.slug,
      description: company.description,
      capabilities: company.capabilities,
      business_type: businessType,
      content_language: company.content_language || "en",
      market: company.market || "global",
    },
    validation,
    kill_evaluation_triggers: allKillEvaluationTriggers,
    cycle: cycle[0] ? {
      id: cycle[0].id,
      cycle_number: cycle[0].cycle_number,
      ceo_plan: cycle[0].ceo_plan,
      last_review: cycle[0].ceo_review,
    } : null,
    recent_scores: recentCycles.map((c: { cycle_number: number; score: string; agent_grades: string }) => ({
      cycle: c.cycle_number, score: c.score, grades: c.agent_grades,
    })),
    research,
    playbook: selectedPlaybook.map((p: { domain: string; insight: string }) => `${p.domain}: ${p.insight}`),
    engineering_tasks: engTasks,
    growth_tasks: growthTasks,
    directives: directives.map((d: { id: string; text: string }) => ({ id: d.id, instruction: d.text })),
    metrics: metrics.slice(0, 7),
    growth_rates: growthRates,
    growth_summary: growthSummary,
    portfolio_summary: portfolioContext,
    hive_capabilities: getCapabilitySummary(),
  };
}

// ─── Scout context (portfolio-level, idea generation + research) ───
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function scoutContext(sql: any) {
  const [companies, killed, rejected, pendingCount, playbook] = await Promise.all([
    cachedCompanyList(() =>
      sql`
        SELECT name, slug, description, status, company_type, market, content_language
        FROM companies ORDER BY created_at DESC
      `.catch(() => []),
      "all"
    ),
    sql`
      SELECT name, description, kill_reason FROM companies
      WHERE status = 'killed' AND killed_at > NOW() - INTERVAL '90 days'
    `.catch(() => []),
    sql`
      SELECT title, decision_note FROM approvals
      WHERE gate_type = 'new_company' AND status = 'rejected'
        AND decided_at > NOW() - INTERVAL '90 days'
    `.catch(() => []),
    sql`
      SELECT COUNT(*)::int as count FROM approvals
      WHERE gate_type = 'new_company' AND status = 'pending'
    `.catch(() => [{ count: 0 }]),
    cachedPlaybook(null, () =>
      sql`
        SELECT domain, insight, confidence FROM playbook
        WHERE superseded_by IS NULL AND confidence >= 0.5
        ORDER BY confidence DESC LIMIT 20
      `.catch(() => [])
    ),
  ]);

  const active = (companies as any[]).filter((c: { status: string }) => ['mvp', 'active'].includes(c.status));
  const pipeline = (companies as any[]).filter((c: { status: string }) => ['idea', 'approved', 'provisioning'].includes(c.status));

  return {
    portfolio: {
      active_companies: active.map((c: { name: string; slug: string; description: string; company_type: string; market: string }) => ({
        name: c.name, slug: c.slug, description: c.description, type: c.company_type, market: c.market,
      })),
      pipeline_count: pipeline.length,
      pending_proposals: pendingCount[0]?.count || 0,
    },
    killed_companies: killed.map((c: { name: string; description: string; kill_reason: string }) => ({
      name: c.name, description: c.description, kill_reason: c.kill_reason,
    })),
    rejected_proposals: rejected.map((r: { title: string; decision_note: string }) => ({
      title: r.title, reason: r.decision_note,
    })),
    playbook: (playbook as any[]).map((p: { domain: string; insight: string; confidence: number }) =>
      `${p.domain} (${p.confidence}): ${p.insight}`
    ),
    markets_covered: [...new Set(active.map((c: { market: string }) => c.market).filter(Boolean))],
    types_covered: [...new Set(active.map((c: { company_type: string }) => c.company_type).filter(Boolean))],
  };
}

// ─── Evolver context (portfolio-level, gap detection + prompt improvement) ───
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function evolverContext(sql: any) {
  const [agentStats, cycleScores, stalled, repeatedErrors, playbookCoverage, pendingProposals] = await Promise.all([
    // Layer 1: Outcome gaps — agent success/failure rates (14 days)
    sql`
      SELECT agent,
        COUNT(*) FILTER (WHERE status = 'success')::int as successes,
        COUNT(*) FILTER (WHERE status = 'failed')::int as failures,
        COUNT(*)::int as total
      FROM agent_actions WHERE started_at > NOW() - INTERVAL '14 days'
      GROUP BY agent
    `.catch(() => []),
    // Cycle scores and agent grades (30 days)
    sql`
      SELECT co.slug, c.cycle_number, c.ceo_review->>'score' as score,
             c.ceo_review->'agent_grades' as agent_grades, c.started_at
      FROM cycles c JOIN companies co ON co.id = c.company_id
      WHERE c.started_at > NOW() - INTERVAL '30 days' AND c.ceo_review IS NOT NULL
      ORDER BY co.slug, c.cycle_number DESC
    `.catch(() => []),
    // Stalled companies (no activity in 48h)
    sql`
      SELECT c.slug, c.status, MAX(aa.finished_at) as last_activity
      FROM companies c LEFT JOIN agent_actions aa ON aa.company_id = c.id
      WHERE c.status IN ('mvp', 'active')
      GROUP BY c.id, c.slug, c.status
      HAVING MAX(aa.finished_at) < NOW() - INTERVAL '48 hours' OR MAX(aa.finished_at) IS NULL
    `.catch(() => []),
    // Layer 2: Capability gaps — repeated failures
    sql`
      SELECT agent, error, COUNT(*)::int as occurrences
      FROM agent_actions WHERE status = 'failed' AND started_at > NOW() - INTERVAL '14 days'
      GROUP BY agent, error HAVING COUNT(*) >= 3
      ORDER BY COUNT(*) DESC LIMIT 10
    `.catch(() => []),
    // Layer 3: Knowledge gaps — playbook coverage
    sql`
      SELECT domain, COUNT(*)::int as entries, ROUND(AVG(confidence)::numeric, 2) as avg_confidence
      FROM playbook WHERE superseded_by IS NULL
      GROUP BY domain ORDER BY entries DESC
    `.catch(() => []),
    // Existing pending proposals
    sql`
      SELECT id, title, status, gap_type FROM evolver_proposals
      WHERE status IN ('pending', 'deferred')
      ORDER BY created_at DESC LIMIT 10
    `.catch(() => []),
  ]);

  return {
    agent_performance: agentStats,
    cycle_scores: cycleScores.map((c: { slug: string; cycle_number: number; score: string; agent_grades: object; started_at: string }) => ({
      company_slug: c.slug,
      cycle_number: c.cycle_number,
      score: c.score,
      agent_grades: c.agent_grades,
      started_at: c.started_at,
    })),
    stalled_companies: stalled,
    repeated_errors: repeatedErrors.map((e: { agent: string; error: string; occurrences: number }) => ({
      agent: e.agent,
      error: (e.error || "").substring(0, 200),
      occurrences: e.occurrences,
    })),
    playbook_coverage: playbookCoverage,
    pending_proposals: pendingProposals,
  };
}

// ─── Portfolio Summary Helper Functions ───

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getPortfolioSummary(sql: any) {
  const [companies, allMetrics, cycleActivity] = await Promise.all([
    // Get all active companies (cached — invalidated on company create/update)
    cachedCompanyList(() =>
      sql`
        SELECT id, name, slug, description, company_type, market, created_at
        FROM companies
        WHERE status IN ('mvp', 'active')
        ORDER BY created_at ASC
      `.catch(() => []),
      "active"
    ),
    // Get latest metrics for all active companies
    sql`
      SELECT DISTINCT ON (company_id)
        company_id, date, page_views, waitlist_total, mrr, customers,
        revenue, signups, waitlist_signups
      FROM metrics m
      WHERE company_id IN (
        SELECT id FROM companies WHERE status IN ('mvp', 'active')
      )
      ORDER BY company_id, date DESC
    `.catch(() => []),
    // Get cycle activity in last 7 days
    sql`
      SELECT company_id, COUNT(*)::int as cycle_count
      FROM cycles
      WHERE started_at >= CURRENT_DATE - INTERVAL '7 days'
      GROUP BY company_id
    `.catch(() => []),
  ]);

  return { companies, allMetrics, cycleActivity };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function enrichPortfolioWithContext(sql: any, portfolioData: any, currentCompanyId: string) {
  const { companies, allMetrics, cycleActivity } = portfolioData;

  // Create a map for quick metric lookup
  const metricsMap = new Map();
  for (const metric of allMetrics) {
    metricsMap.set(metric.company_id, metric);
  }

  // Create cycle activity map
  const cycleMap = new Map();
  for (const cycle of cycleActivity) {
    cycleMap.set(cycle.company_id, cycle.cycle_count);
  }

  // Enrich companies with metrics and validation scores
  const enrichedCompanies = [];
  for (const company of companies) {
    const metric = metricsMap.get(company.id) || {};
    const businessType = normalizeBusinessType(company.company_type);

    // Get recent metrics for validation score calculation
    const companyMetrics = await sql`
      SELECT date, page_views, signups, waitlist_signups, waitlist_total,
        revenue, mrr, customers, pricing_page_views, pricing_cta_clicks,
        affiliate_clicks, affiliate_revenue
      FROM metrics WHERE company_id = ${company.id}
      ORDER BY date DESC LIMIT 14
    `.catch(() => []);

    const validation = computeValidationScore(businessType, companyMetrics, company.created_at);

    enrichedCompanies.push({
      id: company.id,
      name: company.name,
      slug: company.slug,
      market: company.market || 'global',
      page_views: metric.page_views || 0,
      waitlist: metric.waitlist_total || 0,
      mrr: metric.mrr || 0,
      validation_score: validation.score,
      validation_phase: validation.phase,
      cycles_last_7d: cycleMap.get(company.id) || 0,
      last_metric_date: metric.date || null,
      is_current: company.id === currentCompanyId,
    });
  }

  // Calculate percentile rankings
  const metrics = ['page_views', 'waitlist', 'mrr', 'validation_score'];
  const rankings = calculatePercentileRankings(enrichedCompanies, metrics);

  // Detect shared patterns - look for companies with significant metric changes
  const patterns = await detectSharedPatterns(sql, enrichedCompanies);

  // Resource allocation summary
  const totalCycles = enrichedCompanies.reduce((sum, c) => sum + c.cycles_last_7d, 0);
  const resourceAllocation = enrichedCompanies.map(c => ({
    company: c.name,
    cycles: c.cycles_last_7d,
    percentage: totalCycles > 0 ? Math.round((c.cycles_last_7d / totalCycles) * 100) : 0,
  }));

  return {
    companies: enrichedCompanies,
    rankings,
    patterns,
    resource_allocation: {
      total_cycles_7d: totalCycles,
      allocation: resourceAllocation,
    },
  };
}

// Calculate percentile rankings for each metric
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function calculatePercentileRankings(companies: any[], metrics: string[]) {
  const rankings: Record<string, Record<string, number>> = {};

  for (const metric of metrics) {
    const values = companies.map(c => c[metric]).filter(v => v != null);
    values.sort((a, b) => a - b);

    for (const company of companies) {
      if (!rankings[company.id]) rankings[company.id] = {};

      const value = company[metric];
      if (value == null) {
        rankings[company.id][metric] = 0;
      } else {
        const rank = values.filter(v => v < value).length;
        rankings[company.id][metric] = Math.round((rank / Math.max(values.length - 1, 1)) * 100);
      }
    }
  }

  return rankings;
}

// Detect shared patterns across companies
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function detectSharedPatterns(sql: any, companies: any[]) {
  const patterns: string[] = [];

  if (companies.length < 2) return patterns;

  // Get week-over-week changes for all companies
  const companyIds = companies.map(c => c.id);
  const wowChanges = await sql`
    SELECT
      company_id,
      COALESCE(LAG(page_views) OVER (PARTITION BY company_id ORDER BY date), 0) as prev_views,
      page_views as current_views,
      date
    FROM metrics
    WHERE company_id = ANY(${companyIds})
      AND date >= CURRENT_DATE - INTERVAL '14 days'
    ORDER BY company_id, date DESC
  `.catch(() => []);

  // Group by company for analysis
  const changesByCompany = new Map();
  for (const change of wowChanges) {
    if (!changesByCompany.has(change.company_id)) {
      changesByCompany.set(change.company_id, []);
    }
    changesByCompany.get(change.company_id).push(change);
  }

  // Look for shared traffic drops (>20% decrease)
  let companiesWithDrop = 0;
  for (const [, changes] of changesByCompany) {
    const latestChange = changes[0];
    if (latestChange && latestChange.prev_views > 0) {
      const percentChange = ((latestChange.current_views - latestChange.prev_views) / latestChange.prev_views) * 100;
      if (percentChange < -20) {
        companiesWithDrop++;
      }
    }
  }

  if (companiesWithDrop >= Math.ceil(companies.length * 0.5)) {
    patterns.push(`${companiesWithDrop}/${companies.length} companies show traffic drops >20% - likely external factor`);
  }

  // Check for companies with no recent activity
  const staleCompanies = companies.filter(c => !c.last_metric_date ||
    new Date(c.last_metric_date) < new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));

  if (staleCompanies.length > 0) {
    patterns.push(`${staleCompanies.length} companies have stale metrics (>7 days old)`);
  }

  // Check for resource imbalance
  const totalCycles = companies.reduce((sum, c) => sum + c.cycles_last_7d, 0);
  if (totalCycles > 0) {
    const topCompany = companies.reduce((max, c) => c.cycles_last_7d > max.cycles_last_7d ? c : max);
    const percentage = (topCompany.cycles_last_7d / totalCycles) * 100;
    if (percentage > 60) {
      patterns.push(`${topCompany.name} consuming ${Math.round(percentage)}% of cycles - potential resource imbalance`);
    }
  }

  return patterns;
}
