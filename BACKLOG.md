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

---

## Up Next

### 🔴 P0 — Email domain for Resend (outreach fully blocked)
Outreach emails are skipped because `sending_domain` is not set. ALL outreach cycles produce 0 emails. Need a real domain (e.g. `hivehq.io`) to add DNS records for Resend verification. Steps: buy domain → add to Vercel DNS → add Resend DKIM/SPF/MX records → verify → set `sending_domain` in Hive settings. ~10 min manual task once domain is chosen.


---

## Planned

### 🟢 P2 — Venture Brain activation
Requires 2+ active companies with data. Portfolio analysis, resource allocation, cross-company pattern matching. Should create directives like "VerdeDesk solved Portuguese tax compliance, apply pattern to Senhorio." Currently a stub.

### 🟢 P2 — Performance-driven model routing
Track per-agent success rates by model. If Gemini Flash has >90% success on Growth tasks, keep it. If Groq starts failing Ops checks, auto-escalate to Claude. The routing table should be dynamic, not static.

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
