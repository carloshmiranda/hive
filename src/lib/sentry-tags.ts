import * as Sentry from "@sentry/nextjs";

export interface SentryTagOptions {
  company_id?: string;
  agent?: string;
  action_type?: string;
  route?: string;
}

export type BreadcrumbCategory =
  | "dispatch"
  | "llm"
  | "db"
  | "qstash"
  | "github"
  | "rate_limit";

export interface DispatchBreadcrumbOptions {
  message: string;
  category: BreadcrumbCategory;
  level?: Sentry.SeverityLevel;
  data?: Record<string, unknown>;
}

/**
 * Add a structured breadcrumb to the current Sentry scope for dispatch chain tracing.
 * Breadcrumbs appear in the event timeline for any error captured after this call.
 */
export function addDispatchBreadcrumb(options: DispatchBreadcrumbOptions) {
  Sentry.addBreadcrumb({
    type: "default",
    category: `hive.${options.category}`,
    message: options.message,
    level: options.level ?? "info",
    data: options.data,
    timestamp: Date.now() / 1000,
  });
}

/**
 * Set custom Sentry tags for API routes to enable better error triage and filtering
 */
export function setSentryTags(options: SentryTagOptions) {
  if (options.company_id) {
    Sentry.setTag("company_id", options.company_id);
  }

  if (options.agent) {
    Sentry.setTag("agent", options.agent);
  }

  if (options.action_type) {
    Sentry.setTag("action_type", options.action_type);
  }

  if (options.route) {
    Sentry.setTag("route", options.route);
  }
}

/**
 * Wrap an async function in a Sentry performance span.
 * Spans appear in Sentry's performance tab and provide duration breakdowns
 * within a trace. Unlike breadcrumbs (which are chronological events),
 * spans measure how long each operation takes.
 *
 * @param name - Human-readable span name shown in Sentry
 * @param op - Operation category (ai.run, db.query, http.client, etc.)
 * @param attributes - Static attributes known before execution
 * @param fn - The async work to measure
 * @returns The result of fn, with the span automatically finished
 */
export async function withSpan<T>(
  name: string,
  op: string,
  attributes: Record<string, string | number | boolean>,
  fn: (span: ReturnType<typeof Sentry.startInactiveSpan>) => Promise<T>
): Promise<T> {
  return Sentry.startSpan({ name, op, attributes }, (span) => fn(span));
}

/**
 * Extract action type from route path for consistent tagging
 */
export function getActionTypeFromRoute(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean);

  // Handle specific patterns
  if (segments.includes('cron')) return 'cron';
  if (segments.includes('webhooks')) return 'webhook';
  if (segments.includes('agents')) return 'agent_api';
  if (segments.includes('auth')) return 'auth';
  if (segments.includes('admin')) return 'admin';

  // Default based on last meaningful segment
  const lastSegment = segments[segments.length - 1];
  if (lastSegment === 'route.ts') {
    return segments[segments.length - 2] || 'api';
  }

  return lastSegment || 'api';
}