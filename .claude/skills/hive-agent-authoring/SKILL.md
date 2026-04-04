---
name: hive-agent-authoring
description: Reference for writing and modifying Hive agent prompts, dispatch payloads, context API shapes, and the Evolver review process. Use when authoring or editing any brain/worker agent prompt, wiring a new dispatch event, checking per-agent turn budgets and models, or understanding how the Evolver approves prompt changes.
metadata:
  version: 1.0.0
---

# Hive Agent Authoring

Use this skill when: writing a new agent prompt, editing an existing one, wiring up a new `repository_dispatch` event, or understanding how prompt changes move through Evolver review.

---

## Agent Reference Table

### Brain Agents (GitHub Actions + Claude Max)

| Agent | Model (default→escalation) | Max Turns | Trigger Event | Key Responsibility |
|-------|---------------------------|-----------|---------------|-------------------|
| CEO | claude-opus-4-6 → same | 40 | `cycle_start` | Planning, scoring (1-10), kill/pivot decisions, phase gating |
| Scout | claude-opus-4-6 → same | 35 | `pipeline_low`, `company_killed` | 3 proposals per run (1 PT, 1 global, 1 best-pick) |
| Engineer | claude-sonnet-4-6 → claude-opus-4-6 | 35 → 50 | `feature_request` | Code, deploy, scaffold; escalates to Opus on attempt 3+ |
| Evolver | claude-opus-4-6 → same | 20 | `evolve_trigger` (weekly) | Prompt gap analysis, max 5 proposals/run |
| Healer | claude-sonnet-4-6 → same | 20 | `healer_trigger` | Systemic + company-specific error fixing |
| Decomposer | Claude Max (direct) | 8 | L-complexity tasks | Breaks large tasks into specced subtasks |

**Model escalation rule:** Attempts 1–2 use Sonnet; attempt 3+ automatically switches to Opus with 50 max_turns. This is wired in the GitHub Actions workflow, not in the prompt.

### Worker Agents (Vercel Serverless + OpenRouter)

| Agent | Endpoint | Primary Model | Fallback Chain | Trigger |
|-------|----------|---------------|----------------|---------|
| Growth | `/api/agents/dispatch` | Gemini Flash (free) | Groq → Claude | Scout research delivered, stale content |
| Outreach | `/api/agents/dispatch` | Gemini Flash (free) | Groq → Claude | Leads found, stale leads |
| Ops | `/api/agents/dispatch` | Groq (free) | Claude | Deploys, health checks, sentinel escalations |
| Planner | `/api/agents/dispatch` | Claude Sonnet | — | Pre-decompose task planning |

Worker agents have a **120s max duration** (Vercel serverless limit). Long-running steps must use QStash chaining.

---

## `agent_prompts` Table

```sql
CREATE TABLE agent_prompts (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  agent             TEXT NOT NULL,           -- 'ceo', 'scout', 'engineer', etc.
  version           INTEGER NOT NULL,
  prompt_text       TEXT NOT NULL,
  is_active         BOOLEAN DEFAULT false,
  performance_score NUMERIC(5,4),            -- 0.0000–1.0000
  sample_size       INTEGER DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  promoted_at       TIMESTAMPTZ,
  UNIQUE(agent, version)
);
```

### Useful queries

```sql
-- Get active prompt for an agent
SELECT prompt_text FROM agent_prompts
WHERE agent = 'engineer' AND is_active = true
ORDER BY version DESC LIMIT 1;

-- List all versions for an agent
SELECT version, is_active, performance_score, sample_size, created_at
FROM agent_prompts WHERE agent = 'ceo' ORDER BY version DESC;

-- Insert a new prompt version (inactive until Evolver promotes it)
INSERT INTO agent_prompts (agent, version, prompt_text, is_active)
VALUES ('engineer', 4, '...', false);

-- Promote a version (deactivate others first)
UPDATE agent_prompts SET is_active = false WHERE agent = 'engineer';
UPDATE agent_prompts SET is_active = true, promoted_at = now()
WHERE agent = 'engineer' AND version = 4;
```

---

## Dispatch Payloads

All brain-agent dispatches go through `src/lib/dispatch.ts`:

```typescript
import { dispatchEvent } from '@/lib/dispatch';

await dispatchEvent('cycle_start', {
  company_id: 'abc123',
  company_slug: 'verdedesk',
  trigger: 'sentinel_dispatch',
});
```

### Standard payload fields by event type

| Event Type | Required Fields | Optional Fields |
|------------|-----------------|-----------------|
| `cycle_start` | `company_id`, `company_slug` | `trigger`, `priority_score` |
| `feature_request` | `company_id`, `backlog_item_id`, `title`, `description`, `acceptance_criteria` | `playbook_slugs[]`, `last_ceo_score`, `current_metrics` |
| `healer_trigger` | `company_id`, `error_pattern_id` | `affected_files[]`, `suggested_fix` |
| `evolve_trigger` | `agent`, `reason` | `sample_actions[]`, `gap_type` |
| `pipeline_low` | — | `current_count`, `target_count` |
| `company_killed` | `company_id`, `company_slug` | `kill_reason` |
| `research_request` | `company_id`, `topic` | `competitive_focus` |

### Rule 8 — full context in dispatch payloads

Never dispatch with only an ID. Include full task context so the agent can start reasoning immediately:

```typescript
// ✅ Correct — Engineer can start immediately
await dispatchEvent('feature_request', {
  company_id: company.id,
  company_slug: company.slug,
  backlog_item_id: item.id,
  title: item.title,
  description: item.description,
  acceptance_criteria: item.acceptance_criteria,
  playbook_slugs: ['seo-basics', 'next-performance'],
  last_ceo_score: 4,
  current_metrics: { page_views: 120, signups: 3 },
});

// ❌ Wrong — Engineer must make extra DB round-trips
await dispatchEvent('feature_request', { backlog_item_id: item.id });
```

---

## Context API

Every brain agent fetches enriched context at dispatch time via:

```
GET /api/agents/context?agent=<name>&company_id=<id>
```

Response shape:

```typescript
{
  company: {
    id, slug, name, status, lifecycle, validation_score,
    last_ceo_score, current_cycle_id
  },
  portfolio: {
    total_companies: number,
    active_dispatches: number,
    claude_budget_pct: number        // >70% throttles, >90% escalations only
  },
  playbook: PlaybookEntry[],         // filtered by company content_language
  active_error_patterns: ErrorPattern[],
  recent_actions: AgentAction[],     // last 10 for this company
  directives: Directive[],           // PRIORITY items override normal planning
}
```

Agents must call this endpoint at the start of every run to get fresh state — never rely on payload data alone for metrics.

---

## Structured Handoff Formats

When CEO hands off to Engineer:

```json
{
  "engineering_tasks": [
    {
      "id": "uuid",
      "task": "Add /calculadora to Senhorio with mortgage calculator",
      "acceptance": [
        "Route /calculadora renders a functional mortgage calculator",
        "No TypeScript errors in production build",
        "WCAG AA compliant (keyboard navigable, aria-labels on inputs)"
      ],
      "priority": "P1",
      "estimated_complexity": "M"
    }
  ]
}
```

When CEO hands off to Growth:

```json
{
  "growth_tasks": [
    {
      "id": "uuid",
      "task": "Write SEO guide: 'IRS 2025 Portugal prazo de entrega'",
      "rationale": "Target keyword has 2,400 monthly searches, low competition",
      "target_keyword": "IRS 2025 Portugal prazo de entrega",
      "content_language": "pt"
    }
  ]
}
```

---

## Evolver Review Process

The Evolver runs weekly (`evolve_trigger`) and uses 3-layer gap detection:

1. **Outcome gaps** — agent actions with `status=failure` in the last 7 days
2. **Capability gaps** — tasks the agent consistently can't complete (retries, escalations)
3. **Knowledge gaps** — missing playbook entries the agent references but can't find

For each gap found, Evolver:
1. Writes a new `agent_prompts` row with `is_active=false`
2. Creates a backlog item in the `hive_backlog` DB table with `category=quality`
3. Sends a notification to the dashboard Inbox

**Shadow testing flow:**
- New prompt version runs in parallel for 10 cycles minimum
- `performance_score` is updated after each cycle (based on CEO review score, failure rate)
- If `performance_score >= 0.75` AND `sample_size >= 10` → eligible for promotion
- Promotion requires Carlos's approval gate (`gate_type=prompt_promotion`)
- Post-approval: `is_active=true`, old version `is_active=false`

**Max proposals per run:** 5. If more gaps exist, Evolver prioritizes by: failure rate > frequency > impact.

---

## Writing Effective Agent Prompts

### Structure for brain agent prompts

```
ROLE: You are the [Agent Name] for Hive...

CONTEXT:
You will receive: [list what the context API provides]

YOUR JOB THIS RUN:
[Primary task, numbered steps]

CONSTRAINTS:
- [Hard limits]
- [Budget/turn limits]
- [What NOT to do]

OUTPUT FORMAT:
[Exact JSON structure expected]

COMPLETION PROTOCOL:
End every run with one of:
- DONE — task complete, all criteria verified
- DONE_WITH_CONCERNS — complete but [specific concern]
- NEEDS_CONTEXT — blocked on [exactly what is missing]
- BLOCKED — [hard blocker, escalate]
```

### Rules for prompt content

- Never reference other agent prompts by name in prompts (circular dependency risk)
- Always include the completion status protocol (DONE/DONE_WITH_CONCERNS/NEEDS_CONTEXT/BLOCKED)
- CEO prompt must include phase-gating logic (validation score thresholds)
- Engineer prompt must include the build verification step (`npm run build` + TypeScript check)
- Never put literal `${{ }}` in prompt text — GitHub Actions evaluates all expressions in multi-line strings

---

## Completion Status Mapping

| Agent Status String | `agent_actions.status` DB value |
|--------------------|---------------------------------|
| DONE | `success` |
| DONE_WITH_CONCERNS | `success` (include string in `output.completion_status`) |
| NEEDS_CONTEXT | `success` (include string in `output.completion_status`) |
| BLOCKED | `failure` |
