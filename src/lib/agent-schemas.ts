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

// Schema registry for easy lookup by agent name
export const AGENT_SCHEMAS = {
  growth: GrowthResponseSchema,
  outreach: OutreachResponseSchema,
  ops: OpsResponseSchema,
  "backlog-planner": BacklogPlannerResponseSchema,
} as const;

// Type helpers for agent responses
export type GrowthResponse = z.infer<typeof GrowthResponseSchema>;
export type OutreachResponse = z.infer<typeof OutreachResponseSchema>;
export type OpsResponse = z.infer<typeof OpsResponseSchema>;
export type BacklogPlannerResponse = z.infer<typeof BacklogPlannerResponseSchema>;

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