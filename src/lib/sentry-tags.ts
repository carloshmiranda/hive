import * as Sentry from "@sentry/nextjs";

interface SentryTagContext {
  company_id?: string | number | null;
  agent?: string | null;
  request?: Request;
  custom_action_type?: string;
}

/**
 * Set Sentry tags for API route tracking
 * Call this at the start of API route handlers with available context
 */
export function setSentryTags(context: SentryTagContext = {}) {
  const { company_id, agent, request, custom_action_type } = context;

  // Set company_id tag if available
  if (company_id) {
    Sentry.setTag('company_id', String(company_id));
  }

  // Set agent tag if available
  if (agent) {
    Sentry.setTag('agent', agent);
  }

  // Derive action_type from request URL and method
  let action_type = custom_action_type;
  if (!action_type && request) {
    action_type = deriveActionType(request);
  }

  if (action_type) {
    Sentry.setTag('action_type', action_type);
  }
}

/**
 * Derive action type from HTTP request URL and method
 */
function deriveActionType(request: Request): string {
  const url = new URL(request.url);
  const method = request.method.toLowerCase();
  const pathname = url.pathname;

  // Handle specific API endpoints
  if (pathname.includes('/api/agents/dispatch')) return 'agent_dispatch';
  if (pathname.includes('/api/agents/')) {
    const agentAction = pathname.split('/api/agents/')[1]?.split('/')[0];
    return `agent_${agentAction || 'action'}`;
  }
  if (pathname.includes('/api/companies/') && pathname.includes('/assess')) return 'company_assess';
  if (pathname.includes('/api/companies/') && pathname.includes('/domain')) return 'company_domain';
  if (pathname.includes('/api/companies/')) return `company_${method}`;
  if (pathname.includes('/api/cycles/') && pathname.includes('/review')) return 'cycle_review';
  if (pathname.includes('/api/cycles/') && pathname.includes('/cleanup')) return 'cycle_cleanup';
  if (pathname.includes('/api/cycles/')) return `cycle_${method}`;
  if (pathname.includes('/api/approvals/') && pathname.includes('/decide')) return 'approval_decide';
  if (pathname.includes('/api/approvals/')) return `approval_${method}`;
  if (pathname.includes('/api/backlog/dispatch')) return 'backlog_dispatch';
  if (pathname.includes('/api/backlog/health')) return 'backlog_health';
  if (pathname.includes('/api/backlog/')) return `backlog_${method}`;
  if (pathname.includes('/api/tasks/')) return `task_${method}`;
  if (pathname.includes('/api/directives/') && pathname.includes('/close')) return 'directive_close';
  if (pathname.includes('/api/directives/')) return `directive_${method}`;
  if (pathname.includes('/api/webhooks/')) {
    const webhook = pathname.split('/api/webhooks/')[1]?.split('/')[0];
    return `webhook_${webhook || 'unknown'}`;
  }
  if (pathname.includes('/api/cron/')) {
    const cronJob = pathname.split('/api/cron/')[1]?.split('/')[0];
    return `cron_${cronJob || 'unknown'}`;
  }
  if (pathname.includes('/api/dispatch/')) {
    const dispatchAction = pathname.split('/api/dispatch/')[1]?.split('/')[0];
    return `dispatch_${dispatchAction || 'action'}`;
  }
  if (pathname === '/api/health') return 'health_check';
  if (pathname === '/api/health/public') return 'health_check_public';
  if (pathname === '/api/metrics') return `metrics_${method}`;
  if (pathname === '/api/settings') return `settings_${method}`;
  if (pathname === '/api/dashboard') return `dashboard_${method}`;
  if (pathname === '/api/portfolio') return `portfolio_${method}`;
  if (pathname === '/api/research') return `research_${method}`;
  if (pathname === '/api/playbook') return `playbook_${method}`;
  if (pathname === '/api/social') return `social_${method}`;
  if (pathname === '/api/todos') return `todos_${method}`;
  if (pathname === '/api/imports') return `imports_${method}`;
  if (pathname === '/api/notify') return `notify_${method}`;
  if (pathname === '/api/actions') return `actions_${method}`;
  if (pathname === '/api/evolver') return `evolver_${method}`;

  // Generic fallback
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length >= 2 && segments[0] === 'api') {
    const endpoint = segments[1];
    return `${endpoint}_${method}`;
  }

  return `api_${method}`;
}

/**
 * Set Sentry tags for agent operations
 * Convenience function for agent-related API routes
 */
export function setSentryAgentTags(agent: string, company_id?: string | number | null, action_type?: string) {
  setSentryTags({
    agent,
    company_id,
    custom_action_type: action_type
  });
}

/**
 * Set Sentry tags for company operations
 * Convenience function for company-related API routes
 */
export function setSentryCompanyTags(company_id: string | number, action_type?: string, request?: Request) {
  setSentryTags({
    company_id,
    custom_action_type: action_type,
    request
  });
}