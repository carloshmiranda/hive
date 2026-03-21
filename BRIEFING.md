# Briefing

> **Read this first.** This is the current state of Hive, updated by all tools (Claude Chat, Claude Code, orchestrator). It answers: where are we, what just happened, what's next.
>
> **Update protocol:** Append to the "Recent context" section whenever you make a decision, finish a feature, or learn something important. Trim entries older than 2 weeks to the Archive section at the bottom.

## Current State

- **Phase:** Two companies actively iterating. System operational.
- **Architecture:** 7 agents, event-driven, 3 Vercel crons (metrics 2x/day, sentinel every 4h, digest daily 8am). Mac not required.
- **Production URL:** https://hive-phi.vercel.app
- **Active companies:** 3
  - VerdeDesk — status: mvp, 18+ cycles, last CEO score 5/10, building waitlist + IRS guide
  - Senhorio — status: mvp, 4 cycles, last CEO score 3/10, built tax calculator at /calculadora
  - Flolio — status: mvp, 4 cycles (imported, iterating autonomously)
- **Pipeline:** 9 idea-status companies (Scout proposals, pending approval)

### Agent Architecture (7 agents)

| Agent | Runtime | Trigger | Scope |
|-------|---------|---------|-------|
| CEO | GitHub Actions + Claude | Payments, cycle completions, gates, PRs, directives | Plan, review, score, kill |
| Scout | GitHub Actions + Claude | Pipeline low, CEO requests, company killed | Ideas, market research, SEO keywords |
| Engineer | GitHub Actions + Claude | Features, bugs, Ops escalation, new companies | Code, deploy, scaffold, fix |
| Evolver | GitHub Actions + Claude | Cycle threshold, failure rate | Prompt analysis + improvement |
| Ops | Vercel serverless + Groq | Deploys, sentinel, agent failures | Health check, metrics, error detect |
| Growth | Company repo Actions + Claude (fallback: Vercel + Gemini) | Scout research delivered, sentinel (stale content) | Blog, SEO, social content |
| Outreach | Vercel serverless + Gemini | Scout leads found, sentinel (stale leads) | Prospects, cold email, follow-up |

### Execution Model

- **Events**: Stripe payments, deploys, GitHub issues/PRs → trigger agents directly
- **Chains**: Agent A finishes → dispatches Agent B (brain agents via `repository_dispatch`, worker agents directly to Vercel `/api/agents/dispatch`)
- **Data conditions**: Sentinel runs as Vercel cron every 4h → dispatches agents whose work conditions are met
- **Worker dispatch**: Growth/Outreach/Ops called directly from chain dispatch steps (no GitHub Actions proxy)

- **Blocked on:**
  - Resend domain verification (need a real domain for outreach emails)
- **Known issues:**
  - 9 Scout proposals pending approval (auto-expiry planned)
- **Recently fixed:**
  - Full dispatch chain verified end-to-end: Hive Engineer → verdedesk hive-build → Claude agent merged waitlist branch
  - Per-job OIDC token fetch (GitHub Actions strips masked secrets from cross-job outputs)
  - OIDC API gateway: zero-secret company repos, all auth via OIDC token exchange
  - Stripe product auto-creation wired into provisioning flow
  - Task tracking + playbook writes via OIDC-authenticated API endpoints
  - Claude Code OAuth token refreshed in settings

## Recent Context

> Most recent first. Each entry has a source tag: `[chat]` = Claude Chat brainstorming, `[code]` = Claude Code session, `[orch]` = orchestrator, `[carlos]` = manual.

### 2026-03-21 [code] OIDC gateway + zero-secret repos + dispatch chain verified
**Architecture change:** Company repos no longer need ANY secrets (including DATABASE_URL). All auth via GitHub OIDC token exchange through `/api/agents/token`. All data access via Hive API gateway (`/api/agents/context`, `/api/agents/log`, `/api/agents/tasks/:id`, `/api/agents/playbook`). Shared OIDC validation extracted to `src/lib/oidc.ts`.
**Critical fix:** GitHub Actions strips masked secrets from cross-job outputs (`::add-mask::` + job output = empty in downstream jobs). Engineer workflow restructured: each job (provision, build, build-hive) now fetches its own tokens via OIDC instead of relying on context job outputs. Also replaced DB logging in build jobs with Hive API calls.
**Stripe wired up:** Provisioner now auto-creates Stripe Product + Price via OIDC-authenticated `/api/agents/stripe/product` endpoint.
**OAuth token refreshed:** Claude Code OAuth token in settings had expired. Refreshed from local keychain credentials.
**Dispatch chain verified:** First successful end-to-end dispatch: Hive Engineer → verdedesk hive-build → Claude agent → merged `feature/database-waitlist-storage` into main. All company workflows (build, growth, fix) now work.
**Tasks moved:** Tasks tab removed from main dashboard, category filtering added to company detail pages.
**Pushed to all 3 company repos:** Updated workflows (zero-secret + task tracking + playbook writes).

### 2026-03-21 [code] Task tracking + dispatch fix + roadmap overhaul
**Critical fix:** Engineer → company repo dispatch returned 422 on EVERY attempt. Payload JSON was injected raw instead of string-escaped. Fixed with `jq -n --arg`. This means no company repo workflow (hive-build, hive-growth) has ever successfully run. Should now work.
**Task tracking:** Full `company_tasks` lifecycle: tasks API with category/status/company filters, PATCH supports cycle_id, dashboard Tasks tab with category + company filters. Company workflows (build + growth) read tasks from backlog, mark in_progress/done, verify acceptance criteria. Pushed to all 3 repos.
**Roadmap overhaul:** Restructured for "free tier first, upgrade on revenue" philosophy. 4 phases: First Revenue → Portfolio at Scale → Intelligence → Platform. Added concrete milestones for dispatch chain verification, zero-intervention operation, business model diversity.
**Backlog refresh:** 15 items across P0-P3. Two P0 blockers: email domain (outreach blocked) and Stripe products (payments blocked). New P1s: dispatch chain e2e verification, PR auto-merge, refund/churn handling. New P2s: company health score, cycle score correlation, Venture Brain activation, performance-driven model routing.
**MISTAKES.md:** New entry for the 422 dispatch bug — JSON string escaping rule.

### 2026-03-21 [code] Dashboard approval details + failure fixes + secret cleanup
**Dashboard:** Company cards now show pending approval details (gate type + title) instead of just a count. Digest email includes per-company approvals in the portfolio table.
**Failures fixed:** CEO max-turns increased 25→40 (Opus needs more), execution_file fallback path added, NEON_API_KEY added to Engineer env, GH_TOKEN set as job-level env on provision job, 404 error message improved.
**Secrets:** Removed 2 exposed API keys from Flolio's agent-queue (Gemini + Resend), documented in MISTAKES.md. Keys rotated by Carlos.
**Learnings:** 2 new MISTAKES.md entries (CEO turn budget, Engineer 404 dispatch).

### 2026-03-21 [code] Iteration verification + naming standards + phantom run fix
**Companies confirmed iterating:** Senhorio (3 cycles, built tax calculator), VerdeDesk (18 cycles, waitlist + IRS guide shipped). 49 successes vs 16 failures in 24h.
**Phantom push runs fixed:** Literal `${{ }}` in Engineer prompt text caused GitHub to create failed runs on every push. Removed.
**Naming standards added to CLAUDE.md:** Branches (`hive/<agent>-<company>-<desc>`), commits (conventional), PRs, dispatch events, action types, DB conventions, workflow YAML rules.
**Secret architecture documented in MISTAKES.md:** Service keys in settings table only, infra secrets in GitHub Actions only. Prevents the "key exists in wrong environment" class of bugs.
**Context files updated:** BRIEFING.md, MISTAKES.md, CLAUDE.md all brought current.

### 2026-03-21 [code] Company-side workflows + backlog clear (8 items)
**Massive backlog clear session.** Completed 8 items across P0-P2:
1. **Product specification system** — CEO outputs accumulating product_spec, Engineer sees WHY they're building.
2. **Healer workflow + legacy cleanup** — Created hive-healer.yml, deleted deprecated sentinel/worker-agents workflows.
3. **Anomaly detection** — Sentinel check 18: 14-day rolling avg+stddev, >2σ → CEO alert.
4. **Event-driven cadences** — Removed Evolver Wednesday cron, all data-condition-driven now.
5. **Content performance feedback loop** — Per-URL trend analysis, refresh recommendations, Growth acts on them.
6. **Automatic boilerplate migration** — Sentinel detects missing features, creates `capability_migration` gates, dispatches to company repo.
7. **Company-side Growth workflow** — `hive-growth.yml` runs on company repos (free), creates content/SEO pages directly. CEO chain dispatch + Sentinel route Growth to company repo with Vercel serverless fallback.
8. **Company-side Fix workflow** — `hive-fix.yml` runs on company repos (free). Healer + Ops escalation dispatch fixes to company repo instead of Hive Engineer.
Architecture shift: Growth agent moves from Vercel serverless (Gemini, limited output) to company repo Actions (Claude Sonnet, can write files). Outreach stays on Vercel (doesn't need repo access). All dispatches have fallback chains.

### 2026-03-21 [code] GitHub Actions optimization + Vercel cron migration (ADR-020)
Implemented two-part optimization to reduce GitHub Actions usage by ~10-12 runs/day:
**Option 1 — Optimize Actions:** Reduced max-turns (Scout 50→35, Engineer provision 25→15, Engineer build 50→35). Worker-agents.yml deprecated — CEO and Scout chain dispatch now call Vercel `/api/agents/dispatch` directly for Growth/Outreach/Ops (eliminates proxy workflow run).
**Option 2 — Move to Vercel serverless:** Created `/api/cron/sentinel` (all 16 health checks ported to TypeScript, runs every 4h). Created `/api/cron/digest` (daily digest email, runs at 8am UTC). Both added to vercel.json crons. Legacy GitHub Actions workflows kept as manual-only fallback.
Sentinel on Vercel dispatches brain agents via GitHub API `repository_dispatch`, worker agents directly to `/api/agents/dispatch`. HTTP health checks run in parallel with Promise.all + 10s timeout.
Also hardened Engineer workflow: added guard against working in Hive repo when company has no `github_repo`. Enhanced provisioning to populate CLAUDE.md with full proposal data + playbook insights from DB.

### 2026-03-20 [code] Self-improving feedback loops — 5 autonomous improvements
Implemented 5 feedback loop enhancements: (1) Scout semantic deduplication — word-overlap similarity check against ALL existing companies (not just slug match), prevents proposals like Senhorio/RentaPT from both passing. (2) Rejection feedback loop — Scout now sees kill_reasons and rejection notes from last 90 days, learns from Carlos's past decisions. (3) Process gap detection in Evolver — checks Scout duplicate rate, stale approvals (>48h), stuck approved companies (>3d), cycle gaps (>7d), creates evolver_proposals directly. (4) Rich proposal cards in dashboard — Scout ideas render with market flag, color-coded confidence, Problem/Solution/Revenue/MVP/TAM fields, research stats. (5) Rejection-to-Evolver pipeline — Scout prompt evolution includes rejection pattern analysis so the prompt itself improves based on what Carlos keeps rejecting.

### 2026-03-20 [code] Cycle completion guard implemented
Fixed stuck cycles issue (cycles 13-14 running indefinitely). Added `checkAndHandleRunningCycles()` function in orchestrator.ts: before creating new cycle, checks if previous cycle is still running. If running >2h, marks as failed with timeout reason. If running <2h, skips company and continues to next. Modified company processing loop to use guard. Cycles stuck in running status can no longer block new cycle creation. All cycle timeouts logged to agent_actions table for visibility.

### 2026-03-20 [code] Evolver proposal approval flow completed
Closed 3 gaps in the Evolver approval flow: (1) `prompt_update` proposals now set `implemented_at` immediately since they take effect on approve. (2) `setup_action` proposals now create a `pending_manual` agent_action (surfaces in dashboard todos) and dispatch `ceo_review` to the CEO workflow so it gets incorporated into the next cycle plan. (3) `knowledge_gap` proposals now dispatch `ceo_review` so CEO extracts the knowledge into the playbook. Added stale approval detection: approved proposals not implemented after 48h surface as info-level todos. Added `dispatchEvent()` to the evolver API route.

### 2026-03-19 [code] Evolver gap detection system (ADR-017)
Rewrote Evolver from vague prompt-improver to structured Reflector-Curator. Three-layer gap detection: outcome gaps (agent success rates, cycle score trends), capability gaps (escalations, repeated failures, missing infrastructure), knowledge gaps (playbook coverage, unreferenced entries). New `evolver_proposals` table with gap_type, severity, diagnosis, proposed_fix, affected_companies. Proposals appear in dashboard Inbox with purple accent cards and approve/reject/defer buttons. Playbook reference tracking added (last_referenced_at, reference_count). Trigger conditions: weekly schedule + event-driven (error rate >30%, escalation clusters ≥3, stuck companies >14 days) with 24h debounce. Approved proposals injected into agent context. All agent prompts updated with playbook_references output. Migration 008.

### 2026-03-19 [code] Company capability inventory system (ADR-018)
Companies table now has `capabilities` JSONB column, `company_type`, `imported` flag, and `last_assessed_at`. Provisioner writes full inventory on scaffold. Assessment endpoint (`/api/companies/[id]/assess`) inspects DB schema, Vercel env vars, and repo files to build inventory automatically. All agent prompts updated with capability awareness — check before using optional infrastructure, report `missing_capabilities` or `capabilities_updated` in output. Compatibility matrix gates proposals (waitlist N/A for companies with customers, referral N/A for B2B). Ops refreshes stale inventories (>14 days). Dashboard company detail page shows capabilities grid with status dots (green=active, amber=exists but unconfigured, grey=missing, strikethrough=N/A). Re-assess button triggers fresh scan. Capability helper functions in `src/lib/capabilities.ts`. Migration 007.

### 2026-03-19 [code] Waitlist system + email lifecycle framework (ADR-016)
Built waitlist-first launch for all new companies: boilerplate schema (waitlist, email_sequences, email_log tables), waitlist API with referral mechanics (unique codes, position tracking, UTM attribution), Resend webhook handler for email tracking (open/click/bounce → counters). Landing page now supports 3 modes via LAUNCH_MODE env var: waitlist (email form with referral), early_access (checkout link), live (standard CTA). Growth prompt updated with full email lifecycle ownership — manages waitlist_welcome, onboarding drips, product updates, win-back sequences with A/B testing. CEO prompt updated with waitlist awareness in build mode (transition to early_access at 50+ signups). Provisioner seeds 4 default email sequences at company creation. Hive metrics extended with waitlist_signups, waitlist_total, email_opens, email_clicks, email_bounces (migration 006). Dashboard shows waitlist count in portfolio stats and company cards.

### 2026-03-19 [code] VerdeDesk onboarding complete — business knowledge extracted
VerdeDesk fully onboarded: onboard_status set to complete, infra registered (GitHub + Vercel), 3 research reports written (market_research with 30K+ TAM, competitive_analysis with 6 competitors, seo_keywords with 12 long-tail keywords). Extracted 12 playbook entries from VerdeDesk's existing MISTAKES.md, SELF_IMPROVEMENT.md, and autonomy-learnings.md covering: landing page patterns (problem-led copy, email-only forms), SEO strategy (static prerendered guides, free tool lead magnets), pricing (10-18x cheaper than alternatives), distribution learnings (Reddit fails with low-karma, content authenticity rules), Vercel gotchas (Standard Protection 401, deploy limits), and autonomous operation principles. Total playbook now has 18 entries across 10 domains. VerdeDesk has 0 cycles — CEO will enter BUILD mode on first run, using the research data to spec features with acceptance criteria.

### 2026-03-19 [code] CEO lifecycle modes for new companies
CEO agent now has three modes based on company maturity: Build (cycles 0-2, spec features from Scout research with acceptance criteria), Launch (cycles 3-5, conversion optimization with hypotheses), Optimize (cycles 6+, current metrics-driven management). Build mode requires every feature decision to cite which research report informed it. Max 2 engineering tasks per cycle, always includes Growth task. First cycle must deliver core value proposition end-to-end. Lifecycle data (cycle count, revenue, customers, original proposal) injected into CEO context in both orchestrator.ts and GitHub Actions workflow.

### 2026-03-19 [code] Deploy drift detection — Hive self-monitoring
Added 3-layer detection for when Vercel deployments fall behind git: (1) Sentinel check #8 compares main SHA vs Vercel production SHA every 4h, dispatches `deploy_drift` event. (2) GitHub webhook now tracks `hive` repo pushes and deploy failures in `context_log` (previously only tracked company repos). (3) Todos endpoint surfaces deploy drift as a warning with SHA-specific IDs. Triggered by 6 commits going undeployed after a PR merge.

### 2026-03-19 [code] Fix model routing — claude_args instead of unsupported inputs
`claude-code-action@v1` silently ignored `model` and `max_turns` inputs — all brain agents ran on Sonnet instead of Opus. Fixed by using `claude_args: "--model X --max-turns N"`. Verified CEO workflow now initializes with `claude-opus-4-6`.

### 2026-03-19 [code] Dynamic todos on dashboard
Added "Needs your attention" section to Overview tab. Todos are auto-detected from system state: missing settings that block agents (GSC key, Resend, Stripe, etc.), pending manual actions from agent escalations, system health gaps (unprocessed companies, high failure rate, missing research data). New API endpoint /api/todos queries live state — not a static list. Dismissed todos expire after 30 days so recurring issues resurface. New dismissed_todos table. Header badge now shows combined count of approvals + blocker todos.

### 2026-03-19 [code] Growth intelligence layer Phase 1 implemented (ADR-014)
Built data-driven Growth cycle: GSC API client (`src/lib/gsc.ts`), IndexNow protocol (`src/lib/indexnow.ts`), DIY LLM citation tracker (`src/lib/llm-tracker.ts`), visibility endpoint (`/api/agents/visibility`), `visibility_metrics` table (migration 004). Dispatch route updated: Growth agent collects fresh visibility data before each run, GSC metrics + LLM citation results injected into prompt. Growth prompt updated with priority framework (striking distance → low CTR → LLM gaps → competitor keywords). Boilerplate updated: llms.txt, robots.txt (AI crawler allows), sitemap.ts, JSON-LD structured data. Settings page: added `bing_webmaster_key` and `indexnow_key`. All free APIs, €0 cost.

### 2026-03-19 [chat] Growth intelligence layer designed (not yet implemented)
Researched organic visibility landscape for 2026: traditional search (Google/Bing), AI answer engines (ChatGPT/Perplexity/Copilot), and community discovery. Key finding: brands on Google page 1 appear in ChatGPT answers 62% of the time — SEO is foundation for LLM visibility. Designed data-driven Growth cycle: GSC + Bing Webmaster Tools + DIY LLM citation tracker (using Gemini free tier) + IndexNow protocol. All free APIs. Growth never runs without fresh visibility data. New visibility_metrics table designed. llms.txt standard adopted for AI crawler optimization. Cadences changed from calendar-based to data-freshness-driven (no more "weekly" — agents check when data is stale). Full design doc saved externally, implementation planned after model routing PR lands.

### 2026-03-19 [code] Per-agent model routing (ADR-013)
Upgraded GitHub Actions from claude-code-base-action v0.0.63 (Sonnet default, model param bug) to claude-code-action v1 with native model input. Removed manual Claude CLI install + Node 20 wrapper (v1 handles installation). CEO, Scout, and Evolver now run on Opus for better strategic reasoning. Engineer stays on Sonnet for speed. Growth and Outreach upgraded from Gemini 2.5 Flash-Lite to Flash for better content/email quality. Ops stays on Groq. Fallback chain: Flash → Flash-Lite → Groq. PR opened to test CEO workflow with new Opus model.

### 2026-03-19 [code] VerdeDesk imported + approval dispatch fix
VerdeDesk imported via Settings page (GitHub scan: Next.js, TypeScript, Tailwind, Vercel). Company created (status: mvp), scan report stored, approval gate created and approved. Fixed 3 bugs during import: (1) duplicate slug crash on re-import — imports route now checks for existing company and updates instead of inserting, (2) approval decide route wasn't firing `repository_dispatch` — added `dispatchEvent()` helper that chains to CEO workflow, (3) `new_company` approval blindly set status to `approved` even for imports already at `mvp` — added `AND status = 'idea'` guard. Onboarding agent hasn't run yet — blocked on claude.ai/install.sh 403.

### 2026-03-19 [code] Dashboard redesign shipped
Redesigned the Hive dashboard: two-column layout replaced with 4 tabs (Overview, Inbox, Activity, Intelligence). Portfolio companies and Scout proposals are now separate views. Playbook renamed to "Intelligence" with domain grouping and confidence labels (Proven/Strong/Promising/Early) instead of raw percentages. Typography: Outfit + IBM Plex Mono replacing DM Sans + JetBrains Mono. Contrast bumped to pass WCAG AA (secondary text #6b6b7b → #9d9da8). Minimum font size 11px (was 9px). Agent badge config updated for consolidated 7-agent names. Import dialog moved to Settings page. Company detail page also updated with new design system.

### 2026-03-19 [code] Brain workflow fixes
Fixed all 4 brain agent workflows: `anthropics/claude-code-base-action@v1` tag doesn't exist (changed to `@v0.0.63`), `claude_args` isn't a valid input (replaced with native `max_turns` input).

### 2026-03-19 [chat] Dashboard redesign
Redesigned the Hive dashboard: two-column layout replaced with 4 tabs (Overview, Inbox, Activity, Intelligence). Portfolio companies and Scout proposals are now separate views. Playbook renamed to "Intelligence" with domain grouping and confidence labels (Proven/Strong/Promising/Early) instead of raw percentages. Typography: Outfit + IBM Plex Mono replacing DM Sans + JetBrains Mono. Contrast bumped to pass WCAG AA (secondary text #6b6b7b → #9d9da8). Minimum font size 11px (was 9px). Agent badge config updated for consolidated 7-agent names. Import dialog moved to Settings page.

### 2026-03-19 [carlos] API keys configured + CEO agent tested
Gemini API key, Groq API key, and GH_PAT all configured. CEO agent tested successfully via GitHub Actions manual dispatch. Worker agents (Growth/Outreach on Gemini, Ops on Groq) are now unblocked. Stripe → repository_dispatch chain is live.

### 2026-03-19 [code] Event-driven architecture migration (ADR-011 + ADR-012)
Migrated from Mac launchd nightly loop to fully event-driven GitHub Actions. 10 agents consolidated to 7 (migration 003). Created 4 brain workflows (hive-ceo.yml, hive-scout.yml, hive-engineer.yml, hive-evolver.yml) + sentinel (hive-sentinel.yml). Updated worker-agents.yml to remove all schedule triggers. Added repository_dispatch to Stripe webhook. Ops escalation chains to Engineer. Secrets set: CLAUDE_CODE_OAUTH_TOKEN, GH_PAT, DATABASE_URL. orchestrator.ts now fallback only.

### 2026-03-19 [chat] Critical schema fixes found during codebase review
Full 78-file cross-reference found 7 issues that would crash the orchestrator on first real run: agent_actions.cycle_id/company_id were NOT NULL but Idea Scout, Healer, and Provisioner insert with NULL; agent CHECK constraint was missing 4 agent names (outreach, research_analyst, healer, orchestrator); approvals gate_type CHECK was missing 4 types (outreach_batch, vercel_pro_upgrade, social_account, first_revenue); settings table not in schema.sql; middleware didn't exclude /api/agents. Migration 002 fixes all of these. MISTAKES.md entry #13 captures the prevention rule.

### 2026-03-19 [chat] Worker agent dispatch system built
Vercel serverless endpoint (`/api/agents/dispatch`) + GitHub Actions scheduler (`.github/workflows/worker-agents.yml`). Worker agents (Growth, Outreach, Ops) now run independently of the Mac-based nightly loop. Growth: 3x/day, Ops: 4x/day, Outreach: daily. Each dispatch reads full context from Neon, calls Gemini or Groq, writes results back. €0 additional cost. Needs CRON_SECRET in both Vercel env vars and GitHub Actions secrets.

### 2026-03-19 [chat] Cross-company learning architecture (ADR-010)
Decided: multi-repo, not monorepo. Each company keeps its own GitHub repo. Hive coordinates via shared Neon DB. Three mechanisms: (1) Provisioner injects playbook + pitfalls into new company CLAUDE.md, (2) Healer cross-correlates errors across companies before fixing, (3) Venture Brain creates cross-pollination directives. Polsia (comparable system, 1,100+ companies) uses the same pattern.

### 2026-03-19 [chat] Idea Scout rewritten — 3 proposals per batch
Now generates exactly 3 ideas: 1 Portuguese market, 1 Global, 1 best-pick. Each gets its own approval gate. Rejected ideas auto-killed. Scouting triggers when pipeline < 3 companies (not weekly anymore).

### 2026-03-19 [chat] Company priority sorting
New companies (0 cycles) first, struggling companies (lowest CEO score) next, oldest as tiebreaker. Nightly loop reordered: Scout → Provision → Imports → Company cycles → Self-heal → Brain → Evolver → Digest.

### 2026-03-19 [chat] Multi-provider model routing (ADR-009)
Brain agents (CEO, Idea Scout, Research, Venture Brain, Healer, Evolver) on Claude CLI. Workers (Growth, Outreach) on Gemini free tier. Ops on Groq. Engineer always Claude (needs cwd). Fallback: Gemini → Groq → Claude. Need `gemini_api_key` + `groq_api_key` in settings.

### 2026-03-19 [chat] Email domain fix
`hive-phi.vercel.app` can't have DNS records (Vercel-owned). Old code used fake `@hive.local` addresses — removed. Test mode: `onboarding@resend.dev` for digest to Carlos. Production: need real domain in Resend. Flolio's domain could work — Carlos to confirm domain name and where nameservers are hosted.

### 2026-03-18 [chat] Full Hive architecture designed and built
76 files, 21 pages, 9 ADRs. Dashboard, orchestrator, 7 agent prompts, self-healing, provisioning, imports, outreach pipeline. Deployed to Vercel.

## What's Next (in priority order)

1. **Execute remaining approved company tasks** — verdedesk (P1 e2e test, P2 calculator, P3 analytics), senhorio (P2 e2e verify, P3 rent calculator), flolio (P1 onboarding)
2. **Run CEO for VerdeDesk** — trigger CEO workflow, will enter BUILD mode, spec features from research data
3. **Resolve email domain** — buy domain, add Resend DNS records, set `sending_domain` (outreach still blocked)
4. **PR auto-merge for company repos** — stale PRs accumulate because nobody merges them
5. **Review Evolver proposals** — approve/reject in Inbox tab

## Open Questions

- What's the Flolio domain? Can we add a `hive.` subdomain to it in Resend?
- When to import Flolio? (Carlos said "later" — growth phase, more complex)
- Target for first revenue? Timeline expectations for first company?

## How to Pick Up Context in Any Claude Session

**The single URL that catches any Claude up:**
```
https://hive-phi.vercel.app/api/briefing
```

### In a new Claude Chat session:
Tell Claude: "Fetch https://hive-phi.vercel.app/api/briefing and read it — that's my project context."
Claude will web_fetch it and instantly know: what companies exist, what's pending, what broke, what was recently decided, and what's next.

### In Claude Code CLI:
At the start of a session:
```bash
curl -s https://hive-phi.vercel.app/api/briefing | jq .
```
Or just read BRIEFING.md from disk (it's in the repo root).

### Writing context back:
From any tool, POST to the context API:
```bash
curl -X POST https://hive-phi.vercel.app/api/context \
  -H "Content-Type: application/json" \
  -d '{"source":"chat","category":"decision","summary":"Decided X because Y","detail":"Full reasoning..."}'
```

### What the briefing endpoint returns:
- Current state (active companies, pipeline, pending approvals, configured/missing settings)
- Recent context log (last 20 entries from all tools)
- Health (recent errors)
- Performance (cycle scores)
- Knowledge (top playbook entries)
- Links to key repo files

---

## Archive

> Entries older than 2 weeks move here. Keep the insight, trim the detail.

_(empty — project started 2026-03-18)_
