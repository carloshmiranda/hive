# Mistakes & Learnings

> Every failure is a playbook entry for the future. Write here when something breaks, when an assumption was wrong, or when we discover a better approach. The orchestrator's Retro Analyst reads this file weekly to avoid repeating mistakes.

## Format

```
### [DATE] Title
**What happened:** Brief description
**Root cause:** Why it happened
**Fix applied:** What we did
**Prevention:** How to avoid this in the future
**Affects:** hive | companies | both
```

---

### 2026-03-27 vercel.json _comment property failed schema validation — 20+ ERROR deploys
**What happened:** All Vercel deployments went ERROR with 0s build time and empty logs. The `_comment` property added to vercel.json for documentation failed Vercel's strict JSON schema validation. Every deploy was rejected before the build even started.
**Root cause:** Vercel's vercel.json parser rejects unknown properties. `_comment` is not a valid field. Error message: "should NOT have additional property '_comment'". This was invisible because build logs showed nothing — the validation happens pre-build.
**Fix applied:** Removed `_comment` from vercel.json. Also disabled preview builds (`"*": false` in `git.deploymentEnabled`) to prevent branch deploys wasting the 100/day limit.
**Prevention:** Never add documentation comments to vercel.json — it's strict JSON with no comment syntax. Use git commit messages or CLAUDE.md to document vercel.json decisions. When deploys fail with 0s build time + empty logs, check vercel.json schema first.
**Affects:** hive

### 2026-03-27 QStash schedules lost during deploy outage — loop went silent
**What happened:** After fixing the deploy outage, the dispatch loop didn't restart automatically. Manual trigger revealed 4 QStash schedules were missing (sentinel-urgent, sentinel-dispatch, sentinel-janitor, uptime-monitor).
**Root cause:** QStash schedule recreation is triggered by sentinel runs. With deploys broken, no sentinel ran, and existing schedules may have expired or been cleaned up. The `qstash_heal` dispatch type in sentinel-dispatch auto-recreates missing schedules, but only when sentinel itself runs.
**Fix applied:** Manual trigger of `/api/cron/sentinel-dispatch` which auto-detected and recreated all 4 missing schedules.
**Prevention:** Add a QStash schedule health check that doesn't depend on QStash itself firing. Consider a GitHub Actions scheduled workflow (runs independently of Vercel) that checks QStash schedule count and alerts if below expected threshold.
**Affects:** hive

### 2026-03-27 Vercel deploys silently broke for ~24h after repo visibility change
**What happened:** All Vercel deployments for Hive went ERROR with 0s build time and empty build logs. The deployed app kept serving the old READY version, so uptime monitoring saw no outage. ~20 commits accumulated without deploying.
**Root cause:** The GitHub repo changed from private to public. Vercel's Git integration broke silently — it stopped being able to clone/build, but the `githubRepoVisibility: "public"` metadata showed the change. No build error was surfaced because the integration was disconnected, not the code broken.
**Fix applied:** (1) Manual reconnection of Git integration in Vercel dashboard. (2) New `checkDeployHealth()` sentinel check (Check 42) that queries Vercel Deployments API for 3+ consecutive ERROR states and sends Telegram escalation + logs to agent_actions.
**Prevention:** Monitor the *pipeline*, not just the *app*. Uptime checks (is the site responding?) are insufficient — they pass because Vercel keeps the last good deploy serving. Pipeline health (are new deploys succeeding?) is a separate signal. Sentinel now checks both.
**Affects:** hive

### 2026-03-27 MCP hive_settings tool corrupted encrypted secrets
**What happened:** Using the MCP `hive_settings` tool to update `github_token` wrote the plaintext PAT directly to the database, bypassing the encryption pipeline in `/api/settings`. Subsequent `getSettingValue("github_token")` calls attempted to decrypt plaintext → returned null → GitHub API calls returned 422.
**Root cause:** The MCP server's `hive_settings` tool wrote directly to the DB via SQL instead of routing through the `/api/settings` POST endpoint which handles encryption for SECRET_KEYS. The tool had no knowledge of the encryption requirement.
**Fix applied:** MCP server updated to route settings writes through `/api/settings` API endpoint with CRON_SECRET auth, which handles encryption automatically. Token needs to be re-saved via the API to re-encrypt.
**Prevention:** Never write to settings table via direct SQL — always go through `/api/settings` which handles encryption, cache invalidation, and validation. MCP tools must be API-first, not DB-first, for any table with business logic.
**Affects:** hive

### 2026-03-26 CI-impossible regex false positives — keyword matching is fragile for task classification
**What happened:** First regex iteration for CI-impossible task filter matched 18 ready items as false positives. Bare `dashboard` keyword caught "Add Neon Consumption API monitoring to dashboard" (a code task). Second iteration caught "Add custom Sentry tags to all API routes" because the description mentioned "in Sentry dashboard" as a benefit description, not a required action. PostgreSQL `~*` regex behaved differently from JavaScript `.test()` in some edge cases.
**Root cause:** Keyword-based classification conflates "mentions a service" with "requires interacting with a service." A task description saying "enables filtering in Sentry dashboard" is describing where results appear, not where work happens. The regex needed to match action verbs ("go to", "open", "configure in") before service names, not just "in [service] dashboard".
**Fix applied:** Changed regex from `in (the )?(sentry|...) (dashboard|...)` to `(?:go to|open|access|configure in|set up in|log into|navigate to) (the )?(sentry|...) (dashboard|...)`. Verified zero false positives against all 90+ ready items.
**Prevention:** When using regex for task classification: (1) always test against the full DB dataset, not just a few examples, (2) require action verbs before nouns to distinguish "about X" from "do X", (3) PostgreSQL `~*` regex may match differently than JS — always verify in both environments.
**Affects:** hive

### 2026-03-27 Decomposer gate relied on complexity labels, not turn budget
**What happened:** 92% engineer failure rate (44/48 in 24h). Items with estimated_turns >35 dispatched without decomposition because the gate only checked `spec.complexity === "L"`. M-complexity items with 40+ estimated_turns sailed through. Decomposed sub-tasks were also allowed up to M/40 turns, exceeding the 35-turn budget. Specless items dispatched for 35 turns blindly.
**Root cause:** Three compounding gaps: (1) Pre-dispatch decompose gate used complexity label (`"L"`) not actual estimated_turns — missed M-complexity items that exceed turn budget. (2) Sub-task clamp in backlog-planner allowed M complexity with up to 40 estimated_turns — sub-tasks exceeded the 35-turn budget they'd be dispatched with. (3) Specless items had no gate at all — dispatched for 35 turns with zero guidance.
**Fix applied:** (1) Turn-budget gate: decompose if estimated_turns >28 (80% of 35), regardless of complexity label. (2) Sub-task clamp: forced S complexity, max 25 turns. (3) Specless blocking: non-P0 items without specs marked `blocked` with `[no_spec]` note. (4) Dispatch payload cap: first-attempt max_turns capped at 35.
**Prevention:** Gates should always use the numeric value (estimated_turns) not categorical proxies (complexity labels). Labels are LLM-generated and unreliable. The numeric value is what actually determines success/failure.
**Affects:** hive

### 2026-03-26 Turn estimates capped too low — every Engineer run hit max_turns
**What happened:** 79 max_turns failures in 48h. Engineer consistently ran out of turns on tasks that should have been completable. Items retried with flat 2h cooldown, failing identically each time.
**Root cause:** Three compounding issues: (1) Turn estimate prompt used S=10-15, M=20-25, L=30-35 — systematically 40-60% too low for real tasks that need repo exploration + implementation + build verification. (2) max_turns was only sent on 3rd+ attempt — first two dispatches used the workflow default (35) regardless of spec. (3) Cooldown was flat 2h for all retries — no escalation meant the same item failed every 2h indefinitely. (4) isMaxTurns detection was hardcoded at 30 turns — missed items with higher specs.
**Fix applied:** (1) Turn estimates: S=15-20, M=25-35, L=35-50. (2) max_turns sent on every dispatch from spec. (3) Exponential backoff: 2h/6h/24h based on attempt count. (4) Dynamic isMaxTurns at 80% of spec turns. Commit 440ff05.
**Prevention:** Turn estimates should be calibrated from actual successful runs, not guessed. Add a post-completion step that logs actual turns used vs estimated — use this data to auto-calibrate future estimates.
**Affects:** hive

### 2026-03-27 fs.writeFile silently fails on Vercel — BACKLOG.md never auto-synced
**What happened:** `regenerateBacklogMd()` in `backlog-planner.ts` generated the correct markdown from DB data but wrote it using `fs.writeFile`. The function ran without errors in production, but BACKLOG.md was never updated — it drifted from the DB for weeks (305 items in DB, ~40 in the file).
**Root cause:** Vercel serverless functions run on a read-only filesystem. `fs.writeFile` succeeds (writes to ephemeral container tmpfs) but the file disappears when the container recycles. No error is thrown. The sentinel-janitor called `regenerateBacklogMd()` daily, generating correct content into the void.
**Fix applied:** Replaced `fs.writeFile` with GitHub Contents API (`PUT /repos/{owner}/{repo}/contents/BACKLOG.md`). The function now commits directly to the repo via GH_PAT. Falls back gracefully (logs warning) if GH_PAT is not available.
**Prevention:** Never use `fs.writeFile` for persistent file changes on Vercel. For git-tracked files, use the GitHub Contents API. For temporary storage, use Vercel Blob or Upstash Redis. Add this to the "Known Gotchas" in MEMORY.md.
**Affects:** hive

### 2026-03-26 Backlog DB sync gap — interactive sessions complete work but dispatch loop re-does it
**What happened:** 13 backlog items were found still marked `ready` in `hive_backlog` DB despite being fully implemented in the codebase (PR auto-merge suite, recurring escalation automation, capability assessment fix, etc.). The dispatch loop picked up and re-dispatched already-completed work, wasting Claude budget on unnecessary Engineer runs.
**Root cause:** Interactive Claude Code sessions commit code and update `BACKLOG.md` but forget to update `hive_backlog` DB status. The dispatch loop reads from DB only — it never checks BACKLOG.md or git history. This creates a sync gap: work is done but the system doesn't know.
**Fix applied:** (1) Manually synced all 13 items via MCP `hive_backlog_update` tool. (2) Updated context-snapshot skill with mandatory Step 2: query ready/dispatched items, cross-reference against commits, mark done items before updating any context files.
**Prevention:** Always run `/context` at end of sessions — Step 2 now catches sync gaps automatically. When completing any backlog item in an interactive session, update BOTH `BACKLOG.md` AND `hive_backlog` DB (use MCP `hive_backlog_update`).
**Affects:** hive

### 2026-03-26 Sentry DSN never configured — error tracking was completely inert for days
**What happened:** `@sentry/nextjs` was fully integrated in the codebase (server, edge, client configs, `withSentryConfig` in next.config.js, instrumentation files) but `SENTRY_DSN` env var was never set in Vercel. `Sentry.init()` with `undefined` DSN silently does nothing — no errors, no warnings, just no error capture.
**Root cause:** The Sentry integration was added as code changes without the corresponding Vercel Marketplace install that auto-provisions the DSN. Code was merged, build passed, deploy succeeded — all green signals while error tracking was completely inactive.
**Fix applied:** Installed Sentry via Vercel Marketplace (auto-provisions SENTRY_DSN + SENTRY_AUTH_TOKEN). Pushed empty commit to trigger redeploy with new env vars.
**Prevention:** For any SDK that requires external configuration (Sentry, Redis, etc.), add a startup health check that verifies the config is actually set. Log a CRITICAL warning if `SENTRY_DSN` is undefined. Consider adding a `/api/health` check that reports which integrations are active vs. configured-but-inert.
**Affects:** hive

### 2026-03-26 SQL linter errors on main blocked ALL PR CI for days
**What happened:** PRs #48, #49, #51 all had failing `lint-and-build` CI despite being valid code changes. No PR could merge.
**Root cause:** Two SQL linter errors were committed to main: (1) `company-health/route.ts` referenced `dispatched_at` on `company_tasks` (column doesn't exist), (2) `sentinel-janitor/route.ts` referenced `dispatched_at` and `pr_url` on `hive_backlog` (columns exist but janitor was checking wrong table context). The SQL linter (`scripts/lint-sql.ts`) validates column names against `schema.sql` — these errors were on main, so every PR branch that built on top of main inherited them.
**Fix applied:** Commit 3f6c667 fixed both linter errors on main. All 3 PRs were rebased onto fixed main and CI passed.
**Prevention:** Always run `npx next build` locally before pushing to main. The SQL linter runs as part of build — catching errors before they reach CI prevents days-long blocks on all PRs.
**Affects:** hive

### 2026-03-26 Engineer death spiral: empty specs caused 100% failure rate
**What happened:** 112 ready backlog items, 0 moving. Last 5 Engineer runs ALL failed with `error_max_turns`. Circuit breaker blocked all dispatch.
**Root cause:** `hive_backlog.spec` column was empty/null for most items. Without specs (`{files, do, done}`), Engineer spent 36 turns exploring the codebase to figure out what to do, ran out of turns, and failed. The spec is what tells Engineer exactly which files to edit and what to implement — without it, every task becomes L-complexity exploration.
**Fix applied:** Populated 11 P1 items with actionable specs containing file paths, specific code changes, and acceptance criteria. Data-driven dispatch plan (per-item skip instead of global circuit breaker) already implemented.
**Prevention:** Every backlog item dispatched to Engineer MUST have a non-empty `spec` with at minimum: `files` (which files to touch), `do` (what to implement), `done` (how to verify). The planner/decomposer should refuse to mark items as `ready` without specs. Add a pre-dispatch validation check.
**Affects:** hive

### 2026-03-26 company_tasks has no pr_number column — assumed schema match with hive_backlog
**What happened:** company-health Check 45 (company PR merge) tried to update `company_tasks` using `pr_number = ${pr.number}`, but `company_tasks` table has no `pr_number` column. The query silently matched nothing. Similarly, Check 38 (Hive PR merge) used `notes LIKE '%PR #N%'` which is fragile text matching.
**Root cause:** Assumed `company_tasks` had the same schema as `hive_backlog` (which does have `pr_number`). Different tables, different schemas — `company_tasks` links to PRs via branch naming convention (`hive/cycle-<N>-<task-id>`), not a column.
**Fix applied:** Check 38 now uses `WHERE pr_number = ${pr.number}` (hive_backlog has this column). Check 45 now extracts task_id from branch name pattern, matching the webhook handler's existing approach.
**Prevention:** Always verify column existence with `schema.sql` before writing SQL. Don't assume two tables have the same columns even if they serve similar purposes. The webhook handler (`webhooks/github/route.ts` line 358-362) was already correct — check existing code for patterns before writing new queries.
**Affects:** hive

### 2026-03-26 Backlog chain_next flag missing from manual kickstart — chain never continued
**What happened:** Manual dispatch to restart the backlog chain used `{source: "manual_kickstart", reason: "restart_chain"}` but the chain dispatch step in hive-engineer.yml only fires if `BACKLOG_ID` is non-empty OR `chain_next: true` in the payload. Without either flag, the chain step was skipped after completion.
**Root cause:** The chain continuation logic has two triggers: (1) Engineer completed a backlog item (`BACKLOG_ID` set), (2) explicit `chain_next: true` in dispatch payload. Manual kickstart had neither — the first successful run completed and stopped.
**Fix applied:** Re-dispatched with `chain_next: true` in the payload. Chain is now self-sustaining.
**Prevention:** Document the required payload fields for chain dispatch. When manually restarting the chain, always include `chain_next: true`. Consider making chain continuation the default behavior when source is "manual_kickstart".
**Affects:** hive

### 2026-03-26 ENCRYPTION_KEY missing caused all worker agents to fail silently for days
**What happened:** Growth, Outreach, and Ops agents had 0% success rate. Error logs showed settings decryption failures but the connection to ENCRYPTION_KEY was not immediately obvious. Meanwhile, Flolio was also blocked by Attack Challenge Mode (429 errors) and Engineer couldn't dispatch to company repos (GH_PAT missing `workflow` scope).
**Root cause:** ENCRYPTION_KEY env var was never set in Vercel after the crypto.ts encryption was implemented. All encrypted settings (openrouter_api_key, etc.) were unreadable. Three separate config issues compounded — each required manual intervention.
**Fix applied:** (1) Set valid 64-char hex ENCRYPTION_KEY in Vercel, (2) disabled Flolio Attack Challenge Mode, (3) added `workflow` scope to existing GH_PAT.
**Prevention:** Add a startup health check that validates ENCRYPTION_KEY format and tests one setting decryption. Log a CRITICAL-level error (not just a warning) if decryption fails. Add a Sentinel check for "worker agent 0% success rate over N hours" that creates a P0 escalation with config checklist.
**Affects:** hive

### 2026-03-26 MCP hive_sql_mutate cannot update approvals table
**What happened:** Attempted to clean up 20+ duplicate/resolved approvals via MCP SQL mutate tool. All UPDATE queries returned `affected: 0` rows despite correct SQL syntax and matching WHERE clauses. Tried different column names, JSONB casting, different filter conditions — all returned 0.
**Root cause:** Unknown. Possibly RLS policy, database trigger, or MCP tool restriction on the approvals table specifically. Other tables work fine with sql_mutate.
**Fix applied:** None — issue unresolved. Workaround: use direct database access or the approvals API endpoint for mutations.
**Prevention:** When building MCP tools that wrap DB access, test UPDATE/DELETE operations on all tables, not just SELECT. Document any tables with restricted mutation access.
**Affects:** hive

### 2026-03-26 Dumb auto-decompose produced 63 junk sub-tasks that blocked their parents
**What happened:** Auto-decompose chunked approach steps into 1-2 step groups with hardcoded `complexity: "S"` and generic acceptance criteria. 63 useless sub-tasks were created. Parents were marked as decomposed and stopped being dispatched. The backlog filled with narrative fragments that no Engineer could execute.
**Root cause:** Step-based chunking has no understanding of code, dependencies, or testability. Grouping "step 1-2" and "step 3-4" produces coupled fragments, not independent tasks. Acceptance criteria like `"Implements: Add error handling to..."` tell the Engineer nothing concrete.
**Fix applied:** (1) Replaced dumb chunking with LLM-assisted `decomposeTask()` that reads the codebase and produces single-responsibility sub-tasks with concrete acceptance criteria. (2) L-complexity tasks dispatch to `hive-decompose.yml` on GitHub Actions for Claude Max quality. (3) Rejected all 63 junk sub-tasks, unblocked 32 parent items.
**Prevention:** Never decompose tasks with heuristics alone. Task decomposition requires codebase understanding — always use LLM for this. Validate sub-task quality: each must have specific files, testable criteria, and be independently completable.
**Affects:** hive

### 2026-03-26 Schema-map drift caused 98% failure rate inflation
**What happened:** Sentinel check 7 flagged schema-map mismatch every hour, creating error actions that inflated the failure rate metric. `content_language` column was added to playbook table but schema-map.ts wasn't regenerated.
**Root cause:** `scripts/generate-schema-map.ts` had its `writeFileSync` call commented out (line 205). The regex didn't match `CREATE UNLOGGED TABLE`. SQL comments in column definitions broke column parsing.
**Fix applied:** Fixed generator (uncommented write, regex for UNLOGGED, comment stripping). Added `schema-map:check` CI step that fails if schema-map.ts is out of date.
**Prevention:** CI enforcement is the only reliable way to prevent drift. Generator scripts must be tested after schema changes. Never comment out the write step "temporarily."
**Affects:** hive

### 2026-03-25 toJson in GitHub Actions breaks on single quotes in payload content
**What happened:** All workflow runs silently failed after Engineer created tasks with descriptions containing single quotes (e.g., `"No 'unknown (0 turns)' failures"`). The entire cascade stalled — 48 items ready, 0 dispatched.
**Root cause:** Workflow YAML used `PAYLOAD='${{ toJson(github.event.client_payload) }}'` — the single-quoted wrapper. When the JSON payload contained literal single quotes, bash saw `PAYLOAD='{"desc": "No '` then `unknown (0 turns)` as an unquoted command → syntax error. First fix attempt used heredocs (`<<'EOF'`) but the EOF marker at column 0 broke GitHub Actions' YAML literal block parser, causing ALL runs to fail with "workflow file issue."
**Fix applied:** Replaced all inline `${{ toJson() }}` in bash with step-level `env:` variables: `env: DISPATCH_PAYLOAD: ${{ toJson(github.event.client_payload) }}` then `echo "${DISPATCH_PAYLOAD}"` in bash. Applied to hive-engineer.yml (6 patterns), hive-ceo.yml (4), hive-scout.yml (3), hive-healer.yml (1).
**Prevention:** NEVER use `'${{ toJson(...) }}'` in bash blocks. Always pass structured data through `env:` vars with `${{ toJson() }}` — GitHub evaluates the expression at YAML level (safe), and bash receives it as a normal env var (no quoting issues). Add to workflow YAML rules in CLAUDE.md.
**Affects:** hive

### 2026-03-25 Error extraction was silently broken in all 4 agent workflows
**What happened:** 118 Engineer failures logged as "unknown (0 turns)", 80+ Sentinel NULL errors, auto-decompose never triggered despite being implemented. 5 P0s were blocked because Hive couldn't see what was going wrong.
**Root cause:** Three bugs in the "Log failure" step across hive-engineer, hive-ceo, hive-healer, hive-scout: (1) No file existence check — when Claude never starts, execution_file doesn't exist, jq silently returns empty. (2) jq selector filtered for `.type == "result" or "error"` but missed `.type == "system"` (used for max_turns). (3) No fallback to capture GitHub Actions-level errors. Healer had a hardcoded "Healer workflow failed" string with zero context.
**Fix applied:** Rewrote error extraction in all 4 workflows: file existence check → correct jq with .error/.result + system/error type scan → "workflow_crash" subtype when no exec file → GitHub Actions run URL in every error.
**Prevention:** (1) Error callbacks must always have a fallback for missing files. (2) Test error paths, not just happy paths. (3) When adding a new error subtype, verify the jq selector matches it.
**Affects:** hive

### 2026-03-25 Sentinel checks after line ~1900 silently never executed
**What happened:** PR auto-merge (check 38), backlog decompose (check 39), playbook consolidation (check 29), portfolio analysis (check 28), and broken deploy repair (check 30) appeared to work but never actually ran. These checks were positioned after ~1900 lines of sequential execution in a 3426-line function with a 60s Vercel timeout.
**Root cause:** Sentinel grew organically from 16 to 39 checks without considering cumulative execution time. HTTP-heavy checks (fetching company endpoints, GitHub API, Vercel API) consumed the full 60s budget before reaching later checks. No monitoring detected this because the function returned 500 (timeout) which Vercel doesn't log as a structured response.
**Fix applied:** Extracted 6 HTTP-heavy checks (31, 32, 33, 36, 38, 30) into `/api/cron/company-health` endpoint (ADR-030). Sentinel fires it as non-blocking fetch. Both get their own 60s window.
**Prevention:** (1) Monitor Sentinel execution time — if >45s, consider splitting. (2) Order checks by criticality, not by when they were added. (3) Large serverless functions should have internal timing — abort gracefully at 50s instead of hard timeout.
**Affects:** hive

### 2026-03-25 MCP server broke on @neondatabase/serverless v1.x upgrade
**What happened:** All MCP tools using dynamic SQL queries (`hive_backlog`, `hive_actions`, `hive_failure_summary`, `hive_sql`) returned errors. Tagged-template queries still worked.
**Root cause:** `@neondatabase/serverless` v1.0.2 changed `neon()` to return a tagged-template-only function. Dynamic queries using `sql(string)` broke — need `sql.query(string)` instead.
**Fix applied:** Changed all `sql(...)` calls to `sql.query(...)` in mcp/server.js (12 occurrences).
**Prevention:** Pin major versions in package.json, or test after npm install. When a DB driver changes API, check all query patterns.
**Affects:** hive (local tooling)

### 2026-03-25 Healer wastes max_turns on settings/config issues
**What happened:** Healer was dispatched for "Neon API key not configured" (systemic, 4 companies). Spent all 35 turns trying to fix it in code, but the issue is a missing setting in /settings — requires manual action, not code changes.
**Root cause:** Healer has no classification step to distinguish "code bug" from "missing configuration." It treats all errors as fixable by code changes.
**Fix applied:** None yet. Added to known issues.
**Prevention:** Healer should classify errors before attempting fixes: (1) config/settings errors → create a todo/approval for Carlos, don't attempt code fix. (2) infra errors (missing DB, Vercel down) → route to repair-infra. (3) code errors → attempt fix. Classification can use keyword matching: "not configured", "API key", "setting" → config class.
**Affects:** hive

### 2026-03-24 Cascade marks backlog items "done" before PR merge — false completion notifications
**What happened:** Carlos received Telegram notifications that 15+ backlog items were "completed" but none of the code was on main. 7 PRs sat open, unmerged. The cascade kept dispatching new items while claiming previous ones were done.
**Root cause:** `backlog/dispatch/route.ts` marked items `status = 'done'` when Engineer reported `completed_status = "success"`. But "success" means "PR created", not "code merged." There was no lifecycle step between PR creation and merge.
**Fix applied:** (1) Added `pr_open` status — Engineer success now moves items to `pr_open` instead of `done`. (2) GitHub webhook handler for `pull_request.closed` events marks `pr_open` items as `done` on merge or resets to `ready` on close-without-merge. (3) Added max 5 retry cap to prevent infinite retry loops (one item reached 104 attempts).
**Prevention:** Any "completion" status must verify the actual outcome (merge, deploy, metric change), not just that the agent exited successfully. Agent "success" ≠ task "done."
**Affects:** hive

### 2026-03-24 NextRequest wrapping crashes OIDC auth on consumed request bodies
**What happened:** All chain dispatch calls from GitHub Actions to `/api/backlog/dispatch`, `/api/dispatch/cycle-complete`, and `/api/dispatch/health-gate` returned 500 errors. CRON_SECRET-authenticated calls worked fine.
**Root cause:** OIDC auth path did `new NextRequest(req)` to wrap the standard Request. But when the request body has already been consumed (by `req.json()`), constructing a new NextRequest crashes with `TypeError: Cannot read priv...`. Since `validateOIDC` only reads headers (not body), the wrapping was unnecessary.
**Fix applied:** Changed `validateOIDC` signature from `NextRequest` to `{ headers: { get(name: string): string | null } }`. Removed `new NextRequest(req)` from all 3 files — pass `req` directly.
**Prevention:** Never wrap `req` in `new NextRequest()` for helpers that only read headers. If a helper needs body access, it should accept the already-parsed body as a parameter.
**Affects:** hive

### 2026-03-24 Response envelope unwrap bug — chain dispatch always fell through
**What happened:** Engineer workflow's chain dispatch step always fell through to cycle-complete even when backlog had items to dispatch. The cascade burned company cycle quota instead of processing Hive backlog.
**Root cause:** `hive-engineer.yml` read `.dispatched` from the response, but Hive's `json()` helper wraps all responses in `{ok: true, data: {...}}`. The actual path is `.data.dispatched`. Since `.dispatched` was always undefined, it defaulted to `false`.
**Fix applied:** Changed jq extraction to `.data.dispatched // .dispatched // false` to handle both wrapped and unwrapped responses.
**Prevention:** All internal callers of Hive API endpoints must unwrap the `{ok, data}` envelope. Add this to CLAUDE.md as a standard pattern.
**Affects:** hive

### 2026-03-24 Sentinel auto-resolve loop — 94 dispatches/48h for single company
**What happened:** Sentinel Check 25 (recurring escalation detector) tried to auto-resolve `capability_migration` and `escalation` approvals by matching them against the capability registry. This false-matched to `repair_infra`, which was called but couldn't fix the issue (wrong endpoint for the problem). The approval stayed pending, so next run it tried again. Combined with Check 17 creating NEW escalation approvals on every run (no dedup), this created 94 dispatches in 48h for Flolio alone.
**Root cause:** Auto-resolve should only apply to gate types that CAN be resolved by calling an API endpoint (like `spend_approval` matching `repair_infra`). `capability_migration` and `escalation` gates require human review or code changes — no API can fix them.
**Fix applied:** (1) Skip `capability_migration`, `escalation`, `ops_escalation`, `new_company`, `kill_company` from auto-resolve. (2) Dedup Check 17 escalation approvals. (3) Shortened expiry to 2-3 days. (4) Bulk-expired 34 stale noise approvals.
**Prevention:** When adding auto-resolve logic, always ask: "Can this gate type actually be resolved by calling an API?" If not, skip it. Auto-resolve is for recurring infra problems, not for workflow/configuration issues.
**Affects:** hive

### 2026-03-24 Scout proposes names without checking domain/Vercel availability
**What happened:** CiberSegura was proposed with slug `cibersegura`, but `cibersegura.vercel.app` was already taken by a Spanish cybersecurity site. Vercel assigned `cibersegura-flax.vercel.app` — an unprofessional URL. The DB stored the assumed URL (wrong), and Carlos was confused by seeing someone else's Spanish site. Additionally, CiberSegura was proposed as a blog but provisioned as SaaS (same poupamais bug).
**Root cause:** Scout prompt had zero guidance on checking name/domain availability. It assumed any slug would work.
**Fix applied:** Added Phase 5 to Scout prompt: mandatory Vercel subdomain check (web_fetch), GitHub repo check, and domain availability search before finalizing proposals. If taken, must pick a different name.
**Prevention:** Scout MUST verify availability before proposing. Provisioner should also read back actual Vercel domains from the API response rather than assuming `{slug}.vercel.app`.
**Affects:** both

### 2026-03-24 CiberSegura URL pointing to someone else's site
**What happened:** `cibersegura.vercel.app` showed a Spanish cybersecurity site that Carlos thought was ours. Our actual site was at `cibersegura-flax.vercel.app` — Vercel added the `-flax` suffix because `cibersegura.vercel.app` was already taken by another user.
**Root cause:** During provisioning, the code assumed the Vercel project would get `{slug}.vercel.app` as its domain. Vercel adds random suffixes when the name is taken. The DB stored the assumed URL, never the actual one.
**Fix applied:** Updated DB to `cibersegura-flax.vercel.app`.
**Prevention:** After Vercel project creation, read back the actual domains from the Vercel API response instead of assuming `{slug}.vercel.app`. Add this check to the provisioning flow.
**Affects:** both

### 2026-03-24 Zero metrics across all companies — broken stats pipeline
**What happened:** All companies showed 0 page_views, 0 signups, 0 customers. The metrics cron ran successfully but silently fell back to zeros for every company.
**Root cause:** Three cascading failures: (1) Most company repos don't have `/api/stats` endpoint (VerdeDesk, Flolio), (2) Senhorio has one but with wrong response format and 500 error, (3) No pageview-tracking middleware deployed. The boilerplate has these files but agents overwrote or never deployed them.
**Fix applied:** Added Sentinel Check 31 that probes `/api/stats` on every company each run and auto-creates engineering tasks when broken. First run detected 4 broken endpoints and created 3 fix tasks.
**Prevention:** After provisioning, run a health check on `/api/stats` before marking the company as ready. Add stats endpoint validation to the post-provision verification step.
**Affects:** both

### 2026-03-23 Provisioning sets wrong company_type when Claude agent hits max_turns
**What happened:** Poupamais was proposed by Scout as a blog/affiliate site, approved by Carlos, but provisioned as SaaS. The company got SaaS boilerplate, SaaS validation phases, and SaaS-specific build tasks — completely wrong business model.
**Root cause:** The Engineer provision agent's STEP 0 (set company_type) is a Claude Code step that queries the approval context and sets the type. When the agent hit max_turns (30) before completing STEP 0, company_type was never set. The provisioner defaulted to SaaS behavior. The business_model from the Scout proposal was lost.
**Fix applied:** Added a pre-flight shell step in `hive-engineer.yml` that runs BEFORE the Claude agent. It queries the approvals table directly via DATABASE_URL, extracts `business_model` from the Scout proposal context, and sets `company_type` in the DB. Shell steps can't hit max_turns — they always complete.
**Prevention:** Critical data transforms (like setting business type) must happen in deterministic shell steps, not inside LLM agents that can hit turn limits. Any step where failure = silent wrong default is a pre-flight candidate.
**Affects:** both (Hive workflow + all future companies)

### 2026-03-23 Healer self-reinforcing failure loop
**What happened:** Healer hit max_turns (25), logged its own failure to agent_actions. Sentinel saw higher failure rate, dispatched Healer again. 5 failures in one day, ~$0.60 each wasted.
**Root cause:** Sentinel's failure rate calculation included healer and sentinel's own failures, creating a feedback loop where healer failures triggered more healer dispatches.
**Fix applied:** (1) Excluded `healer` and `sentinel` from failure rate query. (2) Added 6h cooldown guard before dispatching healer on high failure rate. (3) Bumped Healer max-turns from 25 to 35.
**Prevention:** Agents that respond to failure metrics must exclude their own failures from those metrics. Always add cooldown guards to prevent rapid re-dispatch loops.
**Affects:** hive

---

### 2026-03-25 Sentinel dispatch loops: missing dedup on recurring checks
**What happened:** 262 infra_repair calls in 48h, 38 Evolver gap_analyses in 48h. Both were no-ops that wasted compute.
**Root cause:** Two patterns: (1) Check 9c queried `neon_project_id IS NULL` but all Vercel-managed DBs have this as NULL — false positive for all 4 companies every Sentinel run. (2) Evolver dispatch for `evolveDue` and `highFailureRate` had no dedup guard — dispatched every hour when conditions stayed true.
**Fix applied:** Check 9c: added `NOT EXISTS (infra WHERE service='vercel')` exclusion + 24h dedup. Evolver dispatch: added 24h dedup query on agent_actions.
**Prevention:** Every Sentinel dispatch MUST have a dedup guard (query for recent same-type action in last N hours). When writing a query for "missing X", verify that X is actually expected to exist — don't query for standalone Neon projects when DBs are Vercel-managed.
**Affects:** hive

### 2026-03-25 CEO-sourced company tasks stuck in 'proposed' — never executed
**What happened:** 82/102 company_tasks stuck in `proposed` status. Engineer never picked them up.
**Root cause:** POST /api/tasks used DB default status (`proposed`). CEO already validates tasks against phase gates, but the tasks needed manual approval to move to `approved`. No approval flow existed.
**Fix applied:** CEO-sourced tasks auto-set to `approved` in POST /api/tasks (already phase-gate validated).
**Prevention:** When adding new status-based workflows, verify the full lifecycle: who creates → what status → who advances → who executes. Don't add statuses without a transition mechanism.
**Affects:** both

### 2026-03-22 Boilerplate module-level SDK initialization crashes builds without env vars
**What happened:** PoupaMais provisioning failed because `neon(process.env.DATABASE_URL!)` and `new Stripe(process.env.STRIPE_SECRET_KEY!)` were called at module scope. During `next build`, these execute even though env vars aren't set, crashing the build.
**Root cause:** SDK clients initialized at module scope (file load time) instead of inside request handlers. Next.js evaluates all route modules during build for tree-shaking.
**Fix applied:** Moved all `neon()` and `new Stripe()` calls inside handler functions in: waitlist/route.ts, webhooks/resend/route.ts, webhooks/stripe/route.ts, checkout/page.tsx.
**Prevention:** Never initialize SDK clients at module scope in Next.js route handlers or server components. Always instantiate inside the handler function.
**Affects:** both (template + all provisioned companies)

### 2026-03-21 Engineer generates false compliance claims and mixes languages
**What happened:** Senhorio's landing page claimed "100% Compliant with Portuguese tax law" and "all receipts meet Portuguese legal requirements" — but there's no receipt generation, no compliance engine, no audit. FAQ answers described features as existing when they're not built. The page also mixed Portuguese and English randomly (IRS section in PT, everything else in EN), and pricing showed "Start Free Trial" buttons in waitlist mode linking to a non-functional checkout.
**Root cause:** The Engineer's build prompt had no rules against (1) making legal/compliance claims the product can't deliver, (2) describing unbuilt features as existing, (3) mixing languages, or (4) showing checkout CTAs in waitlist mode. The boilerplate's `<html lang>` was hardcoded to "en" regardless of target audience.
**Fix applied:** (1) Added "Content integrity" rules to Engineer prompt: no false claims, no stating unbuilt features as existing, social proof must be verifiable, FAQs must be honest about roadmap vs reality, pricing CTAs must respect LAUNCH_MODE. (2) Added "Language consistency" rules: entire page in one language matching target audience. (3) Boilerplate layout.tsx now uses `{{LANG}}` template variable. (4) Provisioner sed commands now include LANG replacement. (5) Company CLAUDE.md template updated with "Do NOT" rules.
**Prevention:** Engineer prompt now has explicit content integrity and language consistency sections. Boilerplate `lang` attribute is parameterized. LAUNCH_MODE is enforced in all CTA contexts.
**Affects:** both

### 2026-03-21 CEO agent never merged PRs — open PRs piled up across all companies
**What happened:** Engineer agent opened PRs and dispatched `ceo_review`, but PRs sat open unmerged. Senhorio had 3 open PRs (redesign, calculator, blog), VerdeDesk had 2, Flolio had 2. Senhorio was still showing a white boilerplate page because the redesign PR was never merged.
**Root cause:** The CEO prompt's `ceo_review` handler said "Do portfolio analysis across all companies" — it had no instructions to review or merge the PR from the payload. Also, `GH_PAT` was not passed as an env var to the CEO agent step.
**Fix applied:** Updated `hive-ceo.yml`: (1) `ceo_review` now has explicit PR review/merge instructions using `gh pr view`, `gh pr diff`, and `gh pr merge`. (2) Added `GH_PAT` env var to the agent step. (3) Manually merged all 7 open PRs across 3 companies.
**Prevention:** When adding chain dispatch between agents, always verify the receiving agent's prompt handles the dispatched event with concrete actions, not generic descriptions. Every dispatch must have a matching handler that does something actionable.
**Affects:** both

### 2026-03-18 next-auth v5 is still beta
**What happened:** `npm install` failed — `next-auth@^5.0.0` doesn't exist as a stable release.
**Root cause:** Assumed v5 was GA. It's still in beta (5.0.0-beta.30 as of March 2026).
**Fix applied:** Pinned to `5.0.0-beta.30` in package.json.
**Prevention:** Always check `npm view <pkg> versions` before specifying version ranges. Pin beta packages to exact versions.
**Affects:** hive

### 2026-03-18 getSettingValue exported from API route
**What happened:** Next.js build failed — "getSettingValue is not a valid Route export field."
**Root cause:** Next.js App Router only allows HTTP method exports (GET, POST, etc.) from route files. Helper functions can't be co-exported.
**Fix applied:** Moved `getSettingValue` to `src/lib/settings.ts`. Updated all imports.
**Prevention:** Never export utility functions from `route.ts` files. Keep route files pure — HTTP handlers only. Shared logic goes in `src/lib/`.
**Affects:** hive

### 2026-03-18 Regex 's' flag incompatible with ES2017
**What happened:** Build failed — "This regular expression flag is only available when targeting 'es2018' or later."
**Root cause:** Used `/pattern/s` (dotAll flag) in directives parser. tsconfig targets ES2017.
**Fix applied:** Removed the `s` flag — the directive parser doesn't need multiline matching.
**Prevention:** Don't use regex flags `s`, `d`, or named groups if targeting < ES2018. Or update tsconfig target.
**Affects:** hive

### 2026-03-18 lastReflection variable scoping in orchestrator
**What happened:** TypeScript error — `lastReflection` referenced before declaration.
**Root cause:** Variable was declared inside the `catch` block but referenced in the `try` block of the next iteration.
**Fix applied:** Moved `let lastReflection = ""` outside the for loop.
**Prevention:** Variables shared across loop iterations must be declared outside the loop. Review all retry/reflection patterns for this.
**Affects:** hive

### 2026-03-18 Stripe Connect was over-engineered
**What happened:** Designed Stripe Connect with connected accounts per company. Carlos correctly identified this adds complexity and fees for no benefit.
**Root cause:** Assumed multi-company = multi-account. But Carlos owns all companies — one Stripe account with metadata tagging is simpler.
**Fix applied:** Refactored `lib/stripe.ts` to single-account model. Products/prices tagged with `metadata.hive_company`.
**Prevention:** Always ask: "does this actually need separate accounts, or can metadata/labels handle it?" Single-account-with-tagging is the default for solo-operator setups.
**Affects:** both

### 2026-03-18 Neon provisioned manually instead of via Vercel Marketplace
**What happened:** Setup prompt told Carlos to create a Neon project manually. He asked why it wasn't automated.
**Root cause:** Didn't research that Neon is Vercel's native Postgres via Marketplace. One click provisions everything and auto-injects DATABASE_URL.
**Fix applied:** Updated deploy prompt to use Vercel Marketplace → Neon integration.
**Prevention:** Before adding any external service, check if Vercel has a native integration first. Vercel Marketplace > manual provisioning always.
**Affects:** hive

### 2026-03-18 Flolio referenced as active infrastructure
**What happened:** Early architecture proposed building on top of Flolio's dispatcher and agents.
**Root cause:** Memory indicated Flolio was active. Carlos corrected — the dispatcher was killed.
**Fix applied:** Redesigned as a clean standalone project. Flolio patterns (3-attempt rule, env var handling) are lessons in the playbook, not shared infrastructure.
**Prevention:** Always verify current state of referenced projects before proposing integration. Ask "is this still running?" before building on it.
**Affects:** hive

### 2026-03-18 Pre-baked research defeats the purpose of autonomous agents
**What happened:** Idea Scout prompt was stuffed with hardcoded Portuguese market research results instead of giving the agent instructions to do its own web research.
**Root cause:** The human did the research during the build session and embedded the answers directly into the prompt. This made the agent a static template, not an autonomous researcher.
**Fix applied:** Replaced pre-loaded research context with a research methodology (Phase 1-4: discovery → competition → validation → scoring). Agent now uses web search via Claude Code CLI to do 10-15 searches per run. Added 25 max turns, 15 min timeout, and research trail logging (searches_performed, niches_considered) for audit.
**Prevention:** Agent prompts should contain METHODOLOGY, not ANSWERS. If the human knows the answer, the agent doesn't need to exist. The prompt should teach the agent HOW to find answers, not WHAT the answers are. The only pre-loaded data should be dynamic state (portfolio, killed companies, playbook).
**Affects:** idea_scout, all future agents

### 2026-03-18 Orchestrator can't import Next.js app modules
**What happened:** Digest email code did `require("./src/lib/resend")` which chains to `@/lib/settings` → `@/lib/db`. These are Next.js path aliases that `ts-node` can't resolve.
**Root cause:** The orchestrator runs as a standalone `ts-node` process outside of Next.js. It can't use path aliases like `@/lib/*`. Any module that lives in `src/` and uses these aliases is inaccessible from the orchestrator.
**Fix applied:** Inlined the digest email HTML and Resend API call directly in `orchestrator.ts` using its own Neon connection and `getSettingValueDirect()`. The `src/lib/resend.ts` file remains for use within the Next.js app (API routes) where path aliases work fine.
**Prevention:** The orchestrator must be fully self-contained. It can share DATA with the Next.js app (via Neon), but it cannot share CODE. Never `require()` anything from `src/` in `orchestrator.ts`. If both need the same logic, duplicate it or extract to a standalone module with no path aliases.
**Affects:** orchestrator, digest email

### 2026-03-18 auth.ts used wrong env var names
**What happened:** `auth.ts` referenced `GITHUB_OAUTH_ID` / `GITHUB_OAUTH_SECRET` but deploy prompt sets `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET`. Login broke on every fresh deploy. Claude Code had to fix it every time but the archive kept shipping the broken version.
**Root cause:** Env var names were never synced between auth.ts and the deploy prompt. NextAuth v5 convention uses `AUTH_*` prefix.
**Fix applied:** auth.ts now reads `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET` matching the deploy prompt.
**Prevention:** Env var names must be defined in ONE place (CLAUDE.md) and referenced everywhere else. Never hardcode env var names — always cross-check against the deploy prompt.
**Affects:** auth, login, all API routes

### 2026-03-18 Middleware blocked webhooks and cron
**What happened:** Middleware matcher only excluded `/login` and `/api/auth`. Stripe webhooks, GitHub webhooks, and Vercel cron calls were all blocked by NextAuth auth check — they'd get redirected to login.
**Root cause:** The matcher regex was written for dashboard-only auth. Webhook and cron endpoints were added later without updating the middleware exclusion list.
**Fix applied:** Middleware now excludes: `api/webhooks`, `api/cron`, `api/health`. GitHub webhook got HMAC-SHA256 signature verification as its own auth layer.
**Prevention:** Every time a new public endpoint is added, check the middleware matcher. Webhooks and crons ALWAYS need their own auth mechanism (signature verification, bearer token) — they can never rely on session auth.
**Affects:** webhooks, cron, health endpoint

## 12. Vercel subdomains cannot be verified for email sending

**What happened:** Orchestrator tried sending from `outreach@company.hive.local` — a fake domain that Resend immediately rejects. Vercel-provided subdomains (`hive-phi.vercel.app`) can't have DNS records added since the parent domain (`vercel.app`) is owned by Vercel.

**Fix:** Email architecture now has two modes. Test mode uses `onboarding@resend.dev` (only reaches Resend account owner — fine for digest). Verified mode requires a real domain with Resend DNS records (DKIM + SPF + MX) added. The `sending_domain` setting controls which mode is active. Cold outreach emails are SKIPPED entirely unless a verified domain exists — this prevents silent failures and spam-folder delivery.

**Rule:** Never hard-code fake email domains. Always check for verified sending infrastructure before attempting to send to external recipients. Internal emails (digest to Carlos) can use test mode; external emails (outreach, transactional) require domain verification.

### 2026-03-19 Schema CHECK constraints fell behind code evolution
**What happened:** Full codebase review revealed that `agent_actions.agent` CHECK allowed 12 agent names but the code used 16. `approvals.gate_type` CHECK allowed 6 types but the code used 10. `agent_actions.cycle_id` and `company_id` were NOT NULL but multiple code paths insert with NULL. Every orchestrator run would crash on the first Idea Scout, Healer, or Outreach action.
**Root cause:** Schema was written during the initial build session. As new agents (outreach, research_analyst, healer) and gate types (outreach_batch, vercel_pro_upgrade) were added to the code, nobody updated the CHECK constraints in schema.sql. The mismatch was invisible because the live DB was never tested with a full nightly run — only the dashboard and webhooks ran.
**Fix applied:** Migration `002_fix_constraints.sql` drops and recreates both CHECK constraints with all values. `cycle_id` and `company_id` made nullable. `settings` table added to schema.sql (was only dynamically created). schema.sql updated for fresh installs.
**Prevention:** When adding a new agent name or gate type to ANY code path, grep schema.sql for the CHECK constraint and update it in the same commit. Rule: `git diff --name-only | grep -q orchestrator && grep -c "CHECK.*agent" schema.sql` — if the orchestrator changed, verify the schema matches. Consider removing CHECK constraints entirely and relying on application-level validation (more flexible, same safety).
**Affects:** both (schema + orchestrator + dispatch endpoint)

### 2026-03-19 Agent proliferation without scope boundaries
**What happened:** Started with 7 agents, grew to 10+ (Idea Scout, Research Analyst, Venture Brain, Kill Switch, Retro Analyst, Health Monitor, Auto Healer, Provisioner, etc.). Many were ghost names — referenced in code, referenced in CHECK constraints, but never actually dispatched as separate agents. Each "agent" burned a separate Claude call even when the scope overlapped (e.g. Venture Brain and CEO both do strategic analysis; Healer and Health Monitor both fix errors).
**Root cause:** New capabilities were added as new agents instead of new triggers for existing agents. No litmus test for "does this need its own agent?"
**Fix applied:** Consolidated to 7 agents (ADR-012). Migration 003 renames all records. "One agent, one verb" rule: CEO plans, Scout discovers, Engineer builds, Ops monitors, Growth creates, Outreach prospects, Evolver improves.
**Prevention:** Before creating a new agent, ask: "Is this a new capability or a new trigger for an existing agent?" If the output format and tools are the same as an existing agent, it's a trigger, not an agent. Add it as a new event type on the existing workflow.
**Affects:** both (schema, orchestrator, workflows, dispatch)

### 2026-03-19 Import route crashes on duplicate company slug
**What happened:** Importing VerdeDesk the second time returned a 500 error. `INSERT INTO companies` hit a UNIQUE constraint on `slug` because the first attempt left a stale row.
**Root cause:** Import route assumed every import was for a new company. No idempotency — no check for existing slug before inserting.
**Fix applied:** Import route now does `SELECT` first. If company exists, `UPDATE` its fields (name, description, github_repo) and promote status from idea/approved → mvp. Also clears stale pending import records for the same company.
**Prevention:** Any user-facing create endpoint must handle re-submission gracefully. Always check for existing records before INSERT. Prefer upsert patterns (SELECT → UPDATE/INSERT) over raw INSERT for entities with natural keys (slug, email, etc.).
**Affects:** hive (imports route)

### 2026-03-19 Approval decide route didn't fire repository_dispatch
**What happened:** Approving the VerdeDesk import gate did nothing — no CEO agent was dispatched. The approval status updated in the DB but no downstream work happened.
**Root cause:** The approval decide route had side effects for updating company status but never called GitHub's `repository_dispatch` API. The CEO workflow listens for `gate_approved` events but nothing was sending them.
**Fix applied:** Added `dispatchEvent()` helper to the approval decide route. On `new_company` approval, it fires `gate_approved` with the company_id as payload. CEO workflow picks it up.
**Prevention:** When building event-driven chains, trace the full path: trigger → handler → next trigger. If a handler doesn't emit the next event, the chain is broken. Test the chain end-to-end, not just individual handlers.
**Affects:** hive (approval flow, agent dispatch)

### 2026-03-19 claude.ai/install.sh returns 403 — blocks all brain agents
**What happened:** All GitHub Actions brain agent workflows (CEO, Scout, Engineer, Evolver) fail at the Claude CLI install step. `curl -fsSL https://claude.ai/install.sh` returns HTTP 403.
**Root cause:** Anthropic infrastructure issue. The install endpoint is globally returning 403 — not specific to our repo, token, or workflow. Confirmed by curling directly.
**Fix applied:** None possible — must wait for Anthropic to fix their CDN/install endpoint.
**Prevention:** Brain agents depend on a third-party install script with no fallback. Consider: (1) caching the Claude CLI binary in the repo or a release artifact, (2) using a Docker image with CLI pre-installed, (3) pinning a specific CLI version URL that might be more stable. External install scripts are a single point of failure.
**Affects:** all brain agents (CEO, Scout, Engineer, Evolver)

### 2026-03-19 claude-code-base-action v0.0.63 ignored model parameter
**What happened:** All brain agents ran on Sonnet despite CLAUDE.md documenting them as "Opus via Max". The model parameter in the workflow YAML was silently ignored.
**Root cause:** Version v0.0.63 of anthropics/claude-code-base-action had a bug (GitHub issue #255) where the ANTHROPIC_MODEL env var wasn't passed to the CLI. Fixed in later versions.
**Fix applied:** Upgraded all workflows from claude-code-base-action to claude-code-action@v1. Set explicit model per agent via native `model` input.
**Prevention:** When using third-party GitHub Actions, always pin to a recent version and verify that configuration parameters actually take effect. Test with a manual dispatch and check the action logs for which model was used.
**Affects:** all brain agents (CEO, Scout, Engineer, Evolver)

### 2026-03-19 Hive monitors companies but not itself — 6 commits went undeployed
**What happened:** 6 commits pushed directly to main after a PR merge never triggered Vercel deployments. Dynamic todos, growth intelligence, and workflow fixes were all committed and pushed but not live on the dashboard. Had to manually run `vercel deploy --prod`.
**Root cause:** Three blind spots: (1) GitHub webhook only tracked company repos — the `hive` repo itself was silently ignored because it's not in the `companies` table. (2) Sentinel checked 7 company-level conditions but nothing about Hive's own deployment state. (3) No mechanism compared the latest git SHA against the deployed SHA on Vercel.
**Fix applied:** Three detection layers: sentinel check #8 compares main SHA vs Vercel production SHA every 4h; webhook now logs hive repo pushes and deploy failures to `context_log`; todos endpoint surfaces deploy drift as a dashboard warning.
**Prevention:** Any self-hosted system that monitors other systems must also monitor itself. When building detection/healing for child resources, always ask: "does this also cover the parent?" Add the parent as a first-class target, not an afterthought.
**Affects:** hive (dashboard, detection layer)

### 2026-03-20 dispatchEvent silently failed on Vercel — GH_PAT only in GitHub Actions
**What happened:** Clicking Approve on evolver proposals (and all approval side effects) silently did nothing. No workflow was triggered. The approval status updated in the DB but `dispatchEvent()` returned without sending anything.
**Root cause:** All three `dispatchEvent()` functions read `process.env.GH_PAT`. That env var is set as a GitHub Actions secret but NOT as a Vercel env var. The dashboard runs on Vercel, so `GH_PAT` was always undefined. The function had `if (!ghPat) return;` which silently returned.
**Fix applied:** Extracted `dispatchEvent` to `src/lib/dispatch.ts`. It reads `github_token` from the encrypted settings table first (works on Vercel), falls back to `GH_PAT` env var (works in GitHub Actions). Added error logging instead of silent failure.
**Prevention:** When code runs on Vercel and needs secrets, read from the settings table (encrypted in Neon), not from env vars. Env vars set as GitHub Actions secrets are NOT available on Vercel. The two runtimes have different secret stores. Any function that dispatches events from the dashboard must use the settings table.
**Affects:** all approval side effects, evolver proposals, github webhook escalation

### 2026-03-20 Evolver approval button did nothing for non-prompt proposals
**What happened:** Clicking "Approve" on `setup_action` and `knowledge_gap` evolver proposals only set `status = 'approved'` in the DB. No dispatch, no todo, no follow-up. The `implemented_at` field existed in the schema but nothing ever set it, even for `prompt_update` proposals that were implemented immediately.
**Root cause:** The PATCH handler only had a code path for `prompt_update`. Other proposal types were designed to be "passed to CEO as context" via the orchestrator's query, but this was a passive injection — no active dispatch or tracking.
**Fix applied:** Three type-specific handlers: `prompt_update` → activate prompt + set `implemented_at`; `setup_action` → create `pending_manual` todo + dispatch `ceo_review`; `knowledge_gap` → dispatch `ceo_review`. Added stale approval detection in todos (>48h without implementation).
**Prevention:** When adding a new entity type with an approval flow, trace each type's post-approval path end-to-end. If clicking "Approve" doesn't trigger a visible downstream action, the flow is broken. Every approval should either (a) do something immediately, (b) create a trackable action item, or (c) dispatch to an agent. "Passive context injection" is not sufficient — it has no feedback loop.
**Affects:** hive (evolver proposals, dashboard)

### 2026-03-19 claude-code-action@v1 does not support `model` or `max_turns` as inputs
**What happened:** CEO workflow ran on Sonnet despite `model: "claude-opus-4-20250514"` being set. Action logs showed: `Unexpected input(s) 'model', 'max_turns'`. The init message confirmed `"model": "claude-sonnet-4-6"` (default).
**Root cause:** `claude-code-action@v1` only accepts `claude_args` for passing CLI flags like `--model` and `--max-turns`. The `model` and `max_turns` inputs don't exist — GitHub Actions silently ignores unknown inputs but logs a warning in the Post step.
**Fix applied:** Changed all 4 brain workflows to use `claude_args: "--model claude-opus-4-20250514 --max-turns 25"` instead of separate `model` and `max_turns` inputs.
**Prevention:** Always check the action's valid inputs list (shown in the `Unexpected input(s)` warning or in the action's `action.yml`). Don't assume input names — verify against the source. After deploying a workflow, check the init log for `"model":` to confirm the right model is running.
**Affects:** all brain agents (CEO, Scout, Engineer, Evolver)

### 2026-03-20 No HTTP health checks — broken deploys go undetected
**What happened:** Senhorio's Vercel deployment was in ERROR state (build failed due to missing DATABASE_URL env var). Nobody detected it — not Sentinel, not Ops, not the Engineer. The dashboard showed Senhorio as "mvp" with infra, appearing healthy.
**Root cause:** Three monitoring gaps: (1) Sentinel's deploy_drift only compares Git SHAs, never checks if the build succeeded. (2) Ops agent says "health_status: ok" based on LLM reasoning, not actual HTTP checks. (3) GitHub webhook needs 3 failures in 24h to escalate — a single broken first deploy is invisible.
**Fix applied:** Added real HTTP health checks to Sentinel — curls every company's vercel_url every 4h and dispatches ops_escalation if not 200. Added post-provisioning verification within 2h of scaffold_company.
**Prevention:** Every monitoring system must verify actual observable behavior (HTTP 200), not just metadata (SHAs, timestamps, log entries). "Did the deploy event happen?" is not the same as "is the site actually up?"
**Affects:** both

### 2026-03-20 Engineer provisions infra but doesn't set env vars or update companies table
**What happened:** Engineer created GitHub repo + Vercel project for Senhorio but: (1) never set DATABASE_URL env var on Vercel → build failed, (2) never updated companies.vercel_project_id → metrics cron found 0 companies to scrape → metrics table stayed empty → dashboard showed all zeros.
**Root cause:** Provisioning prompt had explicit steps for creating resources but no step for configuring them. The boilerplate's /api/waitlist route calls neon() at build time, requiring DATABASE_URL.
**Fix applied:** Added step 4b to Engineer provisioning prompt (set env vars via Vercel API). Added step 6 to update companies table columns. Backfilled existing companies from infra table.
**Prevention:** Provisioning checklists must include post-creation configuration, not just resource creation. Every resource that needs env vars should have a verification step.
**Affects:** hive

### 2026-03-21 cycle_complete dispatch loop burned ~30 GitHub Actions runs in 20 minutes
**What happened:** CEO `cycle_complete` chain dispatch included "Always dispatch cycle_complete" at the end. Each `cycle_complete` → CEO runs → dispatches `cycle_complete` again → infinite loop. Each iteration spawned 5 workflow runs (CEO, Engineer feature_request, Engineer new_company, Scout research, Growth). ~30 runs in 20 minutes before manually cancelled.
**Root cause:** `cycle_complete` was treated as a trigger that needed the same downstream dispatches as `cycle_start`. But `cycle_complete` is a TERMINAL event — the CEO reviews the cycle and writes to DB, no further chaining needed. Also, `check_signal` used `grep -qi "$1"` as a fallback which matched prose mentions (e.g., the word "needs_provisioning" appearing in CEO's reasoning text), causing false `new_company` dispatches every time.
**Fix applied:** (1) `cycle_complete` is now terminal — NO dispatches. (2) Only `cycle_start` dispatches downstream agents. (3) `gate_approved` only dispatches `new_company` if explicitly flagged. (4) `check_signal` uses strict JSON pattern matching only (`"key": true`), no prose matching. (5) Engineer `new_company` now checks if already provisioned before re-scaffolding.
**Prevention:** Never create dispatch loops. Every event type must be classified as either TRIGGER (creates downstream work) or TERMINAL (writes to DB, no chaining). Draw the dispatch graph before deploying. Also: never use broad text matching on LLM output for dispatch decisions — false positives cause cascading waste.
**Affects:** hive (GitHub Actions budget, all agent workflows)

### 2026-03-21 Engineer feature_request prompt was 1 line — caused 100% failure rate
**What happened:** Every `feature_request` dispatch to Engineer failed with `error_max_turns` (51 turns, $1.49 each). Senhorio's cycle 1 CEO plan (tax calculator + landing page) was never built despite multiple attempts.
**Root cause:** Four compounding failures: (1) CEO chain dispatch sent `company: ""` — the Engineer had no idea which company to work on. (2) The `feature_request` prompt was literally one sentence: "Read the CEO plan from cycles table, implement the code changes in the company's repo, commit + push." No instructions on HOW to clone the company repo, authenticate git, query the cycle, or scope work. (3) The Engineer runs on the hive repo checkout — for `feature_request` it needs to clone the company's repo, but had no instructions. (4) CEO plan had 2 medium tasks; no instruction to limit scope.
**Fix applied:** (a) CEO chain dispatch now always includes `company` + `company_id` in payloads, with guard to skip all dispatches if company is empty. (b) `feature_request` prompt expanded to 14 detailed steps: extract company, query cycle plan, clone company repo with GH_PAT auth, implement ONE task per run, build, branch, PR, log. (c) Explicit `GH_TOKEN="$GH_PAT"` auth instructions for all git/gh commands. (d) `cycle_start` trigger always dispatches `feature_request`.
**Prevention:** Every trigger handler in a workflow prompt needs step-by-step instructions proportional to its complexity. If a handler needs repo switching, DB queries, and git operations, one sentence is not enough. Compare each handler against `new_company` (the gold standard) and ensure similar detail level.
**Affects:** hive (Engineer workflow, CEO chain dispatch, full ideation→MVP loop)

### 2026-03-20 Chain dispatch grep patterns don't match agent output format
**What happened:** Scout completed research_request successfully (794 chars output) but chain dispatch never fired CEO. The grep pattern `research_delivered.*true` didn't match because the agent's output was in a markdown code block, prose, or mixed format — not raw JSON on a single line.
**Root cause:** Chain dispatch relied on exact `grep -q "key.*true"` patterns against the agent's last assistant message. Claude's output format varies: sometimes raw JSON, sometimes JSON in code blocks, sometimes prose mentioning the key. The grep was too brittle.
**Fix applied:** Three-layer matching: (1) Perl-compatible regex for JSON-like patterns (`"?key"?\s*[:=]\s*"?true`), (2) semantic grep for natural language mentions, (3) trigger-based fallback (if trigger was `research_request` and agent succeeded, research was delivered). Applied to Scout, CEO, and Engineer chain dispatches.
**Prevention:** Never use exact string matching on LLM output. LLMs produce varied formats. Use multi-pattern matching with fallbacks. Best approach: infer intent from the trigger type + success status, not from parsing the output text.
**Affects:** hive (all chain dispatches)

### 2026-03-20 Rate-limited agents fail silently with 0 turns — never retried
**What happened:** When Max 5x quota is exhausted, agents fail with "exhausted after 0 turns ($0 USD)". These failures are logged but never retried after the quota window resets. Work is silently dropped.
**Root cause:** No distinction between "code bug" failures and "quota exhaustion" failures. Both are logged identically and neither triggers automatic retry.
**Fix applied:** Sentinel now detects 0-turn failures from the last 6h, maps them back to the correct dispatch event type, and re-dispatches automatically.
**Prevention:** Transient failures (rate limits, network timeouts) need retry logic distinct from permanent failures (code bugs, missing permissions). The system should classify errors and handle each category differently.
**Affects:** both

### 2026-03-21 Sentinel dispatched agents for companies without infrastructure
**What happened:** Sentinel dispatched CEO, Engineer, Scout, Growth, Outreach for senhorio every 4 hours (~36 wasted Actions runs/day). All runs either failed or were cancelled because senhorio has status 'mvp' but no GitHub repo, no Vercel project, no Neon DB.
**Root cause:** Sentinel queries filtered on `status IN ('mvp','active')` but never checked for actual infrastructure. A company can have status 'mvp' without infra if provisioning was interrupted or manual. Only checks 12 (stalled) and 13 (needs cycle) had `EXISTS (SELECT 1 FROM infra ...)` guards.
**Fix applied:** Added `github_repo IS NOT NULL` to 8 Sentinel queries (checks 2-5, 8, 16, HTTP health, missing metrics). Check 9b (orphaned MVPs) intentionally keeps companies without infra — it dispatches `new_company` to trigger provisioning.
**Prevention:** Any system that dispatches work for entities must verify the entity has the prerequisites to receive that work. Status fields alone are not sufficient — check for actual infrastructure (repo, project, DB). Rule: `status = 'mvp'` means "ready to build" but only if `github_repo IS NOT NULL AND vercel_url IS NOT NULL`.
**Affects:** hive (Sentinel, Actions budget)

### 2026-03-21 Boilerplate template placeholders never replaced — shipped literal {{COMPANY_NAME}}
**What happened:** Company repos provisioned from the boilerplate contained literal `{{COMPANY_NAME}}`, `{{SLUG}}`, `{{COMPANY_URL}}` strings in page.tsx, layout.tsx, robots.txt, llms.txt, sitemap.ts, and package.json. The site would display "{{COMPANY_NAME}}" as the title.
**Root cause:** The Engineer provision prompt only replaced placeholders in CLAUDE.md (via the template file). The boilerplate source files were copied verbatim with no sed/replace step. Also, placeholder names were inconsistent (`{{SLUG}}` vs `{{COMPANY_SLUG}}`). Also, `{{TARGET_AUDIENCE}}` and `{{VALUE_PROPOSITION}}` in llms.txt were undocumented.
**Fix applied:** (1) Provisioning prompt now runs `find + xargs sed` to replace all 6 placeholder types across all boilerplate files. (2) `.github/` excluded from sed (GitHub Actions `${{ }}` syntax). (3) `{{POSITION}}` excluded (runtime template in waitlist route). (4) `{{COMPANY_SLUG}}` normalized to `{{SLUG}}` in sitemap.ts. (5) Verification grep added to confirm no unresolved templates.
**Prevention:** Template systems must have: (a) a canonical list of ALL placeholders in one place, (b) a replacement step that covers ALL files (not just one), (c) a verification step that confirms no templates remain. When adding a new placeholder to any template file, add it to the canonical list AND the replacement step in the same commit.
**Affects:** both (boilerplate, company repos)

### 2026-03-21 Literal ${{ }} in workflow prompt caused phantom runs on every push
**What happened:** Every push to main created a failed 0s run for `hive-engineer.yml`. GitHub showed "This run likely failed because of a workflow file issue." Runs had 0 jobs.
**Root cause:** Line 133 of the Engineer workflow had a comment inside a `prompt: |` block containing literal `${{ }}` (empty GitHub Actions expression). GitHub Actions evaluates ALL `${{ }}` expressions in workflow files, even inside multi-line YAML strings. An empty expression is a parse error, which makes GitHub create phantom failed runs for every push.
**Fix applied:** Replaced `${{ }}` with natural language ("GitHub Actions expression syntax").
**Prevention:** NEVER put literal `${{ }}` in workflow file content outside of actual expressions — not in comments, not in prompt text, not in strings. GitHub has no concept of "this is just text" — it evaluates everything. This rule is now in CLAUDE.md under Naming Standards > Workflow YAML.
**Affects:** hive (all workflows)

### 2026-03-21 Engineer re-provisioned Senhorio 4 times instead of building features
**What happened:** 4 `scaffold_company` successes logged for Senhorio in one session. Each cycle, the Engineer re-ran provisioning instead of executing the CEO's feature plan.
**Root cause:** The `new_company` dispatch event was being sent alongside `feature_request` from chain dispatch. The `new_company` job has `if: trigger == 'new_company'` but if both events arrive simultaneously, both jobs run. The idempotency check ("already provisioned") catches this but wastes a workflow run.
**Prevention:** Chain dispatch should NEVER send `new_company` for companies that already have `github_repo IS NOT NULL`. Sentinel check 9b already handles orphaned MVPs — chain dispatch should trust that and only send `feature_request` for provisioned companies.
**Affects:** hive (Engineer workflow, Actions budget)

### 2026-03-21 Secret consolidation — agents couldn't find keys in both environments
**What happened:** Service keys (Gemini, GSC, Resend) were stored as GitHub Actions secrets but dashboard/Vercel code read from the encrypted settings table. Keys existed in one place but were needed in the other.
**Root cause:** No single source of truth for service keys. GitHub Actions secrets are invisible to Vercel code, and vice versa.
**Fix applied:** Service keys live in the settings table only (encrypted with AES-256-GCM). Agents read them via DATABASE_URL at runtime. GitHub Actions secrets reserved for infra-only: DATABASE_URL, GH_PAT, CLAUDE_CODE_OAUTH_TOKEN, VERCEL_TOKEN, CRON_SECRET.
**Prevention:** When adding a new API key or service credential: (1) Store it in the settings table via the dashboard, (2) Access it via `getSettingValue()` in code, (3) NEVER add it as a GitHub Actions secret unless it's needed for workflow infrastructure. Rule: if an agent needs it, it goes in the DB. If GitHub Actions needs it to bootstrap, it goes in secrets.
**Affects:** both

### 2026-03-21 Context files went stale — caused wrong recommendations in next session
**What happened:** `project_infra.md` said `waitlist_total column missing` (already fixed), senhorio status was wrong, and `project_model_routing.md` claimed `claude-code-action@v1 only works with PR/issue triggers` (false — v1 works with all triggers including repository_dispatch). CLAUDE.md said "13 tables" (actually 17).
**Root cause:** Architecture changes were implemented in code but documentation wasn't updated in the same session. No automated check or reminder to update context files after significant changes.
**Fix applied:** (1) Fixed all stale memory files. (2) Created `/context` skill that reviews all 7 context files and updates stale ones. (3) Added PreCompact hook that reminds to save context before compaction. (4) Added SessionStart (compact) hook that re-injects BRIEFING.md after compaction. (5) Updated CLAUDE.md "Self-Improvement Rules" with mandatory 8-point checklist.
**Prevention:** After ANY architecture, infrastructure, or workflow change: update BRIEFING.md, project_infra.md, DECISIONS.md, and CLAUDE.md in the same session. The PreCompact hook now fires automatically when context is about to compress, forcing a context save. Run `/context` when in doubt.
**Affects:** hive (all future sessions)

### 2026-03-21 Imported company (Flolio) had plaintext API keys in committed JSON files
**What happened:** Flolio's legacy agent-queue system stored API keys (Gemini, Resend) as plaintext in `.github/agent-queue/*.json` files. When repos were made public for unlimited GitHub Actions minutes, these keys became exposed. Google and GitGuardian flagged them.
**Root cause:** Flolio was built before Hive's secret architecture. Its agents committed task files containing raw secret values. No secret scanning was enabled on the repo.
**Fix applied:** Deleted both files from the repo. Keys must be rotated (git history retains the values).
**Prevention:** (1) When importing a company, scan for committed secrets before making the repo public. (2) NEVER commit API keys, tokens, or secrets to any file in a repo — use environment variables or encrypted DB storage only. (3) Enable GitHub secret scanning on all repos. (4) The Onboarding agent should include a secret scan step in Phase 1.
**Affects:** both (imported companies especially)

### 2026-03-21 CEO agent exhausting max-turns budget (25 turns for Opus)
**What happened:** CEO on Opus consistently hit the 25-turn limit, producing `error_max_turns` failures. Each failed run cost ~$1.56 with no usable output. Failure logging also reported "0 turns" because `execution_file` output was empty.
**Root cause:** (1) Opus is slower and more thorough than Sonnet — 25 turns is insufficient for the CEO's full cycle (read 3 files, query multiple tables, determine lifecycle mode, write plan, save product spec). (2) The `execution_file` output variable from `claude-code-action` was empty, so the fallback `jq` commands returned defaults.
**Fix applied:** Increased CEO max-turns from 25 to 40. Added fallback path `/home/runner/work/_temp/claude-execution-output.json` for execution file when the output variable is empty.
**Prevention:** When setting `--max-turns` for Opus agents, use 35-40 minimum (Opus uses ~1.5x more turns than Sonnet for equivalent work). Always test with a manual workflow_dispatch before relying on automated triggers. Add fallback paths for action outputs — don't assume output variables are always populated.
**Affects:** hive (CEO workflow)

### 2026-03-21 Engineer 404 dispatching workflow_dispatch to company repos
**What happened:** Engineer build job returned HTTP 404 when trying to trigger `hive-build.yml` on company repos via the GitHub API `workflow_dispatch` endpoint.
**Root cause:** The `GH_PAT` (fine-grained PAT) requires explicit `workflow` scope to trigger `workflow_dispatch` on other repos. Without it, the API returns 404 (not 403) to avoid leaking repo existence. Also, the provision job relied on the Claude agent following prompt instructions to use `GH_TOKEN="$GH_PAT"` — fragile since agents don't always follow env var instructions.
**Fix applied:** (1) Added `GH_TOKEN: secrets.GH_PAT` as env var directly on the provision job (agents inherit it automatically). (2) Added `NEON_API_KEY` to Engineer env block. (3) Added descriptive error message for 404 failures pointing to PAT scope check.
**Prevention:** When a GitHub API call returns 404, first check PAT scopes — GitHub returns 404 instead of 403 for security. Always set `GH_TOKEN` as a job-level env var, never rely on prompts to instruct agents to export it. Required PAT scopes for Hive: `repo`, `workflow`, `admin:org` (for secrets).
**Affects:** hive (Engineer workflow, all company builds)

### 2026-03-21 Boilerplate updates not retroactively applied to existing companies
**What happened:** Updated workflow files (hive-build.yml, hive-growth.yml, hive-fix.yml) and added BACKLOG.md to the boilerplate, but existing companies (VerdeDesk, Senhorio, Flolio) still had the old versions. Changes only affected future provisioning.
**Root cause:** No mechanism to propagate boilerplate updates to existing repos. The Sentinel's capability migration (check #20) handles DB schema and code features, but not workflow files or documentation templates.
**Fix applied:** Manually pushed updated files to all 3 company repos via GitHub Contents API.
**Prevention:** When updating templates/boilerplate/ workflow files or adding new boilerplate docs, ALWAYS push changes to all existing company repos in the same session. Use `gh api` to iterate over active companies. The Sentinel should also detect stale workflow files (compare SHA against boilerplate) and auto-update them.
**Affects:** both (any boilerplate change)

### 2026-03-21 Engineer dispatch to company repos returned 422 — no company builds ever ran
**What happened:** Every Engineer dispatch to company repos (hive-build.yml) failed with HTTP 422: "Invalid value for input 'payload'". Zero company repo workflows ever executed successfully. All 6 Engineer feature_request dispatches failed identically.
**Root cause:** The `workflow_dispatch` request body was constructed with inline string interpolation. The `payload` input was injected as `$(echo "$PAYLOAD" | jq -c '.')` which outputs raw JSON like `{"company":"verdedesk"}` directly into the JSON body. GitHub `workflow_dispatch` inputs are strings, not objects. The raw JSON broke the outer JSON structure, making the `payload` field invalid.
**Fix applied:** Replaced inline string construction with `jq -n --arg` to build the entire request body. This properly escapes the payload as a JSON string value, not a nested object.
**Prevention:** NEVER construct JSON bodies with string interpolation in shell scripts — use `jq -n` with `--arg` for proper escaping. When passing JSON-within-JSON (like a payload string that itself is JSON), the inner JSON must be string-escaped. Rule: if the value could contain `"`, `{`, or `}`, use `jq --arg` not `$()` interpolation.
**Affects:** hive (Engineer → company dispatch chain, all company builds)

### 2026-03-21 Claude CLI --allowedTools is variadic — eats the next positional argument
**What happened:** `claude -p --allowedTools 'Bash,Read,Write,Edit' "Your prompt here"` resulted in "Error: Input must be provided" — the CLI received no prompt.
**Root cause:** The `--allowedTools` flag in Claude Code CLI accepts `<tools...>` (variadic). In Commander.js, variadic options consume ALL subsequent non-flag arguments. So `--allowedTools 'Bash,Read,Write,Edit' "prompt"` treated the prompt string as another tool name, leaving no positional prompt argument.
**Fix applied:** Switched company repo workflows to `anthropics/claude-code-action@v1` which handles CLI invocation internally. The action passes `claude_args` and `prompt` separately, avoiding the variadic issue.
**Prevention:** When calling `claude -p` directly (not via claude-code-action), either: (a) pipe the prompt via stdin (`echo "prompt" | claude -p --allowedTools ...`), (b) use `--` to terminate flag parsing before the prompt, or (c) use claude-code-action which handles this correctly. NEVER pass a prompt as a positional argument after a variadic flag.
**Affects:** both (any workflow using direct `claude -p` CLI)

### 2026-03-21 CLAUDE_CODE_OAUTH_TOKEN doesn't work with direct `claude -p` CLI
**What happened:** Company repo workflows using `claude -p` with `CLAUDE_CODE_OAUTH_TOKEN` env var returned 401: "Invalid authentication credentials". The Hive repo's CEO workflow using `claude-code-action` with the same token type worked fine.
**Root cause:** `claude-code-action` handles OAuth token authentication internally (likely via `claude setup-token` or config file injection). The direct `claude -p` CLI doesn't automatically use `CLAUDE_CODE_OAUTH_TOKEN` as an env var for authentication — it needs either interactive login, `ANTHROPIC_API_KEY`, or token setup via `claude setup-token`.
**Fix applied:** Switched all company repo workflows from direct `claude -p` to `anthropics/claude-code-action@v1`. The action handles auth properly via its `claude_code_oauth_token` input.
**Prevention:** Always use `claude-code-action` for GitHub Actions workflows, never call `claude -p` directly. The action handles authentication, CLI installation, and output capture. Direct CLI usage requires manual auth setup that's fragile in CI environments.
**Affects:** both (any workflow calling claude CLI directly)

### 2026-03-21 GitHub Actions strips masked secrets from cross-job outputs
**What happened:** Engineer workflow's build job received empty `GH_TOKEN`. The context job fetched all tokens via OIDC and passed them as job outputs, but GitHub Actions logged `##[warning]Skip output 'gh_pat' since it may contain secret` and refused to pass the values.
**Root cause:** GitHub Actions has a security feature: when a step uses `::add-mask::` on a value and then sets that value as a job output, GitHub detects the match and **strips the output** to prevent secret leakage between jobs. The logs show "Skip output X since it may contain secret" for ALL four token outputs.
**Fix applied:** Removed all token outputs from the context job. Each job that needs tokens (provision, build, build-hive) now fetches its own tokens via its own OIDC exchange step. Context job only passes non-secret values (trigger, payload, company, company_repo).
**Prevention:** NEVER pass secrets between GitHub Actions jobs via outputs. Each job must fetch its own secrets independently. The `::add-mask::` + job output pattern is fundamentally broken for secrets. Use OIDC token exchange per-job instead.
**Affects:** hive (any multi-job workflow passing secrets via outputs)

### 2026-03-21 Vercel build cache served stale CSS — Tailwind v4 utility classes never compiled
**What happened:** Senhorio's landing page rendered as unstyled white text despite having correct HTML with Tailwind classes. The CSS file (`496c7420d56a886f.css`) contained only Tailwind v4 theme variables (color, spacing, typography tokens) but zero compiled utility classes (no `.bg-blue-600`, `.flex`, `.rounded-xl`, etc.).
**Root cause:** The `postcss.config.mjs` file was missing from the repo (Tailwind v4 requires it to compile utility classes). When we added it and pushed, Vercel's build log showed "Restored build cache from previous deployment" — Next.js reused the cached CSS output from the previous build (which had no PostCSS plugin configured). The CSS file hash stayed identical, confirming the cache was served instead of a fresh compilation.
**Fix applied:** Pushed a change to `globals.css` (added CSS custom properties) to invalidate the CSS cache and force a fresh Tailwind v4 compilation.
**Prevention:** (1) When adding PostCSS config to an existing project, always make a concurrent change to the CSS entry point to bust the build cache. (2) The boilerplate must ship with `postcss.config.mjs` from day one — never rely on it being added later. (3) After any CSS infrastructure change, verify the compiled CSS file contains actual utility classes, not just theme tokens.
**Affects:** both (senhorio, boilerplate)

### 2026-03-21 Shell injection from ${{ }} in workflow run scripts
**What happened:** Engineer build job crashed with `syntax error near unexpected token '('` when the task description contained parentheses. The dispatch step for Vercel Analytics task never ran.
**Root cause:** `PAYLOAD='${{ needs.context.outputs.payload }}'` injects the JSON directly into the shell script. If the payload contains shell metacharacters (`(`, `)`, `$`, backticks, etc.), bash interprets them as syntax. This is the same class of bug as the 422 JSON escaping issue — user-provided strings must never be injected raw into shell scripts.
**Fix applied:** Changed from inline `PAYLOAD='${{ }}'` to `env: PAYLOAD_JSON: ${{ }}`. GitHub Actions env vars are safely passed without shell interpretation.
**Prevention:** NEVER use `${{ }}` inside shell `run:` blocks for values that may contain special characters. Always pass them via `env:` block, which is safe. This applies to ALL workflow inputs, payloads, and user-provided strings.
**Affects:** hive (engineer build dispatch, any workflow using ${{ }} in run blocks)

### [2026-03-23] Escalations defaulted to "tell Carlos" instead of using existing APIs
**What happened:** Senhorio went 8 cycles without a Neon database. The CEO agent created manual `spend_approval` escalations asking Carlos to go to console.neon.tech. Meanwhile, `/api/agents/provision` and `src/lib/neon-api.ts` already had the code to do this automatically.
**Root cause:** Three compounding failures: (1) Agents had no awareness of Hive's own capabilities — they didn't know provisioning APIs existed. (2) The escalation path always defaulted to "create approval gate for Carlos" with no retry-via-API option. (3) The Evolver detected the problem (18 proposals!) but proposals sat in `pending` status waiting for human review.
**Fix applied:** (1) Capability registry (`hive-capabilities.ts`) — 20 endpoints registered, injected into agent context. (2) `/api/agents/repair-infra` — auto-provisions missing Neon DBs, callable by Sentinel. (3) Recurring escalation detector auto-resolves via capability registry. (4) Circuit breaker stops blind retries after 3 failures. (5) Safe Evolver proposals auto-approve after 24h.
**Prevention:** When adding a new API endpoint, register it in `hive-capabilities.ts` with trigger patterns. Agents should always check capabilities before escalating to Carlos. The default should be "try to fix it, then escalate" not "escalate immediately."

### [2026-03-22] Sentinel silently 500-ing for days — 3 schema mismatches
**What happened:** Sentinel cron was returning empty 500s on every run. No error details in Vercel logs (just a truncated `fetchConnectionCache` warning). Three separate schema mismatches:
1. `metrics.metric` — query used key-value syntax (`m.metric = 'mrr'`, `m.value`) but table has flat columns (`m.mrr`, `m.date`)
2. `agent_actions.metadata` — query referenced `metadata->>'turns_used'` but column is `tokens_used`
3. `approvals.gate_type` constraint — code used `capability_migration` and `social_account` but DB constraint hadn't been migrated to include them
**Root cause:** Schema was updated in schema.sql but the constraint wasn't applied to the live DB. The `metadata` and `metric` references were written assuming a different schema shape. No error boundary meant the 500 was silent — Vercel logs showed only the Neon SDK deprecation warning, not the actual error.
**Fix applied:** Fixed all 3 queries, added try/catch error boundary that returns the actual error message and stack trace, updated live DB constraint.
**Prevention:** (1) Always add error boundaries to cron handlers — silent 500s are undebuggable. (2) After writing SQL queries, verify column names against `information_schema.columns`. (3) When adding new enum values to schema.sql, also run the ALTER on the live DB or add a migration step.

### 2026-03-25 CEO repository_dispatch 12/12 failed — prompt too large for max_turns
**What happened:** CEO agent via repository_dispatch failed 12/12 times since 3/21 (100% failure rate). cycle_task (direct Vercel call) worked fine.
**Root cause:** The inline prompt told the agent to read BRIEFING.md (454 lines) + CLAUDE.md (670 lines) + prompts/ceo.md (452 lines) = 1,576 lines of context before starting work. The agent burned 10-15 of its 40 turns just reading files and making DB queries, leaving insufficient turns for actual work.
**Fix applied:** Removed CLAUDE.md read (CEO doesn't need architecture details). Extracted 62-line PR review block into `prompts/ceo-review.md` (only loaded for ceo_review trigger). Made context loading trigger-specific (skip BRIEFING.md for simple triggers). Reduced inline prompt from ~100 to 41 lines. Context reduction: 67% for ceo_review, 43% for cycle_start.
**Prevention:** When writing agent prompts for GitHub Actions, calculate total context size (inline + referenced files + DB queries) and ensure it fits within ~50% of max_turns. The other 50% is for actual work. Never tell agents to read files they don't need for the specific trigger.
**Affects:** hive

### 2026-03-25 Schema-map drift breaks all PR CI
**What happened:** All open PRs (10+) failed CI because `scripts/lint-sql.ts` uses `src/lib/schema-map.ts` as a static copy of DB schema constraints. When agents added new values (agent names, gate types, columns), the map wasn't updated → every PR failed the SQL lint check.
**Root cause:** `schema-map.ts` is manually maintained — no sync mechanism with `schema.sql`. Agent-generated code adds new enum values to schema.sql but never touches schema-map.ts.
**Fix applied:** Updated schema-map.ts with 5 agent names (`auto_merge`, `dispatch`, `webhook`, `system`, `admin`), 1 gate type (`pr_review`), 3 columns (`market`, `content_language`, `decided_at`), 1 status (`completed`). Also fixed schema.sql CHECK constraints to match.
**Prevention:** Added P1 backlog item for auto-sync between schema.sql and schema-map.ts. Until implemented: any schema.sql change must also update schema-map.ts.
**Affects:** hive

### 2026-03-25 Engineer callback missing error type breaks auto-decompose
**What happened:** Auto-decompose logic (split failing L/M tasks into S sub-tasks on `error_max_turns`) was wired in `/api/backlog/dispatch` but never triggered. The error type field in the callback was always empty.
**Root cause:** `hive-engineer.yml` chain dispatch step sent `{"completed_id": "...", "completed_status": "..."}` without an `error` field. The dispatch handler checked `body.error` but it was always undefined.
**Fix applied:** Engineer workflow now extracts `subtype` from claude execution output JSON and passes it as `error` in the callback payload.
**Prevention:** When adding callback-driven features, always verify the entire chain from producer to consumer — check that all fields are actually populated.
**Affects:** hive

### 2026-03-25 PR manual_review dead zone — PRs stuck forever
**What happened:** PRs with risk score 4-6 got `manual_review` decision but no code handled them — they sat open indefinitely.
**Root cause:** The decision logic had three tiers (auto_merge ≤3, manual_review 4-6, escalate 7+) but only auto_merge and escalate had handlers.
**Fix applied:** Replaced with cost-only escalation model (ADR-027). All PRs auto-merge if CI passes. Only cost-impacting changes escalate.
**Prevention:** Never add a decision branch without implementing its handler. Dead code paths in event-driven systems are silent failures.
**Affects:** hive
