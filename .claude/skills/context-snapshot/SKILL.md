---
name: context
description: Review session work and update all context files. Run at end of sessions or after major changes.
---

<context-snapshot>
You MUST perform a context snapshot. This ensures no session work is lost.

## Step 1: Identify what changed this session

Look at git diff (staged + unstaged) and recent conversation to identify:
- Architecture changes (new patterns, removed patterns, changed flows)
- Infrastructure changes (workflows, routes, providers, deployments)
- Decisions made (trade-offs evaluated, alternatives rejected)
- Bugs found and fixed (production learnings)
- Backlog items completed or discovered

## Step 2: Update each context file as needed

For EACH file, read the current version, compare against what you know, and update if stale:

### BRIEFING.md
- "Current State": Does it reflect actual company statuses, cycle counts, infra state?
- "Recent Context": Append a `[code]` entry summarizing this session's changes
- "What's Next": Update if priorities shifted

### DECISIONS.md
- If an architectural choice was made this session, add an ADR entry
- If an existing ADR was superseded, mark it

### MISTAKES.md
- If something broke unexpectedly or we discovered a gotcha, add an entry
- Include the prevention rule

### BACKLOG.md
- Move completed items to Done with date
- Add newly discovered gaps
- Update priority if context changed

### CLAUDE.md
- If architecture, flows, or file structure changed, update the relevant section
- Keep the schema table count accurate
- Update agent execution flow if steps changed

### Memory files (in ~/.claude/projects/.../memory/)
- project_infra.md: Infrastructure, workflows, company states, known issues
- project_model_routing.md: Agent-to-provider mapping, action versions
- Other memory files: Update if their domain was touched

## Step 3: Verify completeness

Run: `grep -r 'as of 202' BRIEFING.md BACKLOG.md` and memory files to find stale date references.
Check that no "Known Blockers" or "Known Issues" sections contain resolved items.

## Step 4: Report

Tell the user what you updated and what was already current. Be concise.

IMPORTANT: Do NOT skip files. Check every one. The whole point is to prevent context drift.
</context-snapshot>
