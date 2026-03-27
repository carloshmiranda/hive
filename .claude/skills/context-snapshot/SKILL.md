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

## Step 2: Sync backlog DB with actual work done

This step prevents the dispatch loop from re-dispatching work already completed in interactive sessions.

1. Get recent commits: `git log --oneline --since="7 days" main`
2. Get ready/dispatched backlog items: use `mcp__hive__hive_backlog` with status `ready` and `dispatched`
3. For each ready/dispatched item, check if the work was already done this session or in recent commits:
   - Compare item title/description against commit messages and files changed
   - Check if the feature/fix already exists in the codebase
   - Consider items discussed and completed in the current conversation
4. For items that are clearly done: use `mcp__hive__hive_backlog_update` to set status=done with a note explaining when/how it was completed
5. For items that are partially done or superseded: update notes to reflect current state

**This is NOT optional.** Skipping this step causes wasted Engineer dispatches (burning Claude budget on already-done work).

## Step 3: Update each context file as needed

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

### Backlog (DB only — do NOT edit BACKLOG.md)
- Use `mcp__hive__hive_backlog_update` to mark completed items as done
- Use `mcp__hive__hive_backlog_create` for newly discovered gaps
- BACKLOG.md is auto-generated from the DB — never edit it manually

### CLAUDE.md
- If architecture, flows, or file structure changed, update the relevant section
- Keep the schema table count accurate
- Update agent execution flow if steps changed

### Memory files (in ~/.claude/projects/.../memory/)
- project_infra.md: Infrastructure, workflows, company states, known issues
- project_model_routing.md: Agent-to-provider mapping, action versions
- Other memory files: Update if their domain was touched

## Step 4: Verify completeness

Run: `grep -r 'as of 202' BRIEFING.md` and memory files to find stale date references.
Check that no "Known Blockers" or "Known Issues" sections contain resolved items.

## Step 5: Report

Tell the user what you updated and what was already current. Be concise.
Include a summary of any backlog items synced in Step 2.

IMPORTANT: Do NOT skip files or steps. The whole point is to prevent context drift and wasted dispatches.
</context-snapshot>
