/**
 * Hive Capability Registry — static manifest of Hive's own API endpoints.
 *
 * Gives agents self-awareness of what Hive can do programmatically.
 * Used by Sentinel to auto-resolve recurring escalations instead of
 * creating yet another approval gate for a known-solvable problem.
 */

export interface HiveCapability {
  id: string;
  endpoint: string;
  method: "GET" | "POST" | "PATCH";
  auth: "cron_secret" | "oidc" | "session";
  description: string;
  triggers: string[];
  params: Record<string, string>;
}

export const HIVE_CAPABILITIES: HiveCapability[] = [
  // --- Infrastructure repair & provisioning ---
  {
    id: "repair_infra",
    endpoint: "/api/agents/repair-infra",
    method: "POST",
    auth: "cron_secret",
    description:
      "Fix missing Neon DB, run schema, set Vercel env vars, repair broken deploys, unlink duplicate Vercel projects",
    triggers: [
      "neon_project_id IS NULL",
      "database not provisioned",
      "missing neon",
      "DATABASE_URL not set",
      "missing database",
      "connection_string missing",
      "schema tables missing",
      "missing tables",
      "deploy broken",
      "Vercel deploy broken",
      "HTTP 404",
      "HTTP 429",
      "duplicate Vercel project",
      "deploy broken after provision",
      "systemic bugs blocking",
      "needs manual fix",
    ],
    params: { company_slug: "Company slug to repair" },
  },
  {
    id: "provision",
    endpoint: "/api/agents/provision",
    method: "POST",
    auth: "oidc",
    description:
      "Full provisioning: create Neon DB + schema, Vercel project + analytics, set env vars, record infra",
    triggers: [
      "company not provisioned",
      "no vercel project",
      "no neon project",
      "infrastructure missing",
      "stuck in approved",
    ],
    params: {
      company_slug: "Company slug",
      company_id: "Company UUID",
    },
  },

  // --- Agent dispatch ---
  {
    id: "dispatch_worker",
    endpoint: "/api/agents/dispatch",
    method: "POST",
    auth: "cron_secret",
    description:
      "Dispatch worker agents (growth, outreach, ops) on Vercel serverless via Gemini/Groq",
    triggers: [
      "growth agent needed",
      "outreach needed",
      "ops check needed",
      "content stale",
      "leads stale",
      "health check needed",
    ],
    params: {
      company_slug: "Company slug",
      agent: "Agent name: growth | outreach | ops",
      trigger: "What triggered this dispatch",
    },
  },
  {
    id: "agent_context",
    endpoint: "/api/agents/context",
    method: "GET",
    auth: "oidc",
    description:
      "Get full company context for agent planning (build, growth, or fix context)",
    triggers: [],
    params: {
      agent: "Agent type: build | growth | fix",
      company_slug: "Company slug",
    },
  },

  // --- Research & intelligence ---
  {
    id: "research_type",
    endpoint: "/api/agents/research-type",
    method: "POST",
    auth: "oidc",
    description:
      "Research unknown business types: check if type exists or generate research prompt for new definition",
    triggers: [
      "unknown business type",
      "business_model not recognized",
      "missing type definition",
    ],
    params: {
      business_model: "Business model string to research",
      company_name: "Company name (optional)",
      company_description: "Company description (optional)",
    },
  },
  {
    id: "visibility_check",
    endpoint: "/api/agents/visibility",
    method: "POST",
    auth: "cron_secret",
    description:
      "Run GSC performance check + LLM citation tracking for a company",
    triggers: [
      "visibility metrics missing",
      "GSC data stale",
      "LLM citations not tracked",
      "search visibility unknown",
    ],
    params: {
      company_slug: "Company slug",
    },
  },
  {
    id: "extract_patterns",
    endpoint: "/api/agents/extract",
    method: "POST",
    auth: "oidc",
    description:
      "Phase 2 pattern extraction from imported/existing codebases — writes playbook entries",
    triggers: [
      "patterns not extracted",
      "playbook empty for company",
      "onboarding phase 2",
    ],
    params: {
      company_slug: "Company slug",
      company_id: "Company UUID",
      domains: "Optional: specific domains to extract (array)",
    },
  },

  // --- Cron / health ---
  {
    id: "sentinel",
    endpoint: "/api/cron/sentinel",
    method: "GET",
    auth: "cron_secret",
    description:
      "Run all 24 health checks, dispatch agents, expire stale approvals, detect anomalies",
    triggers: [],
    params: {},
  },
  {
    id: "metrics_cron",
    endpoint: "/api/cron/metrics",
    method: "GET",
    auth: "cron_secret",
    description:
      "Collect page_views, signups, revenue, and other metrics from all company /api/stats endpoints",
    triggers: [
      "metrics missing",
      "no metrics in 48h",
      "page_views not collected",
    ],
    params: {},
  },

  // --- Company management ---
  {
    id: "assess_company",
    endpoint: "/api/companies/{id}/assess",
    method: "POST",
    auth: "cron_secret",
    description:
      "Assess company capabilities by scanning its GitHub repo for features, tables, routes",
    triggers: [
      "capabilities unknown",
      "not assessed",
      "assessment stale",
      "last_assessed_at IS NULL",
    ],
    params: {
      id: "Company UUID (URL param)",
    },
  },
  {
    id: "company_tasks",
    endpoint: "/api/tasks",
    method: "POST",
    auth: "session",
    description:
      "Create tasks in the company task backlog (engineering, growth, research, qa, ops)",
    triggers: [
      "task backlog empty",
      "no proposed tasks",
      "work items needed",
    ],
    params: {
      company_id: "Company UUID",
      title: "Task title",
      category: "engineering | growth | research | qa | ops",
      priority: "1 (highest) to 5 (lowest)",
    },
  },
  {
    id: "update_task",
    endpoint: "/api/agents/tasks/{id}",
    method: "PATCH",
    auth: "oidc",
    description: "Update task status via OIDC auth (in_progress, done, approved)",
    triggers: [],
    params: {
      id: "Task UUID (URL param)",
      status: "in_progress | done | approved",
    },
  },

  // --- Approvals ---
  {
    id: "decide_approval",
    endpoint: "/api/approvals/{id}/decide",
    method: "POST",
    auth: "session",
    description:
      "Approve or reject an approval gate (new_company, growth_strategy, spend, etc.)",
    triggers: [],
    params: {
      id: "Approval UUID (URL param)",
      decision: "approved | rejected",
      decision_note: "Optional reason",
    },
  },

  // --- Knowledge ---
  {
    id: "write_playbook",
    endpoint: "/api/agents/playbook",
    method: "POST",
    auth: "oidc",
    description:
      "Write a cross-company playbook entry with domain, insight, evidence, confidence",
    triggers: [],
    params: {
      domain: "e.g. seo, pricing, growth, engineering",
      insight: "The learning",
      evidence: "Optional: what proved it",
      confidence: "0.0 to 1.0",
    },
  },
  {
    id: "log_action",
    endpoint: "/api/agents/log",
    method: "POST",
    auth: "oidc",
    description:
      "Log an agent action (success/failure) for audit trail and error correlation",
    triggers: [],
    params: {
      agent: "Agent name",
      action_type: "e.g. scaffold_company, execute_task",
      status: "success | failed",
      company_slug: "Optional company slug",
      description: "What happened",
    },
  },

  // --- Stripe ---
  {
    id: "create_stripe_product",
    endpoint: "/api/agents/stripe/product",
    method: "POST",
    auth: "oidc",
    description: "Create a Stripe product + price for a company",
    triggers: [
      "no stripe product",
      "stripe product missing",
      "payment not configured",
    ],
    params: {
      company_slug: "Company slug",
      name: "Product name",
      price_eur: "Price in EUR (number)",
      interval: "Optional: month | year",
    },
  },

  // --- Token exchange ---
  {
    id: "token_exchange",
    endpoint: "/api/agents/token",
    method: "POST",
    auth: "oidc",
    description:
      "Exchange OIDC token for service tokens (GitHub PAT, Vercel token) at runtime",
    triggers: [],
    params: {
      service: "github | vercel | neon | stripe | resend | gemini | groq",
      scope: "Optional: repo slug for scoped tokens",
    },
  },

  // --- Analytics ---
  {
    id: "enable_analytics",
    endpoint: "/api/agents/analytics",
    method: "POST",
    auth: "oidc",
    description:
      "Enable Vercel Web Analytics for a company (or all companies with { all: true })",
    triggers: [
      "analytics not enabled",
      "web analytics missing",
    ],
    params: {
      company_slug: "Company slug (or use all: true)",
    },
  },

  // --- Agent companies list ---
  {
    id: "list_companies",
    endpoint: "/api/agents/companies",
    method: "GET",
    auth: "cron_secret",
    description:
      "List active company slugs — used by GitHub Actions for dispatch matrix",
    triggers: [],
    params: {},
  },

  // --- Performance / costs ---
  {
    id: "agent_performance",
    endpoint: "/api/agents/performance",
    method: "GET",
    auth: "session",
    description:
      "Get agent performance report: grades per agent, trends, cycle scores",
    triggers: [],
    params: {},
  },
  {
    id: "agent_costs",
    endpoint: "/api/agents/costs",
    method: "GET",
    auth: "session",
    description:
      "Get estimated agent costs: turns used per agent/model, daily/weekly spend",
    triggers: [],
    params: {},
  },
];

/**
 * Fuzzy-match a problem description against capability triggers.
 * Returns the best-matching capability, or null if no match.
 *
 * Matching is case-insensitive substring search across all triggers.
 * Scores by number of trigger words that appear in the problem.
 */
export function findCapabilityForProblem(
  problem: string
): HiveCapability | null {
  if (!problem) return null;
  const lower = problem.toLowerCase();

  let bestMatch: HiveCapability | null = null;
  let bestScore = 0;

  for (const cap of HIVE_CAPABILITIES) {
    if (cap.triggers.length === 0) continue;

    let score = 0;
    for (const trigger of cap.triggers) {
      const triggerLower = trigger.toLowerCase();
      // Full trigger phrase match = high score
      if (lower.includes(triggerLower)) {
        score += 3;
        continue;
      }
      // Word-level match: count how many trigger words appear in the problem
      const words = triggerLower.split(/\s+/);
      const matchedWords = words.filter((w) => w.length > 3 && lower.includes(w));
      if (matchedWords.length >= 2) {
        score += 1;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestMatch = cap;
    }
  }

  // Require a minimum score to avoid false positives
  return bestScore >= 2 ? bestMatch : null;
}

/**
 * Returns a human-readable summary of all Hive capabilities.
 * Suitable for injection into agent system prompts.
 */
export function getCapabilitySummary(): string {
  const lines: string[] = [
    "HIVE AUTONOMOUS CAPABILITIES vs HUMAN APPROVAL GATES:",
    "",
    "🤖 AUTONOMOUS SERVICES (execute directly, no approval needed):",
    "  - Google Search Console (GSC): sitemap submission, search performance tracking",
    "  - GitHub: repo creation, code pushes, branch management, webhook processing",
    "  - Vercel: project creation/deletion, deployments, analytics, env vars",
    "  - Neon: database creation/deletion, schema setup, connection management",
    "  - Stripe: product/price creation, payment processing, customer management",
    "  - Resend: email sending (digest, outreach, transactional), domain verification",
    "  - Internal APIs: all /api/agents/* endpoints, metrics collection, health checks",
    "",
    "🔒 HUMAN APPROVAL GATES (require Carlos approval via approvals table):",
    "  1. new_company: Creating a new venture (only after Scout research)",
    "  2. growth_strategy: Marketing campaigns or significant spend proposals",
    "  3. spend_approval: Any expense > €20 (ads, tools, services)",
    "  4. kill_company: Shutting down a company",
    "",
    "⚠️  CRITICAL RULE: NEVER flag autonomous services as \"needs manual work\".",
    "    If GSC, GitHub, Vercel, Neon, Stripe, or Resend actions fail, use the",
    "    corresponding API endpoints below to fix them programmatically.",
    "",
    "🔧 AVAILABLE API ENDPOINTS:",
    "",
  ];

  // Group by function
  const groups: Record<string, HiveCapability[]> = {
    "Infrastructure": [],
    "Agent Dispatch": [],
    "Intelligence": [],
    "Health & Metrics": [],
    "Company Management": [],
    "Knowledge": [],
    "Payments & Auth": [],
  };

  for (const cap of HIVE_CAPABILITIES) {
    if (["repair_infra", "provision", "enable_analytics"].includes(cap.id)) {
      groups["Infrastructure"].push(cap);
    } else if (["dispatch_worker", "agent_context", "token_exchange", "list_companies"].includes(cap.id)) {
      groups["Agent Dispatch"].push(cap);
    } else if (["research_type", "visibility_check", "extract_patterns"].includes(cap.id)) {
      groups["Intelligence"].push(cap);
    } else if (["sentinel", "metrics_cron", "agent_performance", "agent_costs"].includes(cap.id)) {
      groups["Health & Metrics"].push(cap);
    } else if (["assess_company", "company_tasks", "update_task", "decide_approval"].includes(cap.id)) {
      groups["Company Management"].push(cap);
    } else if (["write_playbook", "log_action"].includes(cap.id)) {
      groups["Knowledge"].push(cap);
    } else if (["create_stripe_product"].includes(cap.id)) {
      groups["Payments & Auth"].push(cap);
    }
  }

  for (const [group, caps] of Object.entries(groups)) {
    if (caps.length === 0) continue;
    lines.push(`  ${group}:`);
    for (const cap of caps) {
      const params = Object.keys(cap.params);
      const paramStr = params.length > 0 ? ` (${params.join(", ")})` : "";
      lines.push(
        `    - ${cap.method} ${cap.endpoint}: ${cap.description}${paramStr}`
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}
