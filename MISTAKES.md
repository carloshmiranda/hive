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

### 2026-03-21 Shell injection from ${{ }} in workflow run scripts
**What happened:** Engineer build job crashed with `syntax error near unexpected token '('` when the task description contained parentheses. The dispatch step for Vercel Analytics task never ran.
**Root cause:** `PAYLOAD='${{ needs.context.outputs.payload }}'` injects the JSON directly into the shell script. If the payload contains shell metacharacters (`(`, `)`, `$`, backticks, etc.), bash interprets them as syntax. This is the same class of bug as the 422 JSON escaping issue — user-provided strings must never be injected raw into shell scripts.
**Fix applied:** Changed from inline `PAYLOAD='${{ }}'` to `env: PAYLOAD_JSON: ${{ }}`. GitHub Actions env vars are safely passed without shell interpretation.
**Prevention:** NEVER use `${{ }}` inside shell `run:` blocks for values that may contain special characters. Always pass them via `env:` block, which is safe. This applies to ALL workflow inputs, payloads, and user-provided strings.
**Affects:** hive (engineer build dispatch, any workflow using ${{ }} in run blocks)
