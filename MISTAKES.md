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
