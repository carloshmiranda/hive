import { computeValidationScore, normalizeBusinessType, type MetricsRow } from "./validation";

// Shared phase-gating logic used by:
//   - POST /api/tasks (reject forbidden tasks at creation)
//   - GET /api/agents/context (filter tasks at delivery)
//   - POST /api/agents/validate-drift (check work after completion)

export type PhaseViolation = {
  rule: string;
  matched_pattern: string;
  phase: string;
};

// Extract meaningful keywords from forbidden rule text
// Shared term map used by all gates for consistent enforcement
const TERM_MAP: Record<string, string[]> = {
  auth: ["auth", "login", "register", "signup form", "session", "oauth", "jwt"],
  dashboard: ["dashboard", "admin panel", "admin page"],
  crud: ["crud", "create, read, update", "user management"],
  "product features": ["product feature", "user account", "settings page", "profile page", "preferences"],
  "stripe checkout": ["stripe checkout", "payment form", "checkout page", "billing page"],
  "database schema for product": ["user table", "product table", "orders table", "schema migration"],
  monetization: ["ads", "sponsorship", "affiliate link", "ad revenue", "adsense", "monetiz"],
  "paid traffic": ["paid ads", "google ads", "facebook ads", "paid campaign", "ppc", "sem campaign"],
  login: ["login page", "login form", "/login", "sign in"],
  register: ["register page", "registration", "/register", "sign up form"],
  "nice-to-have": ["nice-to-have", "nice to have", "polish", "animation", "dark mode", "theme"],
  "building the product": ["build product", "implement feature", "user flow", "onboarding flow"],
};

export function extractPatterns(rule: string): string[] {
  const patterns: string[] = [];

  for (const [key, values] of Object.entries(TERM_MAP)) {
    if (rule.includes(key)) {
      patterns.push(...values);
    }
  }

  // If no specific patterns matched, use the rule text itself (simplified)
  if (patterns.length === 0) {
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

// Check a single text string against a set of forbidden rules
export function checkForbidden(
  text: string,
  forbidden: string[],
  phase: string
): PhaseViolation[] {
  const violations: PhaseViolation[] = [];
  const lower = text.toLowerCase();

  for (const rule of forbidden) {
    const patterns = extractPatterns(rule.toLowerCase());
    for (const pattern of patterns) {
      if (lower.includes(pattern)) {
        violations.push({ rule, matched_pattern: pattern, phase });
      }
    }
  }

  return violations;
}

// Compute validation for a company and return the phase info
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getCompanyPhase(sql: any, companyId: string) {
  const [company] = await sql`
    SELECT company_type, created_at FROM companies WHERE id = ${companyId} LIMIT 1
  `.catch(() => []);

  if (!company) return null;

  const metrics = await sql`
    SELECT date, page_views, signups, waitlist_signups, waitlist_total,
      revenue, mrr, customers, pricing_page_views, pricing_cta_clicks,
      affiliate_clicks, affiliate_revenue
    FROM metrics WHERE company_id = ${companyId}
    ORDER BY date DESC LIMIT 14
  `.catch(() => []);

  const businessType = normalizeBusinessType(company.company_type);
  return computeValidationScore(businessType, metrics as MetricsRow[], company.created_at);
}

// Check if a task (title + description) violates the company's current phase
// Returns violations array (empty = allowed)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function validateTaskAgainstPhase(
  sql: any,
  companyId: string,
  title: string,
  description: string
): Promise<{ allowed: boolean; violations: PhaseViolation[]; phase: string | null }> {
  const validation = await getCompanyPhase(sql, companyId);
  if (!validation) return { allowed: true, violations: [], phase: null };

  if (!validation.forbidden || validation.forbidden.length === 0) {
    return { allowed: true, violations: [], phase: validation.phase };
  }

  const text = `${title}: ${description}`;
  const violations = checkForbidden(text, validation.forbidden, validation.phase);

  return {
    allowed: violations.length === 0,
    violations,
    phase: validation.phase,
  };
}
