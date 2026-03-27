import * as Sentry from "@sentry/nextjs";

export interface SentryTagOptions {
  company_id?: string;
  agent?: string;
  action_type?: string;
  route?: string;
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