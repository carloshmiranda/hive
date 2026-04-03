---
name: tool-design
description: This skill should be used when the user wants to design, audit, or improve tools for AI agents — including MCP tools, function calling schemas, tool descriptions, response formats, error messages for agent recovery, or when mentioning tool consolidation, file system agent patterns, tool description engineering, agent-optimized APIs, or reducing tool sprawl.
metadata:
  version: 2.0.0
---

# Tool Design for AI Agents

Tools define what an agent can do. Poorly designed tools cause hallucinations, repeated failures, and wasted tokens. Well-designed tools give agents clear affordances, predictable outputs, and useful error messages that enable recovery without human intervention.

## When to Activate

Activate this skill when:
- Designing new tools or MCP servers for agents
- Auditing existing tools that agents use incorrectly
- Agents are calling the wrong tool, calling tools unnecessarily, or failing to use tools correctly
- Tool responses are filling context with noise
- Error messages from tools aren't helping agents recover

## Core Principle: Consolidation Over Proliferation

The single most impactful tool design decision is the number of tools. More tools = more decision overhead = more mistakes.

**Before adding a new tool, ask:**
1. Can an existing tool cover this with a parameter?
2. Can this be done by combining two existing calls?
3. Does the agent actually need this, or is it a convenience for humans?

**Target:** 5-10 tools per agent context. Beyond 15, agent accuracy degrades measurably.

## Architectural Reduction: The Filesystem Agent Pattern

Instead of N specialized tools (read_json, read_yaml, read_csv, read_log...), use one general tool (read_file) with format auto-detection. The agent learns to use one flexible tool rather than choosing between many specialized ones.

```
BEFORE: 8 tools
- read_json_file
- write_json_file
- read_yaml_file
- write_yaml_file
- list_directory
- search_files
- get_file_metadata
- delete_file

AFTER: 3 tools
- read_file(path, format?: "auto"|"text"|"json"|"yaml")
- write_file(path, content, format?: "auto"|"text"|"json")
- manage_files(operation: "list"|"search"|"delete"|"metadata", ...)
```

This reduces the tool selection problem from 8 choices to 3 while maintaining full capability.

## Tool Description Engineering

The description is the most important part of a tool. It must answer four questions:

**1. What does this tool do?**
One sentence. Active voice. Start with a verb.

**2. When should the agent use it?** (equally important)
Explicit trigger conditions prevent misuse.

**3. What are the critical inputs?**
Parameters that change behavior significantly. Don't describe obvious ones.

**4. What does it return?**
Format, structure, and what to do with the result.

### Good vs. Bad Descriptions

```typescript
// BAD: Vague, no trigger conditions, unclear return
{
  name: "get_data",
  description: "Gets data from the system",
  parameters: { ... }
}

// GOOD: Clear, trigger conditions, return format specified
{
  name: "query_company_metrics",
  description: `Returns time-series metrics for a company.
    Use when you need traffic, conversion, or revenue data for analysis or reporting.
    Do NOT use for agent action history — use get_agent_actions instead.
    Returns: array of { date, metric_name, value } sorted by date descending.
    If no data exists for the requested period, returns empty array (not an error).`,
  parameters: { ... }
}
```

### Negative Descriptions

Explicitly state when NOT to use a tool. This is underused but highly effective.

```
"Use for billing-related customer data. NOT for authentication data — use get_user_session for that."
"Use when you need to READ configuration. For WRITING config, use update_settings."
"Do NOT call this more than once per session — results are cached for 5 minutes."
```

## Response Format Optimization

Tool responses go directly into the agent's context. Optimize them for agent consumption, not human readability.

### Principles

**Return only what the agent needs.** If the agent asks for a company's status, don't return the full company object with 30 fields. Return `{ id, name, status, last_cycle_at }`.

**Use consistent structure.** Every tool should return the same envelope:
```typescript
{
  ok: boolean,
  data?: T,
  error?: string,
  meta?: { count?: number, truncated?: boolean }
}
```

**Signal truncation explicitly.** If you're limiting results, say so:
```json
{ "ok": true, "data": [...20 items...], "meta": { "count": 847, "truncated": true } }
```

**Never return HTML or markdown for programmatic tools.** Return JSON with structured fields. Agents parse JSON; prose in responses becomes noise.

**Omit null fields.** `{ "name": "Hive", "revenue": null, "status": "active" }` should be `{ "name": "Hive", "status": "active" }`. Null fields fill context with nothing useful.

### Response Size Targets

| Tool Category | Max Response Size | Strategy if Exceeded |
|--------------|-------------------|---------------------|
| Lookup / status check | <1KB | Hard limit, paginate |
| List operations | <10KB | Paginate, return IDs + summary |
| Content retrieval | <50KB | Summarize or truncate with `meta.truncated: true` |
| Bulk operations | <100KB | Stream or paginate, never return all at once |

## Error Message Design for Agent Recovery

When a tool fails, the error message determines whether the agent can recover without human help. Most tool errors are useless for agents.

### Useless Error (agent can't recover):
```json
{ "ok": false, "error": "Database error" }
{ "ok": false, "error": "Invalid input" }
{ "ok": false, "error": "Not found" }
```

### Useful Error (agent knows exactly what to do):
```json
{
  "ok": false,
  "error": "Company 'verde-desk' not found. Available companies: senhorio, flolio, ciberpme. Check the slug spelling or use list_companies to get current slugs."
}
```

```json
{
  "ok": false,
  "error": "Cannot create task: company must be in 'active' status. Current status: 'paused'. Use update_company_status to reactivate before creating tasks."
}
```

```json
{
  "ok": false,
  "error": "Rate limit exceeded. Retry after 60 seconds. If this is a bulk operation, use batch_create_tasks instead of calling create_task in a loop."
}
```

### Error Design Rules

1. **Name the specific problem.** "Field 'name' is required" not "Missing required field."
2. **Include the current state.** "Status is 'paused'" not "Invalid status."
3. **Suggest the fix.** "Use X instead" or "Try Y" when there's a clear correct path.
4. **Reference related tools.** When the error suggests a different tool, name it.
5. **Never expose stack traces.** They're noise for agents and security risks.

## MCP Tool Naming Conventions

For MCP servers, use fully-qualified names to prevent collision and ambiguity:

```
Format: ServerName:tool_name
Examples:
  hive:hive_backlog
  hive:hive_companies
  stripe:create_payment_link
  neon:query_database
```

Within a single server, use snake_case and prefix with the server name:
```
hive_backlog       ✓
hive_companies     ✓
getBacklog         ✗  (camelCase)
backlog            ✗  (ambiguous without prefix)
```

Group related operations into one tool with an `operation` parameter rather than N separate tools:
```typescript
// Instead of: hive_backlog_create, hive_backlog_update, hive_backlog_delete
{
  name: "hive_backlog",
  description: "Manage backlog items. Use operation='create' for new items, 'update' for changes, 'list' for querying.",
  parameters: {
    operation: { enum: ["create", "update", "delete", "list", "stats"] },
    ...
  }
}
```

## Using Agents to Optimize Tools

Meta-principle: let agents improve their own tools.

**Pattern:** After 5+ tool calls where an agent makes the same mistake (wrong parameters, wrong tool, repeated retries), feed the pattern to a tool-review agent with the instruction: "Analyze these failed calls and suggest description improvements."

Agents are better than humans at identifying what's confusing in tool descriptions because they experience the confusion directly.

**Feedback loop:**
1. Log tool failures with full context (which tool, what parameters, what error)
2. Weekly review: identify tools with >10% failure rate
3. Run improvement agent on high-failure tools
4. Update descriptions, deploy, measure improvement

## Capability Audit Checklist

Before finalizing any tool set:

- [ ] Every tool has a description that answers all four questions (what/when/inputs/returns)
- [ ] Every tool has at least one "do NOT use when" statement
- [ ] No two tools have overlapping primary use cases
- [ ] Error messages include the current state and suggest a fix
- [ ] Response size is bounded and truncation is signaled
- [ ] Total tools per agent context: ≤15
- [ ] Tools with >3 parameters have documented parameter interactions
- [ ] Destructive operations (delete, overwrite) require explicit confirmation parameter

## Related Skills

multi-agent-patterns, filesystem-context, context-optimization
