---
name: pre-commit
description: Invoke when the user says '/pre-commit', 'ready to commit', 'let's commit', 'commit the changes', or 'ship it'. Also invoke when you have finished implementing something and are about to stage files — before running any git add or git commit command.
---

<pre-commit>
You MUST complete this checklist before any git add or git commit. Do not skip items.

## Step 1: Verify acceptance criteria

Check if `.claude/scratch/current-task.md` exists.

- If it exists: read every `- [ ]` criterion. For each one, state whether it passes and how you verified it (command run, output observed, code read). Do not proceed to Step 2 until all criteria are verified OR you explicitly flag which ones are unmet and why you're committing anyway.
- If it does not exist: continue, but note the absence.

## Step 2: Check MISTAKES.md

Run: `grep -i "$(git diff --cached --name-only | head -5 | tr '\n' '|' | sed 's/|$//')" MISTAKES.md 2>/dev/null | head -20`

Also scan MISTAKES.md for patterns relevant to what you changed:
- If you touched auth, middleware, or env vars → check entries about those
- If you touched API routes → check the route export rule
- If you touched GitHub Actions → check the expression injection rule

If any MISTAKES.md entry applies: state it and confirm your change doesn't repeat the mistake.

## Step 3: Build check

Run `npm run build 2>&1 | tail -20`. If it fails, stop. Fix before committing.

If the build is slow or you're in a tight loop, run `npx tsc --noEmit 2>&1 | tail -20` as a fast alternative.

## Step 4: Scope check

Run `git diff --cached --stat` and review what's actually staged.

Ask yourself:
- Is anything staged that wasn't part of the task?
- Are any secrets, `.env` files, or large binaries staged?
- Is the change larger than expected? If so, why?

If anything unexpected is staged, unstage it before committing.

## Step 5: Commit message

Write a conventional commit message:
- `feat:` for new capabilities
- `fix:` for bug fixes
- `refactor:` for restructuring without behavior change
- `chore:` for tooling, config, dependencies
- `docs:` for documentation only
- `content:` for blog posts, SEO content, copy changes

Format: `type(scope): short imperative description`

Examples:
- `feat(sentinel): add urgency-tier dispatch routing`
- `fix(auth): correct env var name for GitHub OAuth`
- `chore(skills): add pre-commit verification gate`

## Step 6: Status declaration

Before committing, state one of:

- **DONE** — all criteria verified, build passes, no MISTAKES.md violations
- **DONE_WITH_CONCERNS** — criteria met but [specific concern]. Flagging for follow-up.
- **NEEDS_CONTEXT** — blocked on [specific missing information]. Not committing yet.
- **BLOCKED** — [hard blocker]. Cannot proceed without resolving first.

Only DONE and DONE_WITH_CONCERNS proceed to commit.

---

After the commit, update `.claude/scratch/current-task.md` criteria to `- [x]` for anything verified.
</pre-commit>
