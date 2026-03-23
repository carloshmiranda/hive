import { getDb, json, err } from "@/lib/db";
import { computeValidationScore, normalizeBusinessType, type MetricsRow } from "@/lib/validation";
import { checkForbidden } from "@/lib/phase-gate";

export const dynamic = "force-dynamic";

// POST /api/agents/validate-drift
// Called by chain dispatch after Engineer/Growth complete, before continuing the chain.
// Checks if the work done aligns with the company's current validation phase.
// Returns { ok: true, passed: boolean, violations: string[] }

export async function POST(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return err("Unauthorized", 401);
  }

  const body = await req.json();
  const { company_slug, agent, work_summary } = body;

  if (!company_slug) {
    return err("Missing company_slug", 400);
  }

  const sql = getDb();

  const [company] = await sql`
    SELECT id, company_type, created_at FROM companies WHERE slug = ${company_slug} LIMIT 1
  `.catch(() => []);
  if (!company) return err("Company not found", 404);

  // Get current metrics to compute validation phase
  const metrics = await sql`
    SELECT date, page_views, signups, waitlist_signups, waitlist_total,
      revenue, mrr, customers, pricing_page_views, pricing_cta_clicks,
      affiliate_clicks, affiliate_revenue
    FROM metrics WHERE company_id = ${company.id}
    ORDER BY date DESC LIMIT 14
  `.catch(() => []);

  const businessType = normalizeBusinessType(company.company_type);
  const validation = computeValidationScore(businessType, metrics as MetricsRow[], company.created_at);

  if (!validation.forbidden || validation.forbidden.length === 0) {
    return json({ ok: true, passed: true, violations: [], phase: validation.phase });
  }

  // Check work_summary against forbidden patterns using shared gate logic
  const violations: string[] = [];

  const summaryViolations = checkForbidden(work_summary || "", validation.forbidden, validation.phase);
  for (const v of summaryViolations) {
    violations.push(`Phase "${validation.phase}" forbids: ${v.rule}. Found "${v.matched_pattern}" in work summary.`);
  }

  // Also check recent agent_actions for this company+agent to detect drift
  if (agent) {
    const recentActions = await sql`
      SELECT description FROM agent_actions
      WHERE company_id = ${company.id} AND agent = ${agent}
      AND status = 'success' AND started_at > NOW() - INTERVAL '2 hours'
      ORDER BY started_at DESC LIMIT 5
    `.catch(() => []);

    for (const action of recentActions) {
      const actionViolations = checkForbidden(action.description || "", validation.forbidden, validation.phase);
      for (const v of actionViolations) {
        violations.push(`Agent "${agent}" action violates phase "${validation.phase}": ${v.rule}`);
      }
    }
  }

  // Log drift detection if violations found
  if (violations.length > 0) {
    await sql`
      INSERT INTO agent_actions (company_id, agent, action_type, description, status, started_at, finished_at)
      VALUES (
        ${company.id}, 'sentinel', 'drift_detection',
        ${`Phase "${validation.phase}" drift detected: ${violations.length} violation(s). ${violations[0]}`},
        'pending', NOW(), NOW()
      )
    `.catch(() => {});
  }

  return json({
    ok: true,
    passed: violations.length === 0,
    phase: validation.phase,
    gating_rules: validation.gating_rules,
    forbidden: validation.forbidden,
    violations,
  });
}

