# Hive — Research & Operations Context

Venture orchestrator operating rules. Load this when planning company strategy, dispatching agents, or reasoning about the business.

---

## Context Protocol

Four tools write to the shared knowledge layer: Claude Chat (brainstorming → update prompts), Claude Code (direct edits + commits), Orchestrator (Step 9 reflection → rewrites BRIEFING.md from Neon data), Carlos (manual edits + dashboard directives). Git repo is the single source of truth. Neon DB holds operational data (playbook, agent_actions, cycles, metrics, **backlog**). Backlog items live exclusively in `hive_backlog` DB table — BACKLOG.md is auto-generated, never edited.

---

## Operating Rules

### 1. Budget-aware parallel execution
Up to 2 companies simultaneously. Sentinel ranks by priority score (tasks, staleness, lifecycle, directives). Health gate blocks when 2+ brain agents running. >70% Claude budget → max 1 dispatch, >90% → escalations only.

### 2. State lives in Neon
Never store state in files. Read/write via Hive API (`/api/*`). Every action, decision, metric → database.

### 3. Four human gates
Require Carlos's approval: **new_company**, **growth_strategy**, **spend_approval** (>€20), **kill_company**. Everything else: execute autonomously.

### 4. Three-attempt escalation
Attempt 1: try. Attempt 2: reflect + different approach. Attempt 3: Auto-Healer. Still failing → escalation approval gate.

### 5. Playbook-first
Before Growth/SEO/marketing: read `playbook` table. After success with measurable outcomes: write new entry.

### 6. Prompt versioning
Agent prompts in `agent_prompts` table. Evolver proposes changes → shadow testing → approval gate.

### 7. Completion status protocol
Every agent action and interactive session task must close with one of four statuses:
- **DONE** — task complete, all criteria verified, no open issues
- **DONE_WITH_CONCERNS** — task complete but [specific concern flagged for follow-up]
- **NEEDS_CONTEXT** — blocked on missing information; state exactly what is needed
- **BLOCKED** — hard blocker prevents progress; escalate or stop

When writing to `agent_actions`, map: DONE → `status=success`, BLOCKED → `status=failure`. For DONE_WITH_CONCERNS and NEEDS_CONTEXT, set `status=success` and include the status string in `output` JSON under `"completion_status"`.

### 8. Subagent context injection
Dispatch payloads must include full task context — not just IDs. When dispatching Engineer, Growth, or Healer:
- Include `title`, `description`, and `acceptance_criteria` from the backlog item
- Include relevant recent context (last CEO score, last error pattern, current metrics)
- Include the playbook entries that apply (by slug)

Agents that receive only an ID must fetch everything themselves, adding latency and DB round-trips. Agents that receive full context can start reasoning immediately.

---

## Validation-Gated Build (ADR-024)

Companies progress through phases based on validation score (0-100) from real metrics, not cycle count. Computed in `src/lib/validation.ts`, injected via `/api/agents/context`. CEO is the only agent with phase logic — it gates what gets planned. See ARCHITECTURE.md for phase details and data collection.

---

## Directives

Carlos sends directives via dashboard command bar or GitHub Issues (`hive-directive` label). CEO sees them as PRIORITY items that override normal planning. Auto-closed after processing.
