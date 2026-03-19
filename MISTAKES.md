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

