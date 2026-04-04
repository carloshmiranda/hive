---
name: dev-loop
description: Interactive session quality loop. Invoke when the user says '/dev-loop', 'run quality loop', 'review what I just wrote', or 'check my changes'. Runs ts-guard → perf-review → security-scan on the current git diff and reports findings without blocking the session.
---

<dev-loop>
You are a quality loop runner for interactive coding sessions. Unlike the `/do` pipeline (which is for autonomous agent phases with hard gates), `/dev-loop` is a lightweight quality check for what you just wrote — fast feedback without blocking.

## What it does

1. Gets the current `git diff` (staged + unstaged)
2. Runs three quick checks in parallel:
   - **TypeScript / edge runtime** (from `ts-guard` skill)
   - **Performance** (from `perf-review` skill)
   - **Security** (from `security-scan` skill, if available)
3. Aggregates findings by severity
4. Reports clearly with file:line references
5. Suggests fixes for HIGH severity findings inline

## When to use

Run `/dev-loop` after you've written a chunk of code and want a sanity check before proceeding:
- After implementing a new API route
- After adding a React component
- After writing a data-fetching function
- Anytime you feel uncertain about a change

It is NOT a replacement for tests. Run tests separately.

## How to invoke

```
/dev-loop             # review all staged + unstaged changes
/dev-loop --staged    # review only staged changes
/dev-loop <file>      # review a specific file
```

## Execution

### Step 1: Collect the diff

Run `git diff HEAD` (or `git diff --staged` if `--staged` flag given). If a file path is provided, scope to that file.

If the diff is empty, report: "Nothing changed since HEAD. Stage or modify files first." and stop.

### Step 2: Run checks in parallel

Deploy three review passes simultaneously against the diff:

**Pass A — TypeScript & Edge Runtime** (from ts-guard)
Check for:
- TypeScript errors (run `npx tsc --noEmit 2>&1 | head -50` if feasible, otherwise scan diff)
- `export` from `route.ts` files (causes build failures)
- Node.js APIs in edge-runtime files (`fs`, `path`, `crypto`, `child_process` in middleware or edge routes)
- Missing `'use client'` / `'use server'` directives where needed
- Type assertions (`as any`, `as unknown`) introduced in the diff

**Pass B — Performance** (from perf-review)
Check for (scoped to diff only):
- Sequential awaits on independent operations (should be `Promise.all`)
- Barrel file imports in client components
- N+1 query patterns
- Inline non-primitive props in JSX
- Heavy library imports without `next/dynamic`

**Pass C — Security** (from security-scan, if available in project)
Check for (scoped to diff only):
- SQL string interpolation (use parameterized queries)
- Missing auth checks on new API routes
- Hardcoded secrets or API keys
- `dangerouslySetInnerHTML` without sanitization
- New environment variable reads without `?.` or default fallback

### Step 3: Aggregate and report

```
## /dev-loop Quality Report

**Diff scope:** X files changed, Y insertions, Z deletions

---

### 🔴 HIGH — Fix before continuing
These will cause build failures, security issues, or production bugs.

- [src/app/api/foo/route.ts:12] Export from route file — move to src/lib/foo.ts
- [src/lib/data.ts:34] Sequential DB awaits — wrap in Promise.all([...])

---

### 🟡 MEDIUM — Fix before merging
Real issues but won't block the build.

- [src/components/Chart.tsx:8] Barrel import from '@/components' — import directly
- [src/app/dashboard/page.tsx:22] Inline object prop on memoized component

---

### 🟢 LOW — Noted, not urgent
Minor quality improvements.

- [src/lib/settings.ts:55] process.env access without fallback

---

### ✅ CLEAN
- TypeScript: no errors detected
- Edge runtime: no Node.js API usage in edge files
- Auth: all new routes have authentication checks
- SQL: all queries parameterized
```

### Step 4: Offer to fix HIGH severity findings

After the report, ask:

> **3 HIGH severity issues found.** Want me to fix them now?
> - [list issues]
>
> Reply Y to fix all, or specify which ones.

If the user confirms, fix each HIGH severity issue directly (do not deploy subagents for this — fix inline). Re-run `npx tsc --noEmit` to confirm TypeScript issues are resolved.

## Rules

- **Never block.** Unlike `/do`, `/dev-loop` is advisory. It reports findings but does not stop work.
- **Scope to the diff.** Do not audit the entire codebase — only what changed.
- **Be concise.** The report should be scannable in 30 seconds. No long explanations — just `file:line → issue → suggested fix`.
- **Skip false positives.** If a pattern is intentional (e.g., a deliberate `as any` with a comment explaining why), note it but don't re-flag it on the next loop.
- **Parallel checks.** Run all three passes simultaneously for speed.
</dev-loop>
