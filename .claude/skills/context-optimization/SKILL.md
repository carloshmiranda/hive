---
name: context-optimization
description: This skill should be used when the user wants to reduce token costs, prevent context window overflow, optimize what goes into an agent's context, or improve agent performance by managing context size. Also use when the user mentions context window limits, KV cache, prompt caching, observation masking, context compaction, context partitioning, "agent is forgetting things", "context is too big", "hitting token limits", or "how do I reduce API costs for agents".
metadata:
  version: 2.0.0
---

# Context Optimization for AI Agents

Context size directly determines cost, latency, and quality. Too little context → agent lacks information to act. Too much → attention dilution, higher costs, slower responses, and the lost-in-middle effect where critical information buried in the middle is effectively ignored.

## When to Activate

Activate this skill when:
- Agent context windows are approaching limits
- API costs are higher than expected for agent workflows
- Agents are losing track of earlier instructions or facts
- Building multi-step agent pipelines with accumulating tool output
- Optimizing an existing agent for production cost/performance

## Four Strategies (In Priority Order)

Apply in this order — each has different ROI and implementation cost.

---

### Strategy 1: KV-Cache Optimization (Apply Unconditionally)

**Apply this first, before any other optimization.** It costs nothing and dramatically reduces costs in systems that make repeated calls with similar prompts.

KV-cache (key-value cache) stores the computed attention states for prompt prefixes. If your next API call shares the same prefix as the previous one, the model reuses cached computation instead of recomputing from scratch.

**Cache hit savings:** 90% cost reduction on cached tokens (Anthropic: cache read = 10% of base price).

**How to maximize cache hits:**

1. **Put stable content first.** System prompt, background context, and instructions should come before dynamic content (user message, tool results). Cache invalidates at the first change, so changes must happen at the end.

   ```
   GOOD (cache-friendly):
   [System prompt - stable]
   [Company context - stable]
   [Playbook entries - stable]
   [Current task instructions - stable]
   [Tool results - changes every call]  ← only this invalidates cache
   [User message - changes every call]  ← only this invalidates cache

   BAD (cache-busting):
   [Timestamp at top - changes every call]
   [System prompt]
   [Context]
   ```

2. **Mark long stable sections for explicit caching.** For Anthropic, use `cache_control: {type: "ephemeral"}` on stable blocks. Cache persists for 5 minutes.

3. **Stabilize prompt structure.** Avoid dynamic content (dates, request IDs, current values) in early parts of the prompt. If you must include a timestamp, put it at the very end.

4. **Group related stable content.** If the system prompt + context + playbook = 10K tokens and never changes, those tokens cost 10% per call instead of 100%.

**Target:** 70%+ cache hit rate for production agent workflows. If you're below 40%, reorganize prompt structure.

---

### Strategy 2: Observation Masking (60-80% Token Reduction on Tool Output)

Tool outputs are the primary source of context bloat in agentic systems. A single web search result, database query, or file read can consume thousands of tokens. Agents rarely need the full content — they need key information extracted from it.

**Observation masking:** After a tool call serves its purpose, replace the verbose output with a compact reference in subsequent context.

**Pattern:**

```
BEFORE masking (full tool result stays in context):
Tool: read_file("report.md")
Result: [5,000 tokens of markdown content]

Next tool call includes 5,000 token payload in history...

AFTER masking (summary replaces full output):
Tool: read_file("report.md")
Result: [MASKED: file read, 5,000 tokens. Key findings: revenue grew 23%,
         churn increased to 8%, three feature requests identified.
         Full content available via read_file if needed.]
```

**Implementation approaches:**

1. **Automatic masking after use:** Once the agent has acted on a tool result (made a decision, extracted data), replace the result with a compact summary in the message history before the next turn.

2. **Progressive summarization:** Accumulate a running summary. After N turns, replace detailed history with `[SUMMARY: turns 1-N: agent investigated X, found Y, decided Z]`.

3. **Reference-based masking:** Replace content with a retrievable reference. Agent can re-fetch if needed. Good for documents, reports, code files.

**When to mask:**
- File reads (mask after key info extracted)
- Web search results (mask after decision made)
- Database query results (mask after data processed)
- Previous agent turns (summarize after 5+ turns)

**When NOT to mask:**
- The current tool result (agent still needs it)
- Results the agent may need to re-examine
- Short results (<500 tokens) — overhead not worth it

---

### Strategy 3: Compaction (Trigger at 70% Utilization)

When context has accumulated significant history that's no longer actively needed, compact it into a dense summary.

**Trigger threshold:** 70% of context window utilization. At this point, there's enough history to summarize but still room to work.

**Compaction approaches:**

1. **Hierarchical summarization:**
   ```
   Full history (10K tokens)
   → Structured summary (500 tokens):
     - Decisions made: [list]
     - Facts established: [list]
     - Current state: [description]
     - Remaining tasks: [list]
   ```

2. **Keep-last-N:** Retain the last N turns verbatim (for immediate context continuity) + compact everything before. N = 3-5 is typical.

3. **Semantic compaction:** Extract only information relevant to the current task, discard the rest. Higher quality but requires an LLM call to compress.

**Token reduction target:** 50-70% reduction while preserving task-critical information.

**What to always preserve in compaction:**
- Current task/objective
- Key decisions already made (with rationale)
- Established facts that will be referenced later
- Open questions and blockers
- Next steps

**What to discard:**
- Failed approaches (keep the lesson, not the attempt)
- Intermediate reasoning steps that led to a dead end
- Verbose tool outputs already acted upon
- Repetitive confirmations

---

### Strategy 4: Context Partitioning (Sub-Agents)

When the total information needed exceeds any single context window efficiently, distribute work across multiple agents with isolated contexts.

**Use when:**
- Total task context > 40% of context window (leaves no room for working)
- Different subtasks need fundamentally different information sets
- Parallelization would reduce wall-clock time

**Partitioning strategies:**

1. **Topic partitioning:** Research agent, analysis agent, writing agent each get focused context.

2. **Company/entity partitioning:** In multi-tenant systems, each agent handles one company with only that company's context.

3. **Time-window partitioning:** Agent 1 handles recent events, Agent 2 handles historical analysis, coordinator synthesizes.

**Anti-pattern:** Partitioning without shared state coordination leads to agents making inconsistent decisions. Use filesystem context (see `filesystem-context` skill) or a shared store for cross-agent state.

---

## Performance Targets

| Metric | Target | How to Measure |
|--------|--------|----------------|
| Cache hit rate | ≥70% | Track `cache_read_input_tokens` in API response |
| Context utilization at trigger | ≤70% before compaction | `input_tokens / max_tokens` |
| Token reduction via masking | 60-80% on masked items | Compare before/after token counts |
| Compaction efficiency | 50-70% reduction | Compare pre/post compaction tokens |

## Prioritization Matrix

| Strategy | Effort | ROI | When |
|----------|--------|-----|------|
| KV-cache optimization | Low | Very High | Always, every agent |
| Observation masking | Medium | High | Any agent with tool calls |
| Compaction | Medium | Medium | Long-running agents |
| Context partitioning | High | High | Complex multi-step tasks |

## Hive-Specific Applications

For Hive's agent architecture:

| Agent | Primary Optimization | Reason |
|-------|---------------------|--------|
| CEO | KV-cache (stable system prompt + company context first) | Large, stable context |
| Engineer | Observation masking (code file reads, build output) | Heavy tool output |
| Growth | Compaction (research accumulates over turns) | Multi-turn research |
| Sentinel | KV-cache + Edge Config for dispatch decisions | Frequent, repetitive calls |
| Ops | Masking (log file reads, metric dumps) | Very large tool outputs |

## Common Anti-Patterns

- **Injecting everything "just in case":** Costs tokens, dilutes attention. Only inject what the current task requires.
- **Leaving tool results in context forever:** Implement masking after first use.
- **Dynamic content at prompt start:** Breaks KV-cache, costs 10x more.
- **Waiting until 100% utilization to compact:** Context is already degraded by then. Compact at 70%.
- **Summarizing without structure:** Free-form summaries lose facts. Use structured summaries with explicit fields.
- **Partitioning without coordination:** Isolated agents make contradictory decisions. Use shared state.

## Related Skills

memory-systems, multi-agent-patterns, filesystem-context, tool-design
