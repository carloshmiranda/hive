# Backlog

> Prioritized improvements for Hive itself. The orchestrator's CEO agent reviews this weekly and can self-assign items during low-activity cycles. Carlos can add items via the dashboard command bar with `hive: <description>` or by editing this file directly.

## Priority Legend
- 🔴 **P0** — Blocking or degrading core functionality
- 🟡 **P1** — Important for next phase, not blocking today
- 🟢 **P2** — Nice to have, improves quality of life
- ⚪ **P3** — Future vision, no urgency

---

## In Progress
<!-- Move items here when an agent starts working on them -->

<!-- Self-healing layers 2-3 moved to Done -->

---

## Up Next

### 🔴 P0 — Email domain for Resend (outreach fully blocked)
Outreach emails are skipped because `sending_domain` is not set. ALL outreach cycles produce 0 emails. Need a real domain (e.g. `hivehq.io`) to add DNS records for Resend verification. Steps: buy domain → add to Vercel DNS → add Resend DKIM/SPF/MX records → verify → set `sending_domain` in Hive settings. ~10 min manual task once domain is chosen.


---

## Planned

### ✅ P1 — CEO PR review: add UI/UX quality gate (DONE — 2026-03-23)
Added STEP 4b (design quality scan) to hive-ceo.yml PR review. Checks: no gradients, no raw hex, no duplicate sections, max 2 font weights, no placeholder content, landing page CTA rules. Design violations add +2 risk. Removed -2 discount for UI-only PRs — UI changes now get proper scrutiny.

### ✅ P1 — CEO cycle review: include design quality in scoring (DONE — 2026-03-23)
Added `design_review` field to CEO review output with `ui_changed`, `violations`, `score_deduction`, `notes`. Score deductions: gradient -1, >3 colors -1, duplicate sections -2, placeholder content -2, raw hex -1, decorative clutter -1. CEO now reviews UI changes every cycle.

### ✅ P1 — Growth agent: design-aware content rules (DONE — 2026-03-23)
Added "Visual quality rules for content pages" section to growth.md: reference design tokens, one CTA per viewport, no decoration requests, content density rules, no duplicate sections, mobile first.

### ✅ P1 — Boilerplate design token system (DONE — 2026-03-23)
Added Tailwind v4 @theme block to globals.css with constrained tokens: brand/accent colors, neutrals, feedback colors, typography scale (5 sizes), 8px spacing grid, 3 radius options, 2 shadow options. Added 10 design rules as CSS comments (no gradients, max 2 font weights, max 3 colors, etc.). Engineer prompt updated with 10 visual quality standards. Company CLAUDE.md template updated to reference tokens.

### 🟢 P2 — Performance-driven model routing
Track per-agent success rates by model. If Gemini Flash has >90% success on Growth tasks, keep it. If Groq starts failing Ops checks, auto-escalate to Claude. The routing table should be dynamic, not static. Inspired by Ruflo's Q-Learning router that tracks outcomes and improves routing over time.

### 🟢 P2 — Post-deploy visual smoke test
No verification that deployed pages render correctly. Engineer deploys and hopes. Need: (1) Lighthouse CI score check (performance, accessibility, SEO, best practices), (2) minimum score thresholds (performance 70+, accessibility 90+, SEO 90+), (3) run as Sentinel check on company URLs, (4) flag regressions as directives. Could use Lighthouse CI npm package in a shell step — no browser needed for basic checks.

### 🟢 P2 — Cross-company design system
Every company redefines colors, spacing, and button styles from scratch. Need: (1) shared design principles doc in boilerplate (not a component library — just rules), (2) Provisioner generates domain-aware color palette from business type + target audience, (3) Company CLAUDE.md includes generated palette as constraints, (4) Playbook entries for design patterns that work (e.g., "dark hero with light cards converts 2x better for SaaS").

---

## Ruflo-Inspired Improvements

> Ideas sourced from [ruvnet/ruflo](https://github.com/ruvnet/ruflo) — a multi-agent orchestration framework. Ruflo is a local CLI tool (architecture mismatch with Hive's cloud model), but many concepts are valuable to implement natively.

### ✅ P1 — Dispatch dedup / claims system (DONE — 2026-03-23)
Two-layer dedup in Sentinel dispatch functions: (1) cross-run — queries GitHub Actions API for in_progress/queued runs, parses run names to build active claims Set; (2) within-run — tracks dispatched keys to prevent same Sentinel check from dispatching duplicates. All three dispatch functions (`dispatchToActions`, `dispatchToWorker`, `dispatchToCompanyWorkflow`) check both layers before sending. Response includes `dedup_skips` and `active_claims` counts.

### ✅ P1 — Anti-drift mid-cycle validation (DONE — 2026-03-23)
Three layers: (1) Growth context now includes `validation` with `gating_rules` and `forbidden` (was missing). (2) New `/api/agents/validate-drift` endpoint checks work summary against phase-specific forbidden patterns, logs violations as `drift_detection` agent_actions. (3) Company `hive-build.yml` calls validate-drift before dispatching CEO review, flags drift in the dispatch payload so CEO can factor it into review scoring.

### ✅ P2 — Playbook confidence decay + learning loop (DONE — 2026-03-23)
Three mechanisms: (1) Time-based decay: Sentinel check 27 applies -0.02 confidence to entries unreferenced for 30+ days. (2) Auto-prune: entries below 0.15 confidence get superseded by higher-confidence same-domain entries (or zeroed out). (3) Cycle-score boost/decay was already in consolidate endpoint. Combined: playbook entries now have a full lifecycle — created → referenced → boosted/decayed → pruned.

### ✅ P2 — CLAUDE.md mechanical enforcement / policy gates (DONE — 2026-03-23)
Three-layer enforcement: (1) Task creation gate: `POST /api/tasks` validates tasks against company's validation phase, rejects forbidden work with violation details. (2) Context delivery gate: `GET /api/agents/context` filters out tasks that violate phase rules before Engineer/Growth sees them. (3) Shared `src/lib/phase-gate.ts` library with `checkForbidden()`, `extractPatterns()`, `validateTaskAgainstPhase()` — used by task creation, context delivery, and validate-drift (refactored from inline). Term map expanded with more patterns (oauth, jwt, adsense, ppc, dark mode, etc.).

### 🟢 P2 — Pre-trained pattern packs for new companies
Currently new companies inherit raw playbook entries (confidence ≥ 0.6). Structure domain knowledge into curated pattern packs (e.g., "SaaS pricing patterns", "SEO content patterns", "Portuguese market patterns") with richer metadata. New companies get relevant packs based on business type. Inspired by Ruflo's pre-built pattern packs (security-essentials, testing-patterns, etc.) with measurable accuracy scores.

### ✅ P2 — Context optimization for long-running agents (DONE — 2026-03-23)
Three optimizations: (1) Research reports now deliver summaries only in context API (saves 20-50KB per call), full content stays in DB. (2) Worker agent dispatch truncates visibility/content_performance JSONB to 2KB max via `truncateJson()`. (3) Growth context no longer includes full report content. Combined: ~60-70% reduction in context payload size, more turns available for actual work.

### ⚪ P3 — Browser automation for Growth verification
Growth agent deploys content but never verifies it rendered correctly. Browser automation could validate: landing pages render properly, SEO meta tags are present, CTAs are clickable, OG images load. Currently "deploy and hope." Inspired by Ruflo's `@claude-flow/browser` with 59 MCP tools for browser interaction, screenshots, and trajectory learning.

### ⚪ P3 — WASM-based mechanical code transforms
Skip LLM entirely for trivial code changes (add missing imports, fix lint errors, update config values, rename variables). Saves Claude quota on Engineer tasks that don't need reasoning. Currently all code changes go through full Claude sessions. Inspired by Ruflo's Agent Booster claiming 352x speedup on mechanical transforms.

### ⚪ P3 — Knowledge graph with PageRank for context injection
Replace flat playbook queries with a knowledge graph where entries link to companies, agents, domains, and outcomes. PageRank determines which knowledge gets injected into agent context (most connected = most valuable). Currently playbook injection is a simple confidence threshold query. Inspired by Ruflo's intelligence loop where SessionStart builds a knowledge graph with PageRank-ranked context injection.

### ⚪ P3 — Cross-session pattern learning (ReasoningBank)
Cache reasoning patterns so agents don't re-derive the same logic across cycles. If CEO solved "how to evaluate a Portuguese SaaS" in cycle 5, the reasoning should be retrievable in cycle 15 without burning turns. Hive's playbook captures outcomes but not reasoning chains. Inspired by Ruflo's ReasoningBank that stores and retrieves reasoning patterns with similarity matching.

### ⚪ P3 — Plugin/extension system for agent capabilities
Allow new agent capabilities to be added without modifying core workflows. Plugins could add: new data sources (analytics providers), new output channels (social platforms), new business models (newsletter, affiliate). Currently every new capability requires workflow + API route changes. Inspired by Ruflo's plugin system with 19 official plugins and IPFS-based marketplace.

### ⚪ P3 — Multi-agent consensus for kill decisions
Instead of CEO alone recommending kills, implement a lightweight voting mechanism where multiple signals contribute: CEO score trend, Venture Brain analysis, revenue trajectory, error rate, traffic trend. Weighted consensus replaces single-agent judgment. Inspired by Ruflo's Raft/Byzantine consensus algorithms for multi-agent decisions.

### ✅ P1 — Post-cycle consolidation step (DONE — 2026-03-23)
New `/api/agents/consolidate` endpoint auto-called after CEO review via chain dispatch in `hive-ceo.yml`. Three functions: (1) extracts `playbook_entry` from CEO review JSON and writes to playbook table with dedup, (2) extracts wins from high-scoring cycles (7+) as additional playbook entries, (3) boosts confidence (+0.03/0.05) on playbook entries used in high-scoring cycles (8+), decays confidence (-0.05/0.08) for low-scoring cycles (≤3). Logs consolidation results as `cycle_consolidation` agent_action.

### ✅ P1 — Task stealability on agent failure (DONE — 2026-03-23)
New Sentinel check 13b2: finds `agent_actions` stuck in `'running'` status for >1 hour and marks them `'failed'` with descriptive error. This makes them "stealable" — the existing retry logic in check 13c picks them up on the next Sentinel run. Response includes `stale_reclaimed` count. Covers all agent types (engineer, growth, ceo, scout, healer, evolver).

### ✅ P2 — Cost-based provider routing strategy (DONE — 2026-03-23)
Dynamic routing in worker dispatch: `getOptimalModel()` queries 7-day success rates by provider from agent_actions output JSONB. If primary provider drops below 70% success rate, auto-failover to alternative free-tier provider. Agent_actions now logs `provider`, `model`, `cost_usd`, `routing_reason`, `duration_s` in output. Costs endpoint enhanced with `by_provider` breakdown (calls, successes, failures, cost). Failure logging also includes provider data for routing decisions.

### ✅ P2 — Memory/playbook consolidation worker (DONE — 2026-03-23)
Sentinel check 29: Jaccard word similarity (≥0.6) merges near-duplicate playbook entries within same domain. Higher-confidence entry wins, absorbs loser's counts, loser gets superseded_by. Cross-company composites created (≥0.5 similarity, different companies) as portfolio-level entries (source_company_id=NULL). Max 10 merges + 3 composites per run.

### 🟢 P2 — Test coverage tracking for company repos
No visibility into whether company code has tests or what coverage looks like. Engineer builds code but nobody tracks if tests exist or pass. Implement: (1) track test presence in company repos (has tests? coverage %?), (2) flag companies with zero tests after 5+ cycles, (3) add test writing to Engineer's task list when coverage drops. Inspired by Ruflo's `testgaps` background worker that detects code changes without corresponding tests.

### 🟢 P2 — Automated security scanning on deploys
Secret scanning happens at provisioning but not on ongoing deploys. Implement a post-deploy security check: scan recent commits for secrets, check for new dependencies with known CVEs, validate that auth middleware is present on protected routes. Runs as part of Ops verification or as a Sentinel check. Inspired by Ruflo's `audit` background worker that triggers on security-related file changes.

### 🟢 P2 — CRDT-style concurrent write resolution
Hive agents sometimes run in parallel and write conflicting metrics or playbook entries. Currently last-write-wins (SQL UPSERT). Implement convergent data structures for metrics (counters that merge additively) and playbook (entries that merge by highest confidence). Prevents data loss from race conditions without coordination overhead. Inspired by Ruflo's CRDT consensus strategy (~10ms, strong eventual consistency).

### ⚪ P3 — Agent specialization profiles (learned over time)
Track which agents perform best on which types of tasks across all companies. Build agent profiles: "Engineer excels at React UI but struggles with database migrations", "Growth produces better content for Portuguese market than global." Use profiles to inform CEO's task assignment. Inspired by Ruflo's 60+ specialized agent types and SONA's agent-performance tracking.

### ⚪ P3 — Performance profiling for company sites
No automated performance analysis for deployed company sites. Implement: Lighthouse scores on deploy, Core Web Vitals tracking, bundle size monitoring. Flag regressions. Engineer tasks should include performance budgets. Inspired by Ruflo's `optimize` and `benchmark` background workers that trigger on performance-critical changes.

### ⚪ P3 — Event-sourced audit trail for agent decisions
Agent actions are logged but not in an event-sourced format that allows replay. Full event sourcing would enable: "why did CEO score this company 3/10?", "what context led to this Engineer decision?", "replay this cycle with different prompts." Currently agent_actions captures outcomes but not the decision chain. Inspired by Ruflo's event sourcing with replay capability.

### ⚪ P3 — Codebase structure mapping for company repos
No automated understanding of company repo architecture. Engineer works from CLAUDE.md but doesn't have a live structural map. Implement: auto-generated architecture map (routes, components, API endpoints, data models) updated on each build. Feed to CEO for better planning. Inspired by Ruflo's `map` background worker that triggers on large directory changes.

---

## Future Vision

### ⚪ P3 — Claude Agent SDK migration
Replace GitHub Actions with Agent SDK for unlimited turns, streaming, and parallel company processing. Current limit: 40 turns per agent per run. Agent SDK: unlimited. Major architecture change but eliminates the biggest scaling constraint.

### ⚪ P3 — Portfolio-level charts and analytics
Time-series visualization of MRR, traffic, customer growth across all companies. Recharts or similar. Company comparison charts. Useful at 5+ companies.

### ⚪ P3 — Telegram/WhatsApp bot for approvals
Approve/reject gates from phone. Telegram Bot API is free. Push notification when new gate created. Reply "approve" or "reject [reason]".

### ⚪ P3 — Multi-framework boilerplate support
Not every business needs Next.js. Astro for content/SEO sites, SvelteKit for lightweight SaaS, static sites for landing pages, Express for API-only businesses. CEO agent picks framework based on business model.

### ⚪ P3 — Autonomous self-improvement
Orchestrator reads BACKLOG.md, picks a P2 item, implements it in a branch, runs tests, creates PR, submits for approval. The ultimate dogfooding: Hive improves Hive.

### ⚪ P3 — Business model diversity beyond SaaS
Content/affiliate sites (ad revenue), faceless YouTube channels (ad revenue), newsletter businesses (sponsorship), API/tool businesses (usage-based). Each needs different boilerplate, metrics, and growth strategies.

### ⚪ P3 — Capability diff alerting
When assessment shows regression (feature removed accidentally), auto-escalate. Catches deploy-time schema drops or webhook route deletions.

### ⚪ P3 — Customer support automation
Companies should handle support autonomously: FAQ bot from product spec, email auto-replies, issue triage. Growth agent manages knowledge base.

### ⚪ P3 — LTV/CAC tracking per company
Cohort analysis for lifetime value. CAC tracking (if/when paid acquisition starts). Unit economics dashboard. Kill decisions based on LTV/CAC ratio.

---

## Done
<!-- Move completed items here with date -->

### ✅ 2026-03-23 — Venture Brain activation (P2)
Sentinel check 28: (a) Cross-pollination — finds high-confidence playbook entries from company A that company B hasn't seen, creates directive. (b) Score decline detection — flags companies with declining CEO scores, references rising peers. (c) Error correlation — if company A fixed an error that company B still has, creates directive. Max 3 directives per run, 7-day cooldown per company.

### ✅ 2026-03-23 — Playbook consolidation worker (P2)
Sentinel check 29: Jaccard word similarity (≥0.6) merges near-duplicate playbook entries within same domain. Higher-confidence entry wins, absorbs loser's counts. Cross-company composites created (≥0.5 similarity, different companies) as portfolio-level entries. Max 10 merges + 3 composites per run.

### ✅ 2026-03-23 — Company teardown automation (P1)
Dedicated teardown job in hive-engineer.yml. When kill_company approval is approved, ops_escalation dispatches teardown: deletes Vercel project, Neon DB, archives GitHub repo, marks infra as torn_down. Pure shell steps — no LLM, $0 cost.

### ✅ 2026-03-22 — Move crons from Vercel to GitHub Actions (P1)
All 3 Vercel crons (sentinel, metrics, digest) replaced by single `hive-crons.yml` GitHub Actions workflow with 3 schedule triggers. Zero Vercel crons needed — works on Hobby plan. Supports `workflow_dispatch` for manual triggering.

### ✅ 2026-03-22 — SQL linter + CI + Healer schema_mismatch handling (P1)
Build-time SQL linter (`scripts/lint-sql.ts`) validates all `sql` tagged template queries against `schema-map.ts`. CI workflow (`.github/workflows/ci.yml`) runs linter + build on PRs. Healer prompt updated with `schema_mismatch` error class. Caught and fixed 4 real bugs on first run: `cycles.created_at`, `evolver_proposals.affected_agents`, `agent_actions.metadata` (2x).

### ✅ 2026-03-22 — Schema drift detection in Sentinel (P1)
`src/lib/schema-map.ts` — static schema map with all 18 tables, columns, types, CHECK constraints. Sentinel check 24 compares expected schema against live DB via `information_schema`, logs mismatches as agent_actions, dispatches Healer when 3+ issues found. `scripts/generate-schema-map.ts` for regeneration.

### ✅ 2026-03-22 — Sentinel 3 schema mismatches fixed (P0)
Sentinel was silently 500-ing due to: `metrics.metric` (doesn't exist, should be `metrics.mrr`), `agent_actions.metadata` (should be `tokens_used`), `approvals.gate_type` CHECK missing values. All fixed + error boundary added.

### ✅ 2026-03-22 — Centralized business types (P1)
`src/lib/business-types.ts` as single source of truth for 8 business types. Auto-research endpoint for unknown types. Engineer Step 0 pre-provisioning hook. ADR-026.

### ✅ 2026-03-21 — Cost tracking per agent run (P2)
New `/api/agents/costs` endpoint with per-agent cost estimates (Opus $0.15/turn, Sonnet $0.03/turn, free-tier $0). Portfolio endpoint now includes `est_cost_24h` and `budget_utilization_pct` (turns in last 5h / 225 max). Dashboard can surface burn rate.

### ✅ 2026-03-21 — Dashboard batch approve/reject (P2)
New `/api/approvals/batch` endpoint for bulk reject (blocks batch approve on new_company gates needing provisioning). Dashboard Inbox tab has checkboxes, select-all, and "Reject Selected" button with reason prompt.

### ✅ 2026-03-21 — Company health score (P2)
New `src/lib/health-score.ts` with weighted composite: revenue trend 30%, traffic trend 20%, error rate 20%, cycle scores 20%, task completion 10%. Returns 0-100 score with A-F grade. Included in company detail API response.

### ✅ 2026-03-21 — Cycle score → agent performance correlation (P2)
New `/api/agents/performance` endpoint. Per-agent: avg grade from CEO reviews, task completion rate, error rate, avg turns. Generates insight strings like "Engineer has high error rate" or "Growth completed 0 tasks". Portfolio-level correlation of low cycle scores with agent grades.

### ✅ 2026-03-21 — Stack detection for imports (P2)
Import scanner now detects: Remix, Astro, Nuxt, SvelteKit, Vite (config files), Prisma, Drizzle, Supabase, PlanetScale (files + deps), Resend, SendGrid, Postmark, Mailgun (deps).

### ✅ 2026-03-21 — Scout proposal auto-expiry (P1)
All approval gate types now auto-expire: new_company/growth_strategy/spend_approval/outreach_batch at 7 days, prompt_upgrade/social_account/capability_migration at 14 days, escalations at 3 days. Orphaned 'idea' companies with no pending approval are auto-killed. Prevents approval debt.

### ✅ 2026-03-21 — Secret scanning before repos go public (P1)
Two-layer secret scanning: (1) Import scanner checks file names for .env/.pem/.key patterns and scans up to 20 source files for hardcoded API keys, Stripe keys, GitHub PATs, AWS keys, Slack tokens, and private keys. Results surfaced in scan report. (2) Engineer provisioning workflow runs grep-based scan before toggling repo visibility — keeps repo private if secrets found.

### ✅ 2026-03-21 — Refund and churn handling in Stripe webhook (P1)
Added charge.refunded handler (decrements revenue metrics, logs refund amount) and invoice.payment_failed handler (logs warning with attempt count). customer.subscription.deleted was already handled. CEO dispatch now triggers on churn/refund events too, not just payments.

### ✅ 2026-03-21 — Engineer MVP quality bar + stack detection (P2)
Engineer build workflow now includes: pre-flight stack detection (Tailwind v3/v4, framework, dependencies), MVP design quality bar (business-domain-specific colors/language, conversion-optimized landing page structure, consistent design tokens), SEO baseline (meta, OG, JSON-LD, sitemap, robots), accessibility baseline (semantic HTML, contrast, keyboard nav, ARIA), and performance rules (Server Components default, Image component, next/font). Company CLAUDE.md template updated with design/UX requirements.

### ✅ 2026-03-21 — PR review quality criteria for CEO agent (P1)
CEO agent now uses a 6-step structured review: hard gates (CI, secrets, destructive migrations, diff size), task alignment (maps to cycle plan, acceptance criteria met, no scope creep), code quality (error handling, SQL safety, auth checks), and risk scoring (0-3 auto-merge, 4-6 merge+log, 7+ escalate to Carlos). Based on CodeRabbit/Qodo/Copilot best practices research.

### ✅ 2026-03-21 — CEO PR merge + task progress dashboard (P1)
CEO agent now reviews and merges PRs on `ceo_review` dispatch (was a no-op). Task progress bars added to company cards on dashboard. Misleading Approve/Dismiss buttons replaced with Prioritize/Dismiss.

### ✅ 2026-03-21 — Stripe product creation on provision (P0)
Provisioner now auto-creates Stripe Product + Price during company setup via OIDC-authenticated `/api/agents/stripe/product` endpoint. Uses pricing from Scout proposal, defaults to €9.99/month. Stores IDs in infra table. Companies can now accept payments from day one.

### ✅ 2026-03-21 — Zero-secret company repos + OIDC gateway (P1)
Company repos no longer need ANY secrets (including DATABASE_URL). All auth via GitHub OIDC token exchange, all data via Hive API gateway (`/api/agents/context`, `/api/agents/log`, `/api/agents/tasks/:id`, `/api/agents/playbook`). Shared OIDC validation extracted to `src/lib/oidc.ts`. DATABASE_URL secrets removed from all 3 company repos. Workflows reduced by ~200 lines each.

### ✅ 2026-03-21 — OIDC token exchange for Hive repo workflows (P1)
Extended `/api/agents/token` to support Hive repo workflows (not just company repos). All 6 Hive workflows (CEO, Scout, Engineer, Evolver, Healer, Sentinel) now fetch tokens via OIDC instead of GitHub secrets. Hive repo made public — unlimited Actions minutes.

### ✅ 2026-03-21 — Dispatch chain verification (P1)
Triggered Engineer workflow for verdedesk waitlist merge — first real end-to-end test of the dispatch chain after the 422 fix. Tests OIDC token exchange → context API → agent execution → company repo.

### ✅ 2026-03-21 — Task tracking system (P1)
`company_tasks` table with category filtering (engineering/growth/research/qa/ops/strategy), status lifecycle (proposed → approved → in_progress → done), priority levels (P0-P3), acceptance criteria, and cycle linking. Task filtering moved to company detail pages. Tasks API with OIDC-authenticated endpoints for agent updates (`PATCH /api/agents/tasks/:id`). Playbook writes via `POST /api/agents/playbook`. Pushed to all 3 company repos.

### ✅ 2026-03-21 — Engineer dispatch 422 fix (P0)
Company repo hive-build.yml was never triggered because the payload JSON wasn't properly escaped in the workflow_dispatch request. `jq -c` output contained raw JSON objects where strings were expected. Fixed by using `jq -n` to build the entire request body with proper string escaping. All 6 prior Engineer dispatch attempts failed with "Invalid value for input 'payload'" (HTTP 422).

### ✅ 2026-03-21 — Company-side workflow expansion: Growth + Fix (P2)
Two new boilerplate workflows for company repos (free on public repos): `hive-growth.yml` and `hive-fix.yml`. Context loaded via OIDC-authenticated Hive API.

### ✅ 2026-03-21 — Automatic boilerplate migration for existing companies (P2)
Sentinel check 20 compares company capabilities against boilerplate manifest. Detects missing features, creates migration approval gates.

### ✅ 2026-03-21 — Content performance feedback loop (P2)
GSC data → trend analysis → refresh recommendations → Growth action → improved rankings.

### ✅ 2026-03-21 — Anomaly detection + event-driven cadences (P2)
Sentinel check 18: 2σ rolling avg anomaly detection. Evolver triggered by data conditions only.

### ✅ 2026-03-21 — Healer workflow + legacy cleanup (P1)
`hive-healer.yml` triggered by repository_dispatch. Classifies systemic vs company-specific errors.

### ✅ 2026-03-21 — Product specification system (P2)
CEO outputs accumulating product_spec. Engineer builds with product context.

### ✅ 2026-03-21 — Public company repos + build dispatch (ADR-021)
Company repos public for free Actions. Engineer dispatches to company repo workflows.

### ✅ 2026-03-20 — Self-improving feedback loops
Scout deduplication, rejection feedback, Evolver gap detection.

### ✅ 2026-03-18 — Full dashboard, API routes, auth, settings, boilerplate, agent prompts, error handling, directive system, import system, social media, email templates
See ROADMAP.md for full changelog.
