---
name: define-task
description: Invoke when the user says '/define-task', 'define the task', 'set up task criteria', 'what are we building', or 'let's define success' before starting implementation work. Also invoke at the start of any session where the user describes a feature, fix, or refactor but has not yet stated checkable acceptance criteria.
---

<define-task>
You MUST capture explicit acceptance criteria before any implementation begins.

## Step 1: Extract or Elicit Task Definition

If the user has described the task, extract the following from their message:
- **What**: The change being made (feature / fix / refactor / chore)
- **Why**: The reason or motivation
- **Scope**: Files, components, or systems involved (if known)

If any element is unclear, ask ONE focused question to clarify. Do not ask multiple questions at once.

## Step 2: Write Acceptance Criteria

Define 3–7 concrete, checkable criteria. Each criterion must be:
- **Binary**: Pass or fail — no partial credit
- **Verifiable**: You can check it by reading code, running a command, or observing behavior
- **Specific**: Names the exact file, endpoint, UI state, or output

Prefer criteria in this form:
- "`GET /api/foo` returns `{ ok: true, data: [...] }` with status 200"
- "Component renders without console errors in dev mode"
- "`npm run build` passes with no type errors"
- "MISTAKES.md has no entry contradicting this approach"
- "The feature works when `ENV_VAR` is missing (graceful fallback)"

**Anti-patterns to avoid:**
- "The feature works correctly" — too vague
- "Tests pass" — which tests? what do they cover?
- "Looks good in the browser" — not checkable by another agent

## Step 3: Identify the Kill Condition

State one thing that would make you stop and ask rather than proceed:
- A dependency that might not exist
- An env var that might not be set
- A schema change that requires migration
- Behavior that conflicts with an existing ADR

## Step 4: Write to Scratch File

Save the complete task definition to `.claude/scratch/current-task.md` using this format:

```markdown
# Task: [short title]

**Type:** feature | fix | refactor | chore
**Date:** [today's date]

## What
[One paragraph describing the change]

## Why
[The motivation — what breaks, improves, or unblocks]

## Scope
- [File or system 1]
- [File or system 2]

## Acceptance Criteria
- [ ] [criterion 1]
- [ ] [criterion 2]
- [ ] [criterion 3]
...

## Kill Condition
Stop and ask Carlos if: [specific condition]

## Out of Scope
[What you will NOT do, to prevent scope creep]
```

## Step 5: Confirm Before Starting

Print the task definition to the user and say:

> "These are the acceptance criteria I'll verify before marking this done. Shall I start?"

Do not begin implementation until the user confirms or amends the criteria.

---

**IMPORTANT**: The `/context` skill (context-snapshot) will check `.claude/scratch/current-task.md` at session end and verify each criterion was addressed. If the file doesn't exist, it will flag the session as unchecked.
</define-task>
