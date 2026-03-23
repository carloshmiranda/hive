import { getDb, json, err } from "@/lib/db";
import { computeValidationScore, normalizeBusinessType, type MetricsRow } from "@/lib/validation";

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

  // Check work_summary against forbidden patterns
  const violations: string[] = [];
  const summary = (work_summary || "").toLowerCase();

  for (const rule of validation.forbidden) {
    // Extract key terms from forbidden rule and check if work touches them
    const ruleTerms = rule.toLowerCase();

    // Match specific forbidden patterns against work summary
    const patterns = extractPatterns(ruleTerms);
    for (const pattern of patterns) {
      if (summary.includes(pattern)) {
        violations.push(`Phase "${validation.phase}" forbids: ${rule}. Found "${pattern}" in work summary.`);
      }
    }
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
      const desc = (action.description || "").toLowerCase();
      for (const rule of validation.forbidden) {
        const patterns = extractPatterns(rule.toLowerCase());
        for (const pattern of patterns) {
          if (desc.includes(pattern)) {
            violations.push(`Agent "${agent}" action violates phase "${validation.phase}": ${rule}`);
          }
        }
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

// Extract meaningful keywords from forbidden rule text
function extractPatterns(rule: string): string[] {
  const patterns: string[] = [];

  // Common forbidden terms mapped to detectable patterns
  const termMap: Record<string, string[]> = {
    "auth": ["auth", "login", "register", "signup form", "session"],
    "dashboard": ["dashboard", "admin panel"],
    "crud": ["crud", "create, read, update", "user management"],
    "product features": ["product feature", "user account", "settings page", "profile"],
    "stripe checkout": ["stripe checkout", "payment form", "checkout page"],
    "database schema for product": ["user table", "product table", "orders table"],
    "monetization": ["ads", "sponsorship", "affiliate link", "ad revenue"],
    "paid traffic": ["paid ads", "google ads", "facebook ads", "paid campaign"],
    "login": ["login page", "login form", "/login", "sign in"],
    "register": ["register page", "registration", "/register", "sign up form"],
  };

  for (const [key, values] of Object.entries(termMap)) {
    if (rule.includes(key)) {
      patterns.push(...values);
    }
  }

  // If no specific patterns matched, use the rule text itself (simplified)
  if (patterns.length === 0) {
    // Extract noun phrases: split by commas and parentheses
    const parts = rule.split(/[,()]/);
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.length > 3 && trimmed.length < 40) {
        patterns.push(trimmed);
      }
    }
  }

  return patterns;
}
