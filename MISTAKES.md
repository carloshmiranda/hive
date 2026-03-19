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

### 2026-03-19 claude CLI has no --cwd flag
**What happened:** Engineer agent failed all 3 attempts with `error: unknown option '--cwd'`. Every company cycle lost the Engineer entirely.
**Root cause:** The `dispatchClaude()` function passed `--cwd` as a CLI argument, but `claude` CLI has no such flag. The correct way to set working directory is via `spawn()`'s `cwd` option in the spawn options object.
**Fix applied:** Removed `--cwd` from args. Set `cwd` in `spawn()` options: `spawn("claude", args, { cwd: opts.cwd, ... })`.
**Prevention:** Always verify CLI flags with `claude --help` before using them. The Claude CLI uses `--add-dir` for additional directories, but working directory is set via the process, not a flag.
**Affects:** orchestrator, all agents with cwd (Engineer, Provisioner, Onboarding, Healer)

### 2026-03-19 Research Analyst Cycle 0 only triggered on cycleNumber === 1
**What happened:** VerdeDesk had 0 research reports but was on Cycle 4. Research Analyst never ran because the condition required `cycleNumber === 1 && researchReports.length === 0`.
**Root cause:** Dry runs and failed cycles incremented the cycle number, but no research was ever produced. The condition was too strict.
**Fix applied:** Changed to `researchReports.length === 0` — triggers full research whenever there are no reports, regardless of cycle number.
**Prevention:** Trigger conditions for "first time" actions should check for the absence of the output (no reports), not the sequence number (cycle 1).
**Affects:** orchestrator, research_analyst

### 2026-03-19 Vercel CLI and GitHub webhook deploys fail for non-Next.js projects (from VerdeDesk import)
**What happened:** VerdeDesk (React + Vite) could not be deployed via `vercel --prod` CLI or GitHub webhook → production. Both produced instant ERROR (0ms, no build logs). Only the Vercel REST API with `gitSource` produced READY production deploys.
**Root cause:** Projects with `rootDirectory` set (VerdeDesk uses `MVP/`) and non-Next.js frameworks (Vite) have deploy quirks that the CLI and webhook pathways don't handle reliably. GitHub webhooks worked for preview but not production.
**Fix applied:** VerdeDesk uses direct REST API calls: `POST /v13/deployments` with `gitSource.type: "github"`, `gitSource.repoId`, `gitSource.ref: "main"`, `target: "production"`.
**Prevention:** When the Engineer agent deploys non-Next.js companies or companies with `rootDirectory` set, use the Vercel REST API (`/v13/deployments` with `gitSource`) instead of CLI. Always verify deploy readyState after triggering — don't assume success. The `vercel.ts` lib should have a `deployViaApi()` path alongside the existing flow.
**Affects:** companies (especially non-Next.js stacks)

### 2026-03-19 Deploy-and-forget — agents must verify deploy status (from VerdeDesk import)
**What happened:** The VerdeDesk autonomous agent shipped code and moved on without checking if Vercel deploys actually succeeded. Multiple deploys were ERROR status but the agent kept iterating on features that weren't live.
**Root cause:** No post-deploy verification step. The agent treated "push to GitHub" as equivalent to "deployed successfully."
**Fix applied:** VerdeDesk added explicit deploy status checks after each push.
**Prevention:** Every Engineer agent cycle that pushes code MUST verify the deploy landed. After `git push`, check Vercel deployment status via API (`GET /v6/deployments?projectId=X&limit=1`) and confirm `readyState === "READY"`. If ERROR, the agent should read build logs and fix before moving on. This should be in the Engineer prompt as a mandatory post-deploy step.
**Affects:** both
