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

### 2026-03-18 orchestrator.ts uses require() but runs as ESM
**What happened:** Digest email failed with "require is not defined". Also affected child_process and crypto imports.
**Root cause:** Node detected ESM (import statements at top), but three places still used `require()` inline: child_process spawn, crypto, and the resend module.
**Fix applied:** Added `spawn` and `createDecipheriv` to top-level imports. Replaced resend `require()` with direct `fetch()` to Resend API (can't import Next.js modules from orchestrator anyway).
**Prevention:** Never use `require()` in orchestrator.ts. All imports must be ESM `import` at the top. For Next.js modules that can't be imported (path aliases like `@/lib/*`), reimplement the logic inline.
**Affects:** hive

### 2026-03-18 Settings decryption format mismatch in orchestrator
**What happened:** `getSettingValueDirect()` tried to parse encrypted values as a single hex blob. Failed silently (returned null).
**Root cause:** `crypto.ts` stores encrypted values as `iv_hex:tag_hex:encrypted_hex` (colon-separated), but the orchestrator tried `Buffer.from(value, "hex")` on the whole string.
**Fix applied:** Split on `:` first, then parse each part separately.
**Prevention:** When reimplementing crypto logic outside the Next.js app, always verify the format matches `src/lib/crypto.ts`. Add a comment referencing the canonical implementation.
**Affects:** hive

### 2026-03-18 rsync from update archive overwrites deployment fixes
**What happened:** P1 update archive was built before auth/middleware fixes were applied. `rsync` overwrote `auth.ts` and `middleware.ts` with broken versions, causing all settings to appear erased (401 from API).
**Root cause:** The archive was a snapshot from before deployment. rsync blindly synced all source files including ones that had been fixed post-deploy.
**Fix applied:** Re-applied the JWT `githubId` callback and middleware auth enforcement.
**Prevention:** After rsync from an update archive, always diff `auth.ts` and `middleware.ts` against the last known-good commit. Better: build update archives from the deployed repo (post-fix), not from a pre-deploy snapshot. Consider using `git format-patch` instead of tar archives for updates.
**Affects:** hive

### 2026-03-18 Settings table column name mismatch
**What happened:** Orchestrator queried `is_encrypted` column, but the actual column is `is_secret`.
**Root cause:** Column was renamed during development but the orchestrator's direct SQL query wasn't updated.
**Fix applied:** Changed to `is_secret` in orchestrator.ts.
**Prevention:** The settings table schema is in `src/app/api/settings/route.ts` (CREATE TABLE IF NOT EXISTS). Any direct SQL against settings must match that schema, not assume column names.
**Affects:** hive
