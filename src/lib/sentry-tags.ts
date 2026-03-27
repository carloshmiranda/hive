import * as Sentry from "@sentry/nextjs";

/**
 * Set standardized Sentry tags for API routes
 * This provides consistent tagging for better error triage and filtering
 */
export interface SentryApiTags {
  /** The API route path */
  route: string;
  /** The action being performed (e.g., "dispatch", "health_check", "approve") */
  action_type: string;
  /** Company slug when request is company-specific */
  company_id?: string;
  /** Agent name when request is agent-specific */
  agent?: string;
}

/**
 * Set Sentry tags for API route context
 * Call this early in your API handler for consistent error enrichment
 */
export function setSentryApiTags(tags: SentryApiTags) {
  Sentry.setTag("route", tags.route);
  Sentry.setTag("action_type", tags.action_type);

  if (tags.company_id) {
    Sentry.setTag("company_id", tags.company_id);
  }

  if (tags.agent) {
    Sentry.setTag("agent", tags.agent);
  }
}

/**
 * Extract route path from NextRequest for consistent tagging
 * Converts /api/agents/dispatch?company=foo to /api/agents/dispatch
 */
export function extractRoutePath(req: Request): string {
  try {
    const url = new URL(req.url);
    return url.pathname;
  } catch {
    return "unknown_route";
  }
}