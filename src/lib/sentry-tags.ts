import * as Sentry from "@sentry/nextjs";

export interface SentryTagContext {
  company_id?: string | number;
  agent?: string;
  action_type?: string;
}

/**
 * Set custom Sentry tags for API routes to improve error tracking and filtering.
 * Tags are indexed and searchable in Sentry dashboard.
 */
export function setSentryTags(context: SentryTagContext): void {
  if (context.company_id) {
    Sentry.setTag("company_id", String(context.company_id));
  }

  if (context.agent) {
    Sentry.setTag("agent", context.agent);
  }

  if (context.action_type) {
    Sentry.setTag("action_type", context.action_type);
  }
}

/**
 * Extract company slug/id from URL path for Sentry tagging.
 * Examples: /api/companies/verdedesk -> "verdedesk", /api/cycles?company_id=123 -> "123"
 */
export function extractCompanyFromRequest(request: Request): string | null {
  const url = new URL(request.url);

  // Check URL search params for company_id or company_slug
  const companyId = url.searchParams.get("company_id");
  const companySlug = url.searchParams.get("company_slug");

  if (companyId) return companyId;
  if (companySlug) return companySlug;

  // Check path segments for company identifiers
  const pathSegments = url.pathname.split("/").filter(Boolean);
  const apiIndex = pathSegments.findIndex(segment => segment === "api");

  if (apiIndex >= 0 && pathSegments.length > apiIndex + 2) {
    const endpoint = pathSegments[apiIndex + 1];
    const identifier = pathSegments[apiIndex + 2];

    // Common patterns: /api/companies/{slug}, /api/cycles/{company_slug}, etc.
    if (["companies", "cycles", "metrics"].includes(endpoint)) {
      return identifier;
    }
  }

  return null;
}

/**
 * Extract action type from HTTP method and URL path for Sentry tagging.
 * Examples: POST /api/companies -> "create_company", GET /api/metrics -> "fetch_metrics"
 */
export function extractActionTypeFromRequest(request: Request): string {
  const method = request.method.toLowerCase();
  const url = new URL(request.url);
  const pathSegments = url.pathname.split("/").filter(Boolean);

  if (pathSegments.length < 2) {
    return `${method}_unknown`;
  }

  const endpoint = pathSegments[pathSegments.length - 1];

  // Map HTTP methods to action prefixes
  const methodPrefix = {
    get: "fetch",
    post: "create",
    put: "update",
    patch: "update",
    delete: "delete"
  }[method] || method;

  return `${methodPrefix}_${endpoint}`;
}