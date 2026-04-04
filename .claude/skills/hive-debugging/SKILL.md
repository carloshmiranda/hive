---
name: hive-debugging
description: Debugging reference for Hive's autonomous orchestrator. Use when diagnosing agent failures, inspecting circuit breaker states, querying agent_actions, checking QStash DLQ, or tracing why a company stopped receiving cycles. Covers all MCP debug tools, SQL query patterns, and common failure modes by agent type.
metadata:
  version: 1.0.0
---

# Hive Debugging

Use this skill when: an agent isn't running, a company hasn't received cycles, a dispatch chain broke, a circuit breaker tripped, or you need to trace why a specific action failed.

---

## MCP Debug Tools

These tools are available via the `hive` MCP server (configured in `.mcp.json`). Always start here before writing custom SQL.

### `hive_failure_summary`

Returns a prioritized list of recent failures across all companies and agents.

```
mcp__hive__hive_failure_summary
  since: "24h" | "48h" | "7d"   (default: "48h")
```

Output includes: company slug, agent, failure count, last error message, pattern classification.

**Use when:** Starting a debugging session without knowing where to look.

### `hive_error_patterns`

Returns normalized error patterns extracted by CEO from `agent_actions`. Groups similar errors across companies.

```
mcp__hive__hive_error_patterns
  company_id?: string    (omit for cross-company view)
  agent?: string         (omit for all agents)
  limit?: number         (default: 20)
```

**Use when:** A specific error has happened multiple times across companies and you want to understand the pattern before fixing.

### `hive_dispatch_status`

Returns the current dispatch queue state: which companies are dispatching, pending QStash messages, circuit breaker states.

```
mcp__hive__hive_dispatch_status
```

Output:
```json
{
  "active_dispatches": [{ "company_id", "agent", "started_at", "event_type" }],
  "circuit_breakers": [{ "company_id", "failures_48h", "is_tripped" }],
  "qstash_pending": number,
  "dispatch_paused": boolean
}
```

**Use when:** A company seems stuck — not receiving new cycles or dispatch.

### `hive_circuit_reset`

Resets the circuit breaker for a specific company, allowing dispatch to resume.

```
mcp__hive__hive_circuit_reset
  company_id: string
```

**Use when:** `hive_dispatch_status` shows a company circuit breaker is tripped and you've confirmed the underlying error is resolved.

**Circuit breaker logic:** 3 failures within 48h → tripped → company skipped by Sentinel. Resets automatically after 48h with no new failures, or manually via this tool.

### `hive_loop_kick`

Manually triggers the Sentinel dispatch loop to re-evaluate all companies and dispatch agents where conditions are met.

```
mcp__hive__hive_loop_kick
  tier: "urgent" | "dispatch" | "janitor"   (default: "dispatch")
```

**Use when:** Sentinel ran but didn't dispatch (conditions not met at that moment), or after resolving a blocker and wanting immediate re-evaluation.

**⚠️ Check `dispatch_paused` first.** If `dispatch_paused=true`, the loop will not dispatch. Check `project_dispatch_halt.md` in memory — Carlos may have issued a halt order.

---

## `agent_actions` Query Patterns

Table schema:
```sql
agent_actions (
  id, company_id, agent, cycle_id,
  action_type, input, output,
  status,         -- 'success' | 'failure' | 'running'
  started_at, completed_at,
  error_message,
  attempt_number
)
```

### Find all recent failures for a company

```sql
SELECT agent, action_type, error_message, started_at, attempt_number
FROM agent_actions
WHERE company_id = '<id>'
  AND status = 'failure'
  AND started_at > now() - interval '48 hours'
ORDER BY started_at DESC;
```

### Find stuck "running" actions (zombie detection)

```sql
SELECT id, company_id, agent, started_at,
       extract(epoch from (now() - started_at))/60 AS minutes_running
FROM agent_actions
WHERE status = 'running'
  AND started_at < now() - interval '30 minutes'
ORDER BY started_at;
```

Zombies occur when a GitHub Actions workflow crashes without writing a final status. Fix: update to `failure` manually and reset circuit breaker if needed.

```sql
UPDATE agent_actions
SET status = 'failure',
    error_message = 'Workflow crashed — manually resolved',
    completed_at = now()
WHERE id = '<action_id>';
```

### Trace a full cycle

```sql
SELECT agent, action_type, status, attempt_number,
       started_at, completed_at,
       round(extract(epoch from (completed_at - started_at))) AS duration_s
FROM agent_actions
WHERE cycle_id = '<cycle_id>'
ORDER BY started_at;
```

### Check retry history for a specific task

```sql
SELECT attempt_number, status, error_message, started_at
FROM agent_actions
WHERE company_id = '<id>'
  AND action_type = 'feature_implementation'
ORDER BY attempt_number;
```

Attempt 1 fail + attempt 2 fail + attempt 3 fail → Healer should have been triggered. If Healer was never triggered, check `healer_trigger` dispatch.

---

## Common Failure Modes by Agent

### CEO

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| `status=failure`, no `error_message` | Prompt too long → GitHub Actions DOA (Dead On Arrival) | Check prompt size in `agent_prompts`; CEO prompt must stay under ~4K tokens |
| CEO scores every company 3/10 | Context API returning stale/empty metrics | Check `/api/agents/context` response; verify metrics pipeline isn't writing zeros |
| Kill flags appearing unexpectedly | CEO reading old error patterns as current | Use `hive_error_patterns` to inspect what CEO saw; check `content_language` filter isn't bleeding cross-company |
| CEO plan has no engineering tasks | Validation score too low for current phase | Check `companies.validation_score`; CEO gates task types by phase |

### Engineer

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Build fails on deploy | Edge runtime import violation (`fs`, `crypto`, `node:*`) | Check what was imported; server-only packages can't go in middleware or edge routes |
| TypeScript errors not caught in PR | `npm run build` not run before commit | Check CI; add build step to pre-commit |
| Task marked DONE but feature broken | Acceptance criteria verified against happy path only | Review the criteria; add error-path criteria |
| Max turns hit on attempt 1 | Task too large (L-complexity) | Should have gone through Decomposer first; check decomposition gate |

### Scout

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Proposals all same market | Web search tool not returning results | Check OpenRouter model availability; Scout uses `:online` suffix |
| Proposals expire without review | Auto-expiry disabled — 33+ accumulating | Manual review only; check dashboard Inbox |
| Pipeline not refilling | `pipeline_low` event not firing | Check Sentinel conditions; pipeline < 3 should trigger Scout |

### Healer

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Healer dispatched repeatedly for same error | Error is a config issue (Neon API key, missing env var) — not fixable by code changes | Classify as `config_issue` in `error_patterns`; Healer should skip these |
| Sentinel re-dispatching Healer for same company | Sentinel-level dedup missing (known backlog item #257-#261) | Manually reset circuit breaker after fixing; monitor |
| Healer fix lands but error recurs | Root cause in external service, not code | Add `unfixable: true` flag to error pattern |

### Growth

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| No content produced | OpenRouter free tier rate limit hit | Check OpenRouter dashboard; 1,000 req/day limit. Buy credits if needed. |
| Content in wrong language | Cross-company playbook bleed | Check `content_language` column on playbook entries; Growth must filter by `company.content_language` |
| Stale content trigger firing repeatedly | Sentinel not seeing new content as "fresh" | Check `last_content_at` in companies table; Growth must update it on success |

### Ops

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Health checks all passing but site broken | Health check only tests `/api/health` — not business logic | Add more health check endpoints; check Sentry for client errors |
| Deploy detection missing | Vercel webhook not firing | Check `VERCEL_WEBHOOK_SECRET` env var; check webhook in Vercel dashboard |

---

## Circuit Breaker Reference

Circuit breaker state lives in `companies` table:

```sql
-- Check circuit breaker state
SELECT slug, circuit_breaker_failures, circuit_breaker_tripped_at
FROM companies
WHERE circuit_breaker_failures > 0;

-- Manual reset (or use hive_circuit_reset MCP tool)
UPDATE companies
SET circuit_breaker_failures = 0,
    circuit_breaker_tripped_at = NULL
WHERE id = '<company_id>';
```

**Threshold:** 3 failures within 48 hours → company skipped by Sentinel.
**Auto-reset:** 48 hours after last failure, counter resets automatically (Sentinel janitor tier).
**Manual reset:** Use `hive_circuit_reset` MCP tool after confirming root cause is fixed.

---

## QStash Debugging

QStash handles Sentinel-to-worker dispatch and chain continuations. To inspect:

1. **Check Upstash dashboard** → QStash → DLQ (Dead Letter Queue)
   - DLQ retention: 3 days on free tier
   - Failed messages appear here with full request/response

2. **Common QStash failure causes:**
   - `401` response from endpoint → `CRON_SECRET` or `QSTASH_TOKEN` mismatch
   - `504` timeout → worker function exceeded 120s; needs chunking
   - `404` → route doesn't exist or was renamed in deploy

3. **Re-drive a failed message:**
   - From Upstash dashboard → DLQ → select message → Re-drive
   - Or use QStash REST API: `POST /v2/dlq/{messageId}/redeliver`

4. **Check message delivery for a specific company:**
   - QStash schedules are identified by URL path (`/api/agents/dispatch?company=verdedesk`)
   - Filter logs by path to see delivery history

---

## Dispatch Paused Check

Before debugging why nothing is dispatching, always check:

```
mcp__hive__hive_dispatch_status
```

If `dispatch_paused: true` → Carlos has issued a halt order. Check `project_dispatch_halt.md` in memory. Do not kick the loop or reset circuit breakers until the halt is lifted.

To lift the halt (only on Carlos's instruction):

```sql
UPDATE settings SET value = 'false'
WHERE key = 'dispatch_paused';
```

---

## Debugging Checklist

When "nothing is happening" for a company:

1. `hive_dispatch_status` — is dispatch paused? is circuit breaker tripped?
2. `hive_failure_summary since="48h"` — what failed recently?
3. Check zombie actions (running > 30 min) via SQL above
4. Check Sentinel tier last run — did it evaluate this company?
5. Check company priority score — was it outranked by others?
6. Check `companies.validation_score` — is it below the phase gate threshold?
7. Check `agent_actions` for `attempt_number > 1` — three-attempt escalation progress
8. Check QStash DLQ for failed messages to this company's endpoints
