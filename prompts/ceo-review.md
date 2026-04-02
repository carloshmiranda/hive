# CEO PR Review Process

Review and merge PRs from the Engineer agent. Two-stage review: spec compliance first, quality second. Reject early at either stage.

Follow these steps for EACH open PR.

## STEP 1 — Gather context

```bash
GH_TOKEN="$GH_PAT" gh pr view <pr_number> --repo carloshmiranda/<company> --json title,body,additions,deletions,changedFiles,mergeable
GH_TOKEN="$GH_PAT" gh pr diff <pr_number> --repo carloshmiranda/<company>
GH_TOKEN="$GH_PAT" gh pr checks <pr_number> --repo carloshmiranda/<company>
```

## STEP 2 — Hard gates (reject immediately if any fail)

- CI/build checks pass (from gh pr checks)
- No secrets in diff (API_KEY, SECRET, PASSWORD, Bearer, hardcoded tokens, .env values)
- No destructive DB migrations without rollback plan
- Diff size reasonable (>1000 lines or >20 files = flag as high-risk)

---

## STAGE 1: Spec compliance (hard gate — stop here if failed)

### STEP 3 — Task alignment

Check the PR against the planned engineering_task that triggered it:

- PR maps to a planned engineering_task from the current cycle plan
- Acceptance criteria from the task description are met
- No scope creep (changes unrelated to the assigned task)

**If task alignment fails: REJECT immediately.** Do not proceed to Stage 2.
Use: `GH_TOKEN="$GH_PAT" gh pr review <pr_number> --repo carloshmiranda/<company> --request-changes --body "STAGE 1 FAIL: <specific alignment issues>"`

Set `stage1_passed: false` in output and stop.

---

## STAGE 2: Quality review (only reached if Stage 1 passes)

### STEP 4 — Code quality scan (focus on new files + modified API routes)

- API routes have error handling (try/catch) and return { ok, data?, error? }
- SQL uses parameterized queries (no string interpolation)
- No console.log/debug artifacts left behind
- No hardcoded values (URLs, prices, emails should come from config/DB)
- New API routes call requireAuth() or have documented reason not to

### STEP 4b — Design quality scan (for PRs that touch .tsx/.css files)

- No gradients (bg-gradient-to-*, from-*, via-*) — solid colors only
- No raw hex colors in components — must use design tokens from globals.css
- No duplicate sections on the same page (two feature grids, two CTA blocks, two hero sections)
- Max 2 font weights used (font-normal, font-bold — no font-black, font-extrabold)
- No placeholder content (lorem ipsum, "Coming soon", stock photo URLs)
- Landing page changes: verify single CTA per viewport, proper section spacing
- If ANY design violation found: add +2 to risk score and list violations in review summary.

### STEP 5 — Risk score

| Factor | Points |
|--------|--------|
| Touches auth/payments/user data | +3 |
| Changes DB schema | +3 |
| Adds new dependencies | +2 |
| >500 lines changed | +2 |
| >10 files changed | +2 |
| New API routes | +1 |
| Touches landing page (page.tsx) | +1 |
| Design violations found in 4b | +2 |
| Only content/copy changes (no code) | -2 |

Score 0-3: Auto-merge. Score 4-6: Merge + log detailed summary. Score 7+: Do NOT merge, create approval gate for Carlos.

### STEP 6 — Decision

- MERGE: `GH_TOKEN="$GH_PAT" gh pr merge <pr_number> --repo carloshmiranda/<company> --merge`
- REJECT: `GH_TOKEN="$GH_PAT" gh pr review <pr_number> --repo carloshmiranda/<company> --request-changes --body "<issues>"`
- After merging, check for more open PRs: `GH_TOKEN="$GH_PAT" gh pr list --repo carloshmiranda/<company> --state open --json number,title`

## STEP 7 — Output structured review

```json
{ "pr_review": { "pr_number": N, "company": "<slug>", "task_id": "<id>",
  "hard_gates_passed": true,
  "stage1_passed": true,
  "task_aligned": true,
  "stage2_risk_score": 3,
  "decision": "merge|reject|escalate", "summary": "<one line>" },
  "pr_merged": true/false }
```
