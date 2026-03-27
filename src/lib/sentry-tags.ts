import * as Sentry from "@sentry/nextjs";

interface ApiContext {
  company_id?: string;
  agent?: string;
  action_type?: string;
  route?: string;
  method?: string;
}

/**
 * Add contextual Sentry tags for API route debugging and monitoring.
 * Call this at the start of API handlers to enrich error reports.
 *
 * @param context - Context information to tag
 */
export function setSentryTags(context: ApiContext): void {
  Sentry.withScope((scope) => {
    if (context.company_id) {
      scope.setTag("company_id", context.company_id);
    }

    if (context.agent) {
      scope.setTag("agent", context.agent);
    }

    if (context.action_type) {
      scope.setTag("action_type", context.action_type);
    }

    if (context.route) {
      scope.setTag("route", context.route);
    }

    if (context.method) {
      scope.setTag("method", context.method);
    }
  });
}

/**
 * Extract context from API request URL and body for Sentry tagging.
 *
 * @param req - Next.js Request object
 * @param body - Optional parsed request body
 * @returns Context object with available fields
 */
export async function extractApiContext(req: Request, body?: any): Promise<ApiContext> {
  const url = new URL(req.url);
  const searchParams = url.searchParams;

  // Extract route from pathname
  const route = url.pathname.replace(/^\/api\//, '');

  // Extract context from different sources
  const context: ApiContext = {
    route,
    method: req.method,
  };

  // Try to get company_id from various sources
  context.company_id =
    searchParams.get("company_id") ||
    body?.company_id ||
    body?.cycle?.company_id;

  // Try to get agent from various sources
  context.agent =
    searchParams.get("agent") ||
    body?.agent ||
    body?.payload?.agent;

  // Try to get action_type from various sources
  context.action_type =
    searchParams.get("action_type") ||
    body?.action_type ||
    body?.payload?.action_type ||
    // Derive action_type from route patterns
    deriveActionTypeFromRoute(route, req.method);

  return context;
}

/**
 * Derive action_type from route patterns when not explicitly provided.
 */
function deriveActionTypeFromRoute(route: string, method: string): string | undefined {
  // Common patterns for action type derivation
  if (route.includes('dispatch')) return 'dispatch';
  if (route.includes('webhook')) return 'webhook';
  if (route.includes('cron')) return 'cron';
  if (route.includes('health')) return 'health_check';
  if (route.includes('metrics')) return 'metrics';
  if (route.includes('auth')) return 'auth';
  if (route.includes('approve')) return 'approval';

  // Generic patterns based on HTTP method
  if (method === 'GET' && route.includes('actions')) return 'action_query';
  if (method === 'POST' && route.includes('actions')) return 'action_log';
  if (method === 'GET') return 'query';
  if (method === 'POST') return 'create';
  if (method === 'PUT' || method === 'PATCH') return 'update';
  if (method === 'DELETE') return 'delete';

  return undefined;
}

/**
 * Convenience function to set Sentry tags from request.
 * Combines extraction and tagging in one call.
 *
 * @param req - Next.js Request object
 * @param body - Optional parsed request body
 */
export async function setSentryTagsFromRequest(req: Request, body?: any): Promise<void> {
  const context = await extractApiContext(req, body);
  setSentryTags(context);
}