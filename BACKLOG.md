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

<!-- All P1 items completed — next priority is P2 -->

---

## Planned

### 🟢 P2 — Prompt Evolver shadow testing
Schema supports versioned prompts but the shadow testing pipeline isn't built. Need: generate variant prompts, run them against the same inputs as production, compare outputs, and propose upgrades through approval gates.

### 🟢 P2 — Social media posting integration
Start with X API (free tier, 1,500 posts/mo) + LinkedIn API. Growth agent generates content, Late.dev or direct API handles posting. Social accounts are manual creation — add approval gate when a company validates.

### 🟢 P2 — Resend email lib wrapper
`src/lib/resend.ts` exists with `sendEmail()` and `renderDigestHtml()` for use within the Next.js app (API routes). The orchestrator uses its own inline implementation. Need: transactional email helpers (welcome, receipt) for company boilerplates to use.

---

## Future Vision

### ⚪ P3 — Cloud migration
Move the intelligence layer from Mac to cloud. Swap `dispatch()` from `claude -p` to Claude Agent SDK `query()`. Run on GitHub Actions or a VPS. The abstraction layer is already designed for this.

### ⚪ P3 — Portfolio-level charts and analytics
Time-series visualization of MRR, traffic, and customer growth across all companies. Recharts or similar. Useful at 5+ companies, overkill at 2.

### ⚪ P3 — Telegram/WhatsApp bot for approvals
Approve/reject gates from your phone without opening the dashboard. Telegram Bot API is free and simple.

### ⚪ P3 — Multi-framework boilerplate support
Current boilerplate is Next.js only. Some companies might be better served by Astro (content/SEO), SvelteKit (lightweight SaaS), or plain static sites (landing pages). Boilerplate selection should be a CEO agent decision based on the company's needs.

### ⚪ P3 — Autonomous Hive self-improvement
The orchestrator should be able to propose and implement improvements to its own codebase. Read BACKLOG.md, pick a P2 item, implement it in a branch, run tests, create a PR, and submit for your approval. This is the ultimate dogfooding.

---

## Done
<!-- Move completed items here with date -->

### ✅ 2026-03-18 — Auth on dashboard
NextAuth v5 + GitHub OAuth + single-user lockdown. Every API route and page protected.

### ✅ 2026-03-18 — Settings page with encrypted storage
AES-256-GCM encryption for API keys. Masked display. Grouped by category.

### ✅ 2026-03-18 — All API routes
15 route files: companies, cycles, actions, approvals (with side effects), metrics, playbook, settings, portfolio, directives, imports, webhooks (Stripe + GitHub), cron.

### ✅ 2026-03-18 — Dashboard wired to Neon
Portfolio overview, agent activity feed with filtering, approval gates with approve/reject, playbook, command bar, import dialog.

### ✅ 2026-03-18 — Company boilerplate template
Next.js starter with Stripe checkout, webhook handler, customer schema, CLAUDE.md template.

### ✅ 2026-03-18 — Two-tier event architecture
Vercel webhooks (Stripe, GitHub, cron) for real-time. Nightly loop for strategic decisions.

### ✅ 2026-03-18 — Directive system
Dashboard command bar → GitHub Issues → orchestrator reads at cycle start → CEO incorporates → auto-closes.

### ✅ 2026-03-18 — Project import with pattern extraction
Scan GitHub repos, detect tech stack, generate CLAUDE.md, extract learnings to playbook.

### ✅ 2026-03-18 — Idea Scout agent
Generates business ideas weekly or when portfolio has capacity. Uses web search autonomously to research market pain points (Phase 1: discovery → Phase 2: competition analysis → Phase 3: demand validation → Phase 4: scoring). At least 1 of 3 niches must target a Portuguese market challenge. Proposes one idea with TAM, competition, MVP scope, confidence score, and full research trail. Creates approval gate. CLI flags: `--scout` (force), `--scout-only` (ideas without company cycles). 25 max turns, 15 min timeout.

### ✅ 2026-03-18 — Production agent prompt files
4 prompt files in `/prompts/`: ceo.md, engineer.md, growth.md, ops.md. Each has full role context, decision frameworks, output JSON schemas, rules, and playbook integration. Template variables `{{COMPANY_NAME}}` and `{{COMPANY_SLUG}}` auto-replaced. Loader falls back to inline prompts if files missing. DB-stored prompts (from Prompt Evolver) take priority over files.

### ✅ 2026-03-18 — Digest email template + Resend lib
`src/lib/resend.ts` with `sendEmail()` and `renderDigestHtml()`. Dark HTML email template with portfolio MRR/customers/company count, per-company cycle results with scores, pending approvals list, Idea Scout proposals, error summary, and dashboard link. Orchestrator sends digest directly via Resend API (no longer dispatches to Claude for this).

### ✅ 2026-03-18 — Error handling in dispatch()
Replaced `execSync` with `spawn`-based async dispatch. Proper timeout with SIGTERM → 5s grace → SIGKILL. Configurable `timeoutMs` per call (default 5min, Idea Scout gets 15min). Company loop wrapped in try/catch — one failed company logs to DB and continues to next instead of crashing the whole run.

### ✅ 2026-03-18 — Vercel Pro auto-upgrade trigger
Approval side effects for `first_revenue` gate → auto-creates `vercel_pro_upgrade` approval. On upgrade approval → logs manual action with direct Vercel dashboard URL. Vercel has no plan upgrade API, so the flow is: Stripe webhook detects first payment → approval gate → Carlos approves → action logged with upgrade instructions.

### ✅ 2026-03-18 — Dashboard real-time refresh
30-second auto-polling via `setInterval`. Last refresh timestamp shown in header (clickable for manual refresh). All data sources (portfolio, companies, actions, approvals, playbook) refresh together.

### ✅ 2026-03-18 — Health check endpoint
`/api/health` verifies: Neon connection, all required settings configured, schema tables present. Returns overall status (healthy/degraded/unhealthy) with per-check detail. Auth-guarded.

### ✅ 2026-03-18 — Bug fix: orchestrator can't import Next.js modules
`require("./src/lib/resend")` broke because of `@/lib/*` path aliases. Digest email logic inlined in orchestrator.ts with direct Neon + fetch. Rule: orchestrator shares DATA via Neon, never CODE via imports.

### ✅ 2026-03-18 — Bug fix: dispatch() rewritten with spawn
Replaced `execSync` with proper `spawn` import. Removed dead `require("child_process")` inside function body.

### ✅ 2026-03-18 — Playbook learning loop
CEO review step now parses playbook_entry from output JSON and writes to the playbook table with source_company_id and evidence. Also extracts cycle score into ceo_review JSONB. Kill flag auto-creates kill_company approval gate. Non-critical: if parsing fails, cycle continues.

### ✅ 2026-03-18 — Company detail page
`/company/[slug]` — full deep-dive per company with: directive input, pending approvals with approve/reject, latest metrics grid, expandable cycle history with CEO plan/review and score, agent activity feed. 30s auto-refresh. Dashboard company names and activity feed slugs link to detail pages.
