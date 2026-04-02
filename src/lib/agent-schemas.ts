import { z } from "zod";

// Zod schemas for structured JSON responses from worker agents
// Used with OpenRouter's response_format for enforced schema compliance

// Growth agent - content plan with title/body/keywords/cta fields
export const GrowthResponseSchema = z.object({
  content_created: z.array(z.object({
    title: z.string().min(1).max(200),
    body: z.string().min(10),
    keywords: z.array(z.string()).max(20),
    cta: z.string().max(100),
    type: z.enum(["blog_post", "landing_page", "seo_page", "email_sequence"]),
    file_path: z.string().optional(),
  })),
  posts_scheduled: z.number().int().min(0),
  seo_improvements: z.array(z.object({
    page: z.string(),
    improvement: z.string(),
    impact: z.enum(["low", "medium", "high"]),
  })).optional(),
  next_actions: z.array(z.string()).max(5),
});

// Outreach agent - prospect list with name/email/company/reason fields
export const OutreachResponseSchema = z.object({
  leads: z.array(z.object({
    name: z.string().min(1).max(100),
    email: z.string().email(),
    company: z.string().min(1).max(200),
    reason: z.string().min(10).max(500),
    priority: z.enum(["high", "medium", "low"]).optional(),
    source: z.string().max(100).optional(),
  })),
  emails_drafted: z.array(z.object({
    to: z.string().email(),
    subject: z.string().min(1).max(200),
    body: z.string().min(10),
    type: z.enum(["cold_outreach", "follow_up", "nurture"]),
    scheduled_for: z.string().optional(), // ISO date string
  })),
  follow_ups_planned: z.number().int().min(0),
  conversion_rate: z.number().min(0).max(1).optional(),
});

// Ops agent - health report with status/issues/recommendations fields
export const OpsResponseSchema = z.object({
  metrics_collected: z.number().int().min(0),
  health_status: z.enum(["ok", "warning", "degraded", "critical"]),
  issues_found: z.array(z.object({
    severity: z.enum(["low", "medium", "high", "critical"]),
    category: z.string().max(50),
    description: z.string().min(10).max(500),
    affected_system: z.string().max(100),
    recommendation: z.string().max(300),
  })),
  needs_engineer: z.boolean(),
  uptime_percentage: z.number().min(0).max(100).optional(),
  performance_score: z.number().min(0).max(100).optional(),
  recommendations: z.array(z.string()).max(10),
});

// Decomposed sub-task - single item from LLM decomposition
export const DecomposedSubTaskSchema = z.object({
  title: z.string().min(1).max(80),
  description: z.string().min(10).max(500),
  acceptance_criteria: z.array(z.string().min(5)).min(1).max(8),
  affected_files: z.array(z.string().min(1)).min(1).max(10),
  complexity: z.enum(["S", "M"]),
  estimated_turns: z.number().int().min(5).max(35),
});

// Wrapper for decomposer array output — generateObject requires object root
export const DecomposedSubTasksSchema = z.object({
  sub_tasks: z.array(DecomposedSubTaskSchema).min(2).max(6),
});

// Backlog planner - task analysis with complexity/turns/spec fields
export const BacklogPlannerResponseSchema = z.object({
  task_analysis: z.object({
    complexity: z.enum(["S", "M", "L"]),
    estimated_turns: z.number().int().min(5).max(50),
    specialist_required: z.enum(["frontend", "backend", "database", "devops", "security"]).optional(),
    dependencies: z.array(z.string()).max(10),
  }),
  spec: z.object({
    acceptance_criteria: z.array(z.string().min(5)).min(1).max(10),
    affected_files: z.array(z.string().min(1)).min(1).max(20),
    approach: z.array(z.string().min(10)).min(1).max(10),
    risks: z.array(z.string()).max(5),
  }),
  decomposition_needed: z.boolean(),
  priority_adjustment: z.enum(["increase", "decrease", "maintain"]).optional(),
  ready_for_dispatch: z.boolean(),
});

// Engineer agent - structured callback with status codes
export const EngineerResponseSchema = z.object({
  status_code: z.enum(["DONE", "DONE_WITH_CONCERNS", "NEEDS_CONTEXT", "BLOCKED"]),
  tasks_completed: z.array(z.object({
    task_id: z.string(),
    task: z.string(),
    commit: z.string().optional(),
    files_changed: z.array(z.string()),
    status: z.enum(["done", "partial", "blocked"]),
    blockers: z.string().optional(),
    acceptance_verification: z.array(z.object({
      criteria: z.string(),
      verified: z.boolean(),
      evidence: z.string().optional(),
    })).optional(),
    scope_compliance: z.object({
      files_allowed_respected: z.boolean(),
      files_forbidden_avoided: z.boolean(),
      forbidden_files_attempted: z.array(z.string()),
    }).optional(),
  })),
  concerns: z.array(z.string()).optional(),
  context_needed: z.string().optional(),
  blocking_issue: z.string().optional(),
  build_status: z.enum(["passed", "failed"]),
  deploy_status: z.enum(["success", "failed", "skipped"]),
  errors: z.array(z.string()),
  notes: z.string().optional(),
});

// CEO cycle review - structured output from CEO brain agent
// The review is nested under ceo_review.review in the API payload
export const CeoReviewSchema = z.object({
  score: z.number().int().min(1).max(10),
  validation_score: z.number().min(0).max(100).optional(),
  validation_phase: z.string().min(1),
  phase_justification: z.string().optional(),
  cycle_goal: z.string().optional(),
  briefing: z.object({
    what_i_did: z.array(z.string()),
    key_findings: z.object({
      product_state: z.string().optional(),
      critical_gap: z.string().optional(),
      opportunity: z.string().optional(),
    }).optional(),
    product_maturity: z.object({
      done: z.array(z.string()).optional(),
      building: z.array(z.string()).optional(),
      planned: z.array(z.string()).optional(),
    }).optional(),
    health: z.object({
      status: z.enum(["healthy", "degraded", "down"]),
      errors_24h: z.number().int().min(0).optional(),
      last_deploy: z.string().optional(),
    }).optional(),
    plan_tomorrow: z.string().optional(),
  }).optional(),
  wins: z.array(z.string()).optional(),
  misses: z.array(z.string()).optional(),
  agent_grades: z.record(z.string(), z.union([
    z.string(),
    z.object({ grade: z.enum(["A", "B", "C", "F"]), note: z.string().optional() }),
  ])),
  design_review: z.object({
    ui_changed: z.boolean(),
    violations: z.array(z.string()).optional(),
    score_deduction: z.number().optional(),
    notes: z.string().optional(),
  }).optional(),
  playbook_entry: z.object({
    domain: z.enum(["growth", "engineering", "ops", "strategy"]),
    insight: z.string().min(5),
    confidence: z.number().min(0).max(1),
  }).optional(),
  kill_flag: z.boolean(),
  kill_reason: z.string().nullable().optional(),
  kill_recommendation: z.boolean().optional(),
  kill_evaluation_response: z.object({
    triggers_present: z.array(z.string()).optional(),
    justification: z.string().optional(),
    resolution_plan: z.string().optional(),
  }).optional(),
  next_cycle_priorities: z.array(z.string()).optional(),
  error_patterns: z.array(z.object({
    error_text: z.string(),
    agent: z.string(),
    fix_summary: z.string(),
  })).optional(),
  engineering_tasks: z.array(z.object({
    id: z.string(),
    task: z.string(),
    files_allowed: z.array(z.string()).optional(),
    files_forbidden: z.array(z.string()).optional(),
    acceptance_criteria: z.array(z.string()).optional(),
    specialist: z.string().optional(),
    complexity: z.enum(["mechanical", "standard", "complex"]).optional(),
  })).optional(),
  growth_tasks: z.array(z.object({
    id: z.string(),
    task: z.string(),
    channel: z.string().optional(),
    hypothesis: z.string().optional(),
    success_metric: z.string().optional(),
  })).optional(),
});

// Scout proposal — written directly to approvals.context by Scout agent
export const ScoutProposalSchema = z.object({
  proposal: z.object({
    name: z.string().min(1).max(100),
    slug: z.string().min(1).max(50),
    market: z.string().min(1),
    problem: z.string().min(10),
    solution: z.string().min(10),
    business_model: z.enum(["saas", "blog", "affiliate", "newsletter", "ecommerce", "other"]).optional(),
    target_audience: z.string().optional(),
    revenue_model: z.string().optional(),
    competition: z.array(z.string()).optional(),
    unique_angle: z.string().optional(),
    expansion_candidate: z.object({
      parent_company: z.string(),
      synergy_score: z.number().min(0).max(1),
      rationale: z.string(),
    }).optional(),
  }),
  research: z.object({
    market_size: z.string().optional(),
    seo_keywords: z.array(z.string()).optional(),
    competitors: z.array(z.object({
      name: z.string(),
      url: z.string().optional(),
      weakness: z.string().optional(),
    })).optional(),
    trend_signal: z.string().optional(),
    sources: z.array(z.string()).optional(),
  }).optional(),
});

// Evolver proposal — written directly to evolver_proposals table by Evolver agent
export const EvolverProposalSchema = z.object({
  gap_type: z.enum(["outcome", "capability", "knowledge", "process"]),
  severity: z.enum(["critical", "high", "medium", "low"]),
  title: z.string().min(5).max(200),
  diagnosis: z.string().min(20),
  signal_source: z.string().min(1),
  signal_data: z.record(z.string(), z.unknown()).optional(),
  proposed_fix: z.object({
    type: z.enum(["prompt_update", "setup_action", "config_change", "process_change"]),
    target: z.string().optional(),
    change: z.string().min(10),
    affected_files: z.array(z.string()).optional(),
    acceptance_criteria: z.array(z.string()).optional(),
  }),
  affected_companies: z.array(z.string()).optional(),
  cross_company: z.boolean().optional(),
});

// Schema registry for easy lookup by agent name
export const AGENT_SCHEMAS = {
  growth: GrowthResponseSchema,
  outreach: OutreachResponseSchema,
  ops: OpsResponseSchema,
  "backlog-planner": BacklogPlannerResponseSchema,
  engineer: EngineerResponseSchema,
} as const;

// Type helpers for agent responses
export type GrowthResponse = z.infer<typeof GrowthResponseSchema>;
export type OutreachResponse = z.infer<typeof OutreachResponseSchema>;
export type OpsResponse = z.infer<typeof OpsResponseSchema>;
export type BacklogPlannerResponse = z.infer<typeof BacklogPlannerResponseSchema>;
export type EngineerResponse = z.infer<typeof EngineerResponseSchema>;
export type DecomposedSubTask = z.infer<typeof DecomposedSubTaskSchema>;
export type DecomposedSubTasksResponse = z.infer<typeof DecomposedSubTasksSchema>;
export type CeoReview = z.infer<typeof CeoReviewSchema>;
export type ScoutProposal = z.infer<typeof ScoutProposalSchema>;
export type EvolverProposal = z.infer<typeof EvolverProposalSchema>;

// Simplified JSON schema definitions for our agent responses
// Using manual definitions since zod-to-json-schema conversion is complex
const AGENT_JSON_SCHEMAS = {
  growth: {
    type: "object",
    properties: {
      content_created: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string", minLength: 1, maxLength: 200 },
            body: { type: "string", minLength: 10 },
            keywords: { type: "array", items: { type: "string" }, maxItems: 20 },
            cta: { type: "string", maxLength: 100 },
            type: { type: "string", enum: ["blog_post", "landing_page", "seo_page", "email_sequence"] },
            file_path: { type: "string" },
          },
          required: ["title", "body", "keywords", "cta", "type"],
          additionalProperties: false,
        },
      },
      posts_scheduled: { type: "integer", minimum: 0 },
      seo_improvements: {
        type: "array",
        items: {
          type: "object",
          properties: {
            page: { type: "string" },
            improvement: { type: "string" },
            impact: { type: "string", enum: ["low", "medium", "high"] },
          },
          required: ["page", "improvement", "impact"],
          additionalProperties: false,
        },
      },
      next_actions: { type: "array", items: { type: "string" }, maxItems: 5 },
    },
    required: ["content_created", "posts_scheduled", "next_actions"],
    additionalProperties: false,
  },
  outreach: {
    type: "object",
    properties: {
      leads: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1, maxLength: 100 },
            email: { type: "string", format: "email" },
            company: { type: "string", minLength: 1, maxLength: 200 },
            reason: { type: "string", minLength: 10, maxLength: 500 },
            priority: { type: "string", enum: ["high", "medium", "low"] },
            source: { type: "string", maxLength: 100 },
          },
          required: ["name", "email", "company", "reason"],
          additionalProperties: false,
        },
      },
      emails_drafted: {
        type: "array",
        items: {
          type: "object",
          properties: {
            to: { type: "string", format: "email" },
            subject: { type: "string", minLength: 1, maxLength: 200 },
            body: { type: "string", minLength: 10 },
            type: { type: "string", enum: ["cold_outreach", "follow_up", "nurture"] },
            scheduled_for: { type: "string" },
          },
          required: ["to", "subject", "body", "type"],
          additionalProperties: false,
        },
      },
      follow_ups_planned: { type: "integer", minimum: 0 },
      conversion_rate: { type: "number", minimum: 0, maximum: 1 },
    },
    required: ["leads", "emails_drafted", "follow_ups_planned"],
    additionalProperties: false,
  },
  ops: {
    type: "object",
    properties: {
      metrics_collected: { type: "integer", minimum: 0 },
      health_status: { type: "string", enum: ["ok", "warning", "degraded", "critical"] },
      issues_found: {
        type: "array",
        items: {
          type: "object",
          properties: {
            severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
            category: { type: "string", maxLength: 50 },
            description: { type: "string", minLength: 10, maxLength: 500 },
            affected_system: { type: "string", maxLength: 100 },
            recommendation: { type: "string", maxLength: 300 },
          },
          required: ["severity", "category", "description", "affected_system", "recommendation"],
          additionalProperties: false,
        },
      },
      needs_engineer: { type: "boolean" },
      uptime_percentage: { type: "number", minimum: 0, maximum: 100 },
      performance_score: { type: "number", minimum: 0, maximum: 100 },
      recommendations: { type: "array", items: { type: "string" }, maxItems: 10 },
    },
    required: ["metrics_collected", "health_status", "issues_found", "needs_engineer", "recommendations"],
    additionalProperties: false,
  },
  "backlog-planner": {
    type: "object",
    properties: {
      task_analysis: {
        type: "object",
        properties: {
          complexity: { type: "string", enum: ["S", "M", "L"] },
          estimated_turns: { type: "integer", minimum: 5, maximum: 50 },
          specialist_required: { type: "string", enum: ["frontend", "backend", "database", "devops", "security"] },
          dependencies: { type: "array", items: { type: "string" }, maxItems: 10 },
        },
        required: ["complexity", "estimated_turns", "dependencies"],
        additionalProperties: false,
      },
      spec: {
        type: "object",
        properties: {
          acceptance_criteria: { type: "array", items: { type: "string", minLength: 5 }, minItems: 1, maxItems: 10 },
          affected_files: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 20 },
          approach: { type: "array", items: { type: "string", minLength: 10 }, minItems: 1, maxItems: 10 },
          risks: { type: "array", items: { type: "string" }, maxItems: 5 },
        },
        required: ["acceptance_criteria", "affected_files", "approach", "risks"],
        additionalProperties: false,
      },
      decomposition_needed: { type: "boolean" },
      priority_adjustment: { type: "string", enum: ["increase", "decrease", "maintain"] },
      ready_for_dispatch: { type: "boolean" },
    },
    required: ["task_analysis", "spec", "decomposition_needed", "ready_for_dispatch"],
    additionalProperties: false,
  },
  engineer: {
    type: "object",
    properties: {
      status_code: { type: "string", enum: ["DONE", "DONE_WITH_CONCERNS", "NEEDS_CONTEXT", "BLOCKED"] },
      tasks_completed: {
        type: "array",
        items: {
          type: "object",
          properties: {
            task_id: { type: "string" },
            task: { type: "string" },
            commit: { type: "string" },
            files_changed: { type: "array", items: { type: "string" } },
            status: { type: "string", enum: ["done", "partial", "blocked"] },
            blockers: { type: "string" },
            acceptance_verification: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  criteria: { type: "string" },
                  verified: { type: "boolean" },
                  evidence: { type: "string" },
                },
                required: ["criteria", "verified"],
                additionalProperties: false,
              },
            },
            scope_compliance: {
              type: "object",
              properties: {
                files_allowed_respected: { type: "boolean" },
                files_forbidden_avoided: { type: "boolean" },
                forbidden_files_attempted: { type: "array", items: { type: "string" } },
              },
              required: ["files_allowed_respected", "files_forbidden_avoided", "forbidden_files_attempted"],
              additionalProperties: false,
            },
          },
          required: ["task_id", "task", "files_changed", "status"],
          additionalProperties: false,
        },
      },
      concerns: { type: "array", items: { type: "string" } },
      context_needed: { type: "string" },
      blocking_issue: { type: "string" },
      build_status: { type: "string", enum: ["passed", "failed"] },
      deploy_status: { type: "string", enum: ["success", "failed", "skipped"] },
      errors: { type: "array", items: { type: "string" } },
      notes: { type: "string" },
    },
    required: ["status_code", "tasks_completed", "build_status", "deploy_status", "errors"],
    additionalProperties: false,
  },
} as const;

// Helper function to get response format config for OpenRouter
export function getResponseFormat(agentName: keyof typeof AGENT_SCHEMAS) {
  const jsonSchema = AGENT_JSON_SCHEMAS[agentName];
  if (!jsonSchema) {
    throw new Error(`No JSON schema defined for agent: ${agentName}`);
  }

  return {
    type: "json_schema" as const,
    json_schema: {
      name: `${agentName}_response`,
      strict: true as const,
      schema: jsonSchema,
    },
  };
}