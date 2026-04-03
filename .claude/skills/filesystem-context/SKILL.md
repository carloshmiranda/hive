---
name: filesystem-context
description: This skill should be used when the user wants to manage context across agent sessions, persist state between tool calls, coordinate sub-agents via shared files, implement scratch pads or working memory for agents, troubleshoot missing or over-retrieved context, or mentions filesystem memory, context persistence, dynamic skill loading, agent communication files, or terminal state preservation.
metadata:
  version: 2.0.0
---

# Filesystem Context Management

The filesystem is the most reliable shared memory available to agents. Unlike in-context state that disappears at session end, filesystem context persists, can be read by sub-agents, and survives compaction. Use it deliberately.

## When to Activate

Activate this skill when:
- Agent sessions need to persist state across runs
- Sub-agents need to share context without passing it through a supervisor
- Tool outputs are too verbose to keep in context
- Long-running tasks need checkpointing
- Dynamic behavior needs to change based on accumulated state

## Diagnostic Modes

Before implementing, identify which context problem you're solving:

### Mode 1: Missing Context
The agent doesn't have information it needs to proceed correctly. Symptoms: hallucinated file paths, wrong assumptions about codebase state, repeated questions about things already established.

**Fix:** Write a context seed file at the start of a session. Include: project structure summary, key decisions already made, current task scope, known constraints.

### Mode 2: Under-Retrieved Context
Context exists in the filesystem but the agent isn't reading it. Symptoms: agent ignores existing files, doesn't check for prior work before starting.

**Fix:** Add explicit read instructions to the system prompt or task description. Use glob patterns that actually match your file layout. Name files predictably.

### Mode 3: Over-Retrieved Context
Agent is reading too much, filling context with irrelevant content. Symptoms: slow responses, context window warnings, irrelevant content in outputs.

**Fix:** Use more specific glob patterns. Implement a manifest file that indexes available context so agents read the index first, then fetch only what's needed.

### Mode 4: Buried Context
Critical information is present but buried in a large file. Symptoms: agent misses key constraints, acts on stale information.

**Fix:** Structure context files with the most important information first. Use clear section headers. Keep files under 200 lines. Split large context into topic files.

## Implementation Patterns

### Pattern 1: Scratch Pad
A working memory file the agent reads and updates during a task.

```
.agent-scratch/
  current-task.md      # What we're doing right now
  decisions.md         # Choices made this session
  blockers.md          # What's preventing progress
  completed.md         # What's been done (brief log)
```

**Rules:**
- Agent reads scratch pad at the start of every tool call sequence
- Agent writes updates before finishing any significant step
- Scratch pad is session-scoped — clear between unrelated tasks
- Keep entries brief: one line per decision/blocker/completion

### Pattern 2: Plan Persistence
For multi-step tasks, write the plan to a file and update it as steps complete.

```markdown
# Task Plan — [task name]
Status: IN PROGRESS
Started: [timestamp]

## Steps
- [x] Step 1: Analyze existing code
- [x] Step 2: Design approach
- [ ] Step 3: Implement changes  ← CURRENT
- [ ] Step 4: Write tests
- [ ] Step 5: Update documentation

## Decisions
- Used approach X because Y
- Skipped Z because it's already done

## Blockers
- None currently
```

**Benefits:** Agent can resume after interruption. Human can see progress. Sub-agents know what's been done.

### Pattern 3: Sub-Agent Communication
When a supervisor dispatches sub-agents, use files instead of message-passing to share state.

```
.agent-comms/
  task-{id}/
    spec.md            # What the sub-agent should do
    context.md         # Relevant context extracted from parent
    result.md          # Written by sub-agent when done
    status.json        # { "state": "running|done|failed", "progress": 0.6 }
```

**Protocol:**
1. Supervisor writes `spec.md` and `context.md`
2. Sub-agent reads both, does work, writes `result.md`, updates `status.json`
3. Supervisor reads `result.md` — never re-summarizes, uses directly
4. No telephone game: sub-agent response goes directly to output

### Pattern 4: Dynamic Skill Loading
Instead of hardcoding behavior, store agent capabilities as files that get loaded based on task type.

```
.agents/
  skills/
    seo-audit.md
    copywriting.md
    product-marketing-context.md
  context/
    company-{slug}.md    # Per-company context
    playbook.md          # Accumulated learnings
```

**How to use:** At task start, read the relevant skill file(s) based on task type. This allows skill updates without changing the agent's system prompt.

### Pattern 5: Terminal Persistence
For long CLI sessions, persist context so it survives terminal closes.

```
.session/
  last-run.json         # { "task": "...", "step": 3, "context": {...} }
  checkpoint-{N}.md     # Periodic state snapshots
```

Agent reads `last-run.json` at startup to resume. Writes checkpoint after each major step.

### Pattern 6: Self-Modification Context
Agent writes to files that change its own future behavior.

```
.agent-config/
  learned-patterns.md   # What worked / didn't work
  avoid.md              # Approaches to skip
  preferences.md        # Discovered preferences for this project
```

Agent reads these before starting tasks, incorporates the learnings. This is the basis of project-specific adaptation.

## File Naming Conventions

- Use kebab-case for all agent context files
- Prefix with `.` (dotfiles) to keep them out of main project view
- Group by scope: `.agent-scratch/` (session), `.agents/` (project), `.session/` (terminal)
- Use `.md` for human-readable context, `.json` for machine-readable state
- Never use timestamps in filenames — use content-based names instead

## Gotchas

1. **Unbounded scratch growth** — Scratch pads accumulate indefinitely. Add a line count check before writing. If >500 lines, archive old content to `scratch-archive/` and start fresh.

2. **Race conditions in parallel agents** — Two sub-agents writing the same file causes corruption. Use separate files per agent (keyed by agent ID or task ID), never shared mutable files.

3. **Stale reference problem** — Agent reads a file, does work, file gets updated by another process. If latency matters, include a `last_modified` check. If it doesn't, read once at the start and don't re-read mid-task.

4. **Broad glob patterns** — `**/*.md` on a large project reads thousands of files. Always scope globs to specific directories. When in doubt, read a manifest file first and fetch specific files.

5. **Unvalidated file sizes** — Reading a 50MB log file into context is a silent failure. Check file size before reading. If >100KB, read only the first/last N lines.

6. **Missing existence checks** — Always check if a context file exists before reading. A missing file is not an error — it means "no prior context" and the agent should start fresh.

7. **Format drift** — If multiple agents write to the same file in different formats, parsing breaks. Define the schema in the file header and validate on write.

## Anti-Patterns to Avoid

- **Storing code in context files** — Code belongs in the codebase, not in `.md` files. Store summaries, decisions, and pointers — not implementations.
- **Duplicating database state** — If something is in Neon/DB, don't also write it to a file. Pick one source of truth.
- **Per-run files without cleanup** — Every session creating new files without pruning old ones fills the filesystem with stale context. Implement rotation.
- **Sensitive data in context files** — API keys, tokens, and secrets must never appear in context files. Use environment variables, reference by name only.

## Related Skills

multi-agent-patterns, tool-design, context-optimization, memory-systems
