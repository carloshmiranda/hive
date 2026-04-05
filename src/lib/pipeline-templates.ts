/**
 * Pipeline template type definitions and seed data.
 *
 * A pipeline template defines an ordered chain of agent stages.
 * Templates are stored in the pipeline_templates table as JSONB and
 * served via GET /api/agents/pipelines. They are data-only in this
 * phase — no dispatch wiring yet.
 */

export interface PipelineStage {
  /** Agent identifier (e.g. "engineer", "ceo", "growth", "qa") */
  agent: string;
  /** Specialist type passed to the agent (e.g. "backend", "content") */
  specialist?: string;
  /** Model to use for this stage */
  model: string;
  /** Dispatch event type (snake_case) */
  event_type: string;
  /** Max minutes before this stage is considered timed out */
  timeout_minutes: number;
  /** Where to route on success — next stage slug or "done" */
  on_success: string;
  /** Where to route on failure — slug, "retry", or "escalate" */
  on_failure: string;
}

export interface PipelineTemplate {
  slug: string;
  name: string;
  description: string;
  stages: PipelineStage[];
}

export const SEED_TEMPLATES: PipelineTemplate[] = [
  {
    slug: "backlog-chain",
    name: "Backlog Chain",
    description:
      "Standard backlog-item delivery pipeline: spec generation → engineering implementation → QA verification.",
    stages: [
      {
        agent: "engineer",
        specialist: "backend",
        model: "claude-sonnet-4-6",
        event_type: "spec_gen",
        timeout_minutes: 30,
        on_success: "engineer",
        on_failure: "escalate",
      },
      {
        agent: "engineer",
        specialist: "backend",
        model: "claude-sonnet-4-6",
        event_type: "feature_request",
        timeout_minutes: 60,
        on_success: "qa",
        on_failure: "retry",
      },
      {
        agent: "qa",
        specialist: "qa",
        model: "claude-haiku-4-5-20251001",
        event_type: "qa_verify",
        timeout_minutes: 20,
        on_success: "done",
        on_failure: "engineer",
      },
    ],
  },
  {
    slug: "company-cycle",
    name: "Company Cycle",
    description:
      "Full company growth cycle: CEO plans → Growth executes → Ops distributes and tracks results.",
    stages: [
      {
        agent: "ceo",
        specialist: "strategy",
        model: "claude-opus-4-6",
        event_type: "cycle_start",
        timeout_minutes: 30,
        on_success: "growth",
        on_failure: "escalate",
      },
      {
        agent: "growth",
        specialist: "content",
        model: "claude-sonnet-4-6",
        event_type: "growth_execute",
        timeout_minutes: 45,
        on_success: "ops",
        on_failure: "retry",
      },
      {
        agent: "ops",
        specialist: "ops",
        model: "claude-haiku-4-5-20251001",
        event_type: "ops_distribute",
        timeout_minutes: 20,
        on_success: "done",
        on_failure: "escalate",
      },
    ],
  },
];
