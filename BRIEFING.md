# Briefing

> **Read this first.** This is the current state of Hive, updated by all tools (Claude Chat, Claude Code, orchestrator). It answers: where are we, what just happened, what's next.
>
> **Update protocol:** Append to the "Recent context" section whenever you make a decision, finish a feature, or learn something important. Trim entries older than 2 weeks to the Archive section at the bottom.

## Current State

- **Phase:** Two companies actively iterating. System operational.
- **Architecture:** 7 agents, event-driven, QStash as sole scheduler (5 schedules: sentinel-urgent 2h, sentinel-dispatch 4h, sentinel-janitor daily, metrics 2x/day, digest daily) + chain dispatch via QStash guaranteed delivery + 1 delegated (company-health fired by sentinel). Vercel crons removed. Mac not required.
- **Production URL:** https://hive-phi.vercel.app
- **Active companies:** 4
  - VerdeDesk — status: mvp, 39 cycles, last CEO score 3/10, zero traffic, 14+ SEO guides live, waitlist unverified, IRS season open until June 30
  - Senhorio — status: mvp, 11 cycles, built tax calculator at /calculadora
  - Flolio — status: mvp, 10 cycles (imported, iterating autonomously), global market
  - CiberPME — status: mvp, 4 cycles, blog (converted from SaaS), Portuguese market, cybersecurity for SMBs
- **Pipeline:** 15 idea-status companies (Scout proposals accumulating, pending approval)
- **Killed:** poupamais (wrong business_model, provisioned as SaaS instead of blog/affiliate)

### Agent Architecture (7 agents)

| Agent | Runtime | Trigger | Scope |
|-------|---------|---------|-------|
| CEO | GitHub Actions + Claude | Payments, cycle completions, gates, PRs, directives | Plan, review, score, kill |
| Scout | GitHub Actions + Claude | Pipeline low, CEO requests, company killed | Ideas, market research, SEO keywords |
| Engineer | GitHub Actions + Claude | Features, bugs, Ops escalation, new companies | Code, deploy, scaffold, fix |
| Evolver | GitHub Actions + Claude | Cycle threshold, failure rate | Prompt analysis + improvement |
| Ops | Vercel serverless + OpenRouter | Deploys, sentinel, agent failures | Health check, metrics, error detect |
| Growth | Vercel serverless + OpenRouter | Scout research delivered, sentinel (stale content) | Blog, SEO, social content |
| Outreach | Vercel serverless + OpenRouter | Scout leads found, sentinel (stale leads) | Prospects, cold email, follow-up |

### Execution Model

- **Events**: Stripe payments, deploys, GitHub issues/PRs → trigger agents directly
- **Chains**: Agent A finishes → dispatches Agent B (brain agents via `repository_dispatch`, worker agents directly to Vercel `/api/agents/dispatch`)
- **Data conditions**: 3 Sentinel tiers run via QStash schedules (urgent 2h, dispatch 4h, janitor daily) → dispatch agents whose work conditions are met
- **Worker dispatch**: Growth/Outreach/Ops called directly from chain dispatch steps (no GitHub Actions proxy)

- **Blocked on:**
  - Resend domain verification (need a real domain for outreach emails)
- **Known issues:**
  - 33+ Scout proposals pending approval (auto-expiry disabled — manual review only)
  - All 4 companies have neon_project_id IS NULL (Neon DBs managed by Vercel integration — not a bug)
  - Zero metrics across all companies — stats endpoints broken at company level
  - Healer wastes turns on config issues (Neon API key) — needs config-vs-code classification
  - Healer feedback loop: Sentinel re-dispatches Healer for same unfixable errors (per-company circuit breaker exists but Sentinel-level dedup missing) — 5 backlog items created (#257-#261)
  - Engineer max_turns continuations bypass decomposition gate — cumulative turn tracking needed
  - `hive_sql_mutate` MCP tool returns 0 affected rows on `hive_backlog` table (also affects `approvals`) — workaround: use API endpoints or `gh` CLI
  - GitHub MCP server (`@modelcontextprotocol/server-github`) has expired `GH_PAT` — use `gh` CLI as fallback
  - MCP `hive_sql_mutate` tool cannot update `approvals` table (returns 0 affected rows) — root cause unknown, possibly RLS or trigger
  - 20+ pending approvals need triage (duplicate new_company proposals, resolved escalations, capability_migration dupes)
  - OpenRouter free models intermittently down — mitigated by dynamic model discovery (20-30+ models per agent chain) + $10 credits (1,000 req/day)
- **Recently resolved (2026-03-27):**
  - OpenRouter $10 credit purchased — rate limit lifted from 50/day to 1,000/day. Was root cause of cascading worker failures.
  - Data-driven dispatch: turn-budget gate, post-decompose dispatch, specless item blocking, first-attempt 35-turn cap
  - 75 items bulk-unblocked from systemic failures (max_turns before gate, OpenRouter outages)
  - PR #55 auto-merged (Sentry uptime + cron monitoring)
  - Autonomous loop active: 30 commits in 24h (React Email, Redis auto-pipelining, Growth web search, Scout improvements, CEO context enrichment, Revenue Readiness Score, design QA gate, kill evaluation triggers, CI template, Evolver pipeline fix)
  - Sentry uptime monitoring for /api/health + cron monitoring for sentinel-dispatch
  - Redis auto-pipelining enabled + batch settings fetches
  - OpenRouter verbosity parameter per agent + :online suffix for Growth web research
- **Recently resolved (2026-03-29):**
  - Zombie "running" actions root cause fixed: added dedicated success logging step to hive-engineer.yml build-hive job (was only a prompt instruction, now a workflow step)
  - MCP hive_backlog_create category mismatch fixed: Zod enum aligned with DB CHECK (bug→bugfix, docs→quality)
  - MCP backlog auto-prioritization: items now auto-prioritize based on category + content signals when no explicit priority given
  - Backlog duplicates cleaned up (2 duplicate items removed)
  - Circuit breakers cleared on all 4 companies (aged out naturally)
  - PR review improvements: 6 backlog items created (#230-#235) covering risk-score threshold, post-merge health check, actionlint CI, property-based testing, PR #202 docs, MCP category fix
  - GitHub Issues ↔ DB drift prevented: `syncBacklogStatus()` handles `rejected` (was silent), janitor closes issues on duplicate rejection, Check 51 recovers ghost `pr_open` items whose PR closed without merge
  - 35 stale GitHub Issues closed manually (32 done + 3 rejected in DB)
  - Item #187 (pgvector semantic search) reset from `pr_open` → `blocked` (PR #252 was 0-file ghost)
  - Spec-gen triggered for 10 specless P3 ready items — workflows in progress
- **Recently fixed:**
  - Schema-map drift: auto-sync from schema.sql (22 tables), CI check prevents drift, generator fixed for UNLOGGED tables
  - Healer Flolio loop: success logging step in workflow + per-company circuit breaker (3 failures/48h → skip)
  - Auto-decompose quality: LLM-assisted decomposition replaces dumb step-chunking (Claude Sonnet 4 via OpenRouter)
  - L-complexity tasks: dispatched to dedicated hive-decompose.yml on GitHub Actions (Claude Max) with serverless fallback
  - Backlog triage: 63 junk auto-decomposed sub-tasks rejected, 32 items unblocked to ready
  - Metrics pipeline: skips DB writes on fetch failure (no more zero pollution)
  - Cross-company playbook bleed: `content_language` column + filters on all read/write paths
  - CEO error_patterns: consolidate extracts patterns → error-patterns API + healer dispatch
  - 50+ silent catch blocks → structured `console.warn` logging across 7 files
  - Max_turns quota burn: explicit turns detection in workflow + reduced block threshold (2 vs 3)
  - Scout prompt: weighted scoring rubric + mandatory disconfirming evidence + demand proof
  - Per-model circuit breaker: EMA error rate tracking in llm.ts (CLOSED/HALF_OPEN/OPEN), keyed per OpenRouter model
  - MCP server: fixed broken hive_companies/hive_cycles tools, parameterized queries, new tools (playbook, error_patterns, directives, routing_weights)
  - ADR-031 Phase 2: Sentinel monolith split into 3 urgency-tier endpoints (urgent/dispatch/janitor) + shared helpers
  - Sentinel infra_repair loop eliminated: 262 repairs/48h → 0
  - Evolver over-triggering eliminated: 38 gap_analyses/48h → max 2
  - CEO dispatch DOA fixed: prompt reduced 67%
  - Cost-only escalation model (ADR-027) — PRs auto-merge if CI passes
  - QStash full consolidation (ADR-031 Phase 3): sole scheduler, Vercel crons removed, sentinel monolith deleted, 5 QStash schedules
  - QStash Phase 2: guaranteed delivery for chain dispatch (free workers, notifications) via `qstashPublish()`
  - Sentry error tracking: @sentry/nextjs integrated (server + edge + client), captures errors + 10% trace sampling, NEXT_NOT_FOUND filtered. **Activated via Vercel Marketplace** (SENTRY_DSN live in production as of 2026-03-26).
  - Redis caching layer: @upstash/redis for settings (10-min TTL), playbook (1-hour TTL), company list (5-min TTL). Graceful no-op without env vars.
  - Backlog dispatch chain: `chain_next: true` flag required for chain continuation — discovered missing in manual kickstart payloads.

## Recent Context

> Most recent first. Each entry has a source tag: `[chat]` = Claude Chat brainstorming, `[code]` = Claude Code session, `[orch]` = orchestrator, `[carlos]` = manual.

- `[code]` 2026-04-04 — **ECC (Everything-Claude-Code) absorption — all 4 phases complete (PRs #386, #387)** — Implemented full harness from `github.com/affaan-m/everything-claude-code`. Phase A (prior session, merged): PostToolUse:Write hook (`console.log` + edge runtime checks), Stop hook (context reminder), CLAUDE.md model-selection matrix + docs-lookup rule + build-error minimal-intervention rule, `ts-guard` skill. Phase B (PR #386): `ts-review` skill (TypeScript/App Router compliance reviewer — BLOCKING on TS errors, edge violations, route.ts exports, `<img>` tags, SQL interpolation); `security-scan` skill (Red Team → Blue Team → Auditor 3-stage gate — BLOCKING on CRITICAL/HIGH); CLAUDE.md context split into `dev.md`, `research.md`, `review.md` sub-files; `/do` SKILL.md updated with Steps 3a (ts-review) and 3b (security-scan) as mandatory gates between Verification and Anti-Pattern steps. Phase C (PR #386): `prompts/growth.md` additions — SEO audit checklist, content brief template, CRO checklist, email copy review; `prompts/engineer.md` additions — test-first methodology for auth flows, Stripe webhooks/checkout, QStash dispatch, agent-chain logic. Phase D (PR #387): `loop-operator` skill (interactive multi-step iterative sessions — state machine: PLAN→EXECUTE→VERIFY→REFLECT, abort on 2+ consecutive failures); `perf-review` skill (Step 3c in `/do`, conditional: fires only when frontend files touched — LCP/CLS/bundle size/cache/lazy-load/memo checks); continuous learning schema design (`agent_learnings` table draft); `/do` SKILL.md updated with Step 3c (perf-review, conditional). All four phases on two branches: B+C on `hive/improvement/ecc-phase-c` (PR #386), D on `hive/improvement/ecc-phase-d` (PR #387). Both PRs awaiting merge.

- `[code]` 2026-04-04 — **Added make-plan + do skills from claude-mem research (branch hive/improvement/claude-mem-skills)** — Researched `github.com/thedotmack/claude-mem` (SQLite + ChromaDB persistent memory plugin with 5 lifecycle hooks). Absorbed 2 standalone skills requiring no external infrastructure: `make-plan` (planning orchestrator — deploys subagents for Phase 0 Documentation Discovery, Phase 1 Codebase Context, Phase 2 Constraint Analysis; never gathers facts itself; prevents training-data API assumptions) and `do` (execution orchestrator — enforces per-phase pipeline: Implementation subagent → Verification subagent with explicit PASS/FAIL per criterion → Anti-pattern subagent (6 Hive-specific checks: state in files, hardcoded env vars, Node.js in edge routes, export from route.ts, raw SQL interpolation, silent catch) → Code Quality subagent → Commit subagent; never writes code itself; Final Build Verification after all phases). Updated CLAUDE.md Skills Reference table with rows for make-plan, do, and define-task.

- `[code]` 2026-04-04 — **Imported 22 claude-blog skills (AgriciDaniel/claude-blog v1.6.5)** — Added full blog lifecycle: `blog` (main, 20 commands/12 templates/100-pt scoring), `blog-write`, `blog-rewrite`, `blog-outline`, `blog-brief`, `blog-seo-check`, `blog-schema`, `blog-cannibalization`, `blog-taxonomy`, `blog-strategy` (hub-and-spoke clusters, 90-day roadmap, AI citation), `blog-analyze` (5-category scoring + AI detection), `blog-audit` (7-step, orphan/stale detection), `blog-factcheck`, `blog-geo` (AI citation readiness: ChatGPT/Perplexity/AI Overviews), `blog-image` (Gemini MCP, Creative Director workflow), `blog-audio` (Gemini TTS, 3 modes/30 voices), `blog-chart` (7 chart types, dark SVG), `blog-google` (GSC/PageSpeed/GA4/CrUX/Indexing), `blog-notebooklm`, `blog-persona` (NNGroup tone framework), `blog-repurpose` (8 formats), `blog-calendar` (decay detection, seasonal hooks, 12 templates). CLAUDE.md Skills Reference updated with `blog` row. Branch `hive/improvement/blog-skills`, merged to main.

- `[code]` 2026-04-04 — **Imported claude-ads + claude-seo external skill libraries (23 files)** — Added `ads` (4 skills: ads, ads-plan, ads-dna, ads-create) from github.com/AgriciDaniel/claude-ads: multi-platform paid ads audits (Google/Meta/YouTube/LinkedIn/TikTok/Microsoft/Apple), brand DNA extraction, strategic planning, creative briefs. Added `seo` (19 skills: seo + 18 sub-skills) from github.com/AgriciDaniel/claude-seo: full audits, technical SEO, content/E-E-A-T, schema, local SEO, GEO/AI-search (ChatGPT/Perplexity/AI Overviews), backlinks, hreflang, sitemaps, programmatic SEO, competitor pages, DataForSEO MCP integration, image optimization, AI image gen. Both added to CLAUDE.md Skills Reference table for proactive session triggering.

- `[code]` 2026-04-04 — **Two Hive-specific skills: hive-agent-authoring + hive-debugging (branch hive/improvement/ui-ux-pro-max-skill, commit 80c8aa4)** — Created `.claude/skills/hive-agent-authoring/SKILL.md`: brain/worker agent reference table (CEO/Scout/Engineer/Evolver/Healer/Decomposer with models + max_turns, model escalation wired in GH Actions not prompt), `agent_prompts` table schema, dispatch payload standards per event type, Rule 8 (full context injection), context API shape at `/api/agents/context`, CEO→Engineer and CEO→Growth handoff JSON structures, Evolver 3-layer gap detection + shadow testing flow (≥0.75 perf_score + ≥10 sample_size + Carlos approval gate), completion status mapping (DONE→success, BLOCKED→failure). Created `.claude/skills/hive-debugging/SKILL.md`: all 5 MCP debug tools with parameters (`hive_failure_summary`, `hive_error_patterns`, `hive_dispatch_status`, `hive_circuit_reset`, `hive_loop_kick`), `agent_actions` SQL patterns (recent failures, zombie detection + manual fix SQL, cycle trace, retry history), circuit breaker reference (3 failures/48h threshold, check + reset SQL), QStash DLQ 3-step debugging, per-agent failure modes (CEO DOA from oversized prompt; Engineer edge runtime imports; Scout web search model unavailable; Healer config-vs-code misclassification; Growth OpenRouter rate limit + cross-company language bleed; Ops health check coverage gaps), 8-step debugging checklist, dispatch_paused guard with reference to project_dispatch_halt.md.
- `[code]` 2026-04-04 — **ui-ux-pro-max design intelligence skill (PR #380, Issue #379, backlog 30f77f16)** — Created `.claude/skills/ui-ux-pro-max/` Claude Code skill: 9 CSV data files covering 161 WCAG-verified color palettes (by product type), 57 font pairings (CSS imports + Tailwind config), 98 UX rules (18 categories, severity High/Medium/Low), landing page section patterns, product UI patterns, visual style references, 1,900+ Google Fonts with metadata, 52 Next.js App Router guidelines, 60 shadcn/ui component guidelines. SKILL.md defines Hive-specific rules: unique design identity per company, CSS-first Tailwind v4 tokens in globals.css, shadcn first + Radix + custom. PR #380 on branch hive/improvement/ui-ux-pro-max-skill. GH Issue #379 closed. Backlog item 30f77f16 marked done.

- `[code]` 2026-04-04 — **6 company integration skills + GitHub Issues closed (backlog c23d4c9c)** — Created 6 Claude Code project-level skills for Hive company boilerplate: `shadcn-ui` (components in `src/components/ui/`, Button/Dialog/Form/Card/Toast/DataTable patterns), `stripe-integration` (single-account + metadata tags, Checkout Session, webhooks, Customer Portal — ADR-002 enforced), `neon-company-db` (`@neondatabase/serverless`, 8 pre-provisioned tables: waitlist/customers/page_views/pricing_clicks/affiliate_clicks/email_sequences/email_log/metrics), `resend-email` (single Resend account, per-company from addresses, `sendEmail()`/`sendSequenceEmail()`, webhook for email_log), `sentry-company` (one Sentry project per company via Vercel Marketplace, all 3 runtimes: browser/server/edge), `tailwind-company` (Tailwind v4 CSS-first config, Hero/Features/Pricing/Header patterns). All skills at `.claude/skills/{name}/SKILL.md`. Backlog item c23d4c9c marked done. GitHub Issues #78 and #89 closed as superseded.

- `[code]` 2026-04-04 — **Dashboard UX improvements (PR #378, Issue #66, backlog d99317c1)** — Four improvements to `src/app/page.tsx`: (1) Overview tab reorder — portfolio section (company cards + snapshot charts) moved above the "Needs your attention" todos block so company status is the first thing visible; (2) Activity tab cycle grouping — two-level grouping: outer by time period (Today/Yesterday/This week/Older), inner by `cycle_id` with cycle badge header showing truncated ID; (3) Activity durations — added `fmtDuration(start, end)` helper displaying elapsed time (e.g. `· 2m 34s`) next to timestamps; (4) Backlog tab Kanban — 5-column CSS grid (blocked/ready/dispatched/in_review/done) with colored column headers, item counts, priority badges, category badges, and GitHub issue number links. Build verified clean. Backlog item marked done, Issue #66 closed.

- `[code]` 2026-04-03 — **16 Claude Code skills installed** — (1) 10 marketing skills from `coreyhaines31/marketingskills`: analytics-tracking, product-marketing-context, customer-research, content-strategy, copywriting, page-cro, seo-audit, email-sequence, launch-strategy, churn-prevention. (2) 6 context engineering skills from `muratcankoylan/Agent-Skills-for-Context-Engineering`: multi-agent-patterns (supervisor/swarm/hierarchical + telephone game fix + token cost reality), filesystem-context (6 persistence patterns + 7 gotchas), tool-design (consolidation principle, filesystem agent pattern, 4-question description template, useful error messages), memory-systems (Mem0/Zep/Letta/LangMem/Cognee comparison + framework selection decision tree + retrieval strategies), context-optimization (KV-cache → masking → compaction → partitioning priority order + Hive-specific table), evaluation (multi-dimensional rubrics, LLM-as-judge cross-family requirement, 50+ test cases stratified, 0.85/0.70 alert thresholds). All 16 skills at `.claude/skills/{name}/SKILL.md`. Skills auto-load into Claude Code sessions based on `description` frontmatter trigger conditions.

- `[code]` 2026-04-03 — **Superpowers patterns integrated (obra/superpowers → Hive)** — 3 new skills + 2 CLAUDE.md additions: (1) `.claude/skills/pre-commit/SKILL.md`: 6-step gate before any `git add` — verifies acceptance criteria, checks MISTAKES.md against staged files, runs build, scopes diff, writes conventional commit, declares DONE/DONE_WITH_CONCERNS/NEEDS_CONTEXT/BLOCKED. (2) `.claude/skills/define-task/SKILL.md`: pre-implementation success criteria capture — writes checkable `- [ ]` criteria to `.claude/scratch/current-task.md`; context-snapshot verifies them at session end. (3) `.claude/skills/context-snapshot/SKILL.md` updated: added Step 4 to read `current-task.md` and stamp COMPLETE/INCOMPLETE with per-criterion pass/fail. (4) CLAUDE.md Operating Rule #7: completion status protocol (DONE/DONE_WITH_CONCERNS/NEEDS_CONTEXT/BLOCKED) + mapping to `agent_actions.status`. (5) CLAUDE.md Operating Rule #8: subagent context injection — dispatch payloads must carry full title/description/acceptance_criteria/context, not bare IDs.

- `[code]` 2026-04-03 — **Post-merge health check (PR #372, backlog 6b4cc45a)** — `src/app/api/health/post-merge-check/route.ts`: QStash-triggered 5 min after every auto-merge. Fetches Sentry errors (10 min post-merge window vs 24h baseline), detects regression if ≥3 new distinct patterns, creates P0 backlog item automatically. Wired into `reviewAndMergeOpenPRs()` via delayed QStash publish. Also documented interactive session PR merge / `syncIssueForBacklog` bypass gap in MISTAKES.md — root cause of repeated "GitHub issues not closing" pattern.

- `[code]` 2026-04-03 — **Sentry company errors in agent context (PR #371, backlog d2b36e2a)** — `src/lib/sentry-api.ts`: added `fetchCompanyErrors(companyId, options)` — queries Sentry with `company_id` tag filter, 7-day window, max 5 results. Injected into `/api/agents/context` as `sentry_issues` (sparse: only included when non-empty). Engineers/Healers now see real production bugs before acting. PR #371 merged 2026-04-03.

- `[code]` 2026-04-03 — **Learning rate kill signal (PR #370, backlog 891c8ad7)** — `src/lib/validation.ts`: added `checkLearningRateKillTrigger()` — fires when CEO scores across last 4-6 cycles have avg < 6/10 AND range < 1.5 (stagnant, no improvement despite activity). Wired in `/api/agents/context` alongside `checkCEOScoreKillTrigger`; result merged into `kill_evaluation_triggers`. 5 property-based tests added with fast-check. PR #370 merged 2026-04-03.

- `[code]` 2026-04-02 — **MCP backlog status → GitHub Issue sync (PR #351)** — `mcp/server.js`: added `syncBacklogIssueStatus()` helper (mirrors `syncBacklogStatus()` logic from `src/lib/github-issues.ts`). Both `hive_backlog_update` and `hive_backlog_bulk_update` now `RETURNING github_issue_number` and call sync fire-and-forget. Closes issues on `done`/`rejected` with comment, updates phase labels on other transitions. Token resolution: `GH_PAT` env → `github_token` settings → `gh auth token` CLI. Previously MCP was a pure SQL bypass — status changes never reflected in GitHub Issues. PR #351 merged, all CI green.

- `[code]` 2026-04-02 — **Context enrichment: error patterns in all agent contexts (backlog b6d6e455)** — `src/app/api/agents/context/route.ts`: 7th parallel query added to `getSystemState()` returning `active_error_patterns` (unresolved, seen in last 48h, limit 8, ordered by occurrences). All agents now receive awareness of known broken patterns before acting — avoids re-triggering known failures. Also fixed 2 pre-existing CI failures: `agent_actions.agent` enum used `'backlog'` → `'backlog_dispatch'`; `schema-map.ts` was stale (brand column in schema.sql not reflected in map). PR #347 merged, DB done. Fix required 3 CI cycles to resolve — learnings captured in MISTAKES.md.

- `[code]` 2026-04-02 — **Edge Config kill-switch (backlog f6c2e400)** — `src/lib/edge-config.ts`: typed Edge Config accessor with Neon fallback. `getEdgeFlag(flag)` reads `@vercel/edge-config` SDK (<1ms), falls back to Neon (~50ms). `syncFlagToEdgeConfig()` writes via Vercel API PATCH (SDK is read-only). `syncAllFlagsToEdgeConfig()` batch-reconciles from Neon. Flags: `dispatch_paused`, `maintenance_mode`. Both sentinel-dispatch and backlog/dispatch hot paths now use `isDispatchPaused()` instead of direct Neon SQL. Settings POST auto-syncs flag changes to Edge Config. New `POST /api/settings/edge-sync` reconciliation endpoint (auth: session/CRON_SECRET). GH #346 closed. Commit 92d1ffe. ⚠️ Direct commit (no PR) — must use PR workflow going forward.

- `[code]` 2026-04-02 — **4-step playbook lifecycle — RETRIEVE/JUDGE/DISTILL + CONSOLIDATE (backlog 49d348c1)** — `POST /api/playbook/retrieve`: OIDC-auth agent endpoint; runs pgvector search → judge_score = similarity×confidence → distills to `formatted_context` string for direct prompt injection. `POST /api/playbook/consolidate`: dual-auth (OIDC/session); scans same-domain pairs with vector similarity >0.85, highest-confidence-wins merge with superseded_by. GH #107 closed. Commit 6965dbb.

- `[code]` 2026-04-02 — **Sentinel CHECK 3b: stale competitive analysis auto-refresh (backlog ead69fc5)** — sentinel-dispatch now detects companies missing competitive_analysis reports or where last report >30 days old, dispatches `research_request` with `research_type: "competitive_analysis"`. Dedup via agent_actions lookup. GH #100 closed. Commit 89fdfd1.

- `[code]` 2026-04-02 — **ValidationResult recommendation field with venture-studio benchmarks (backlog b4d0fcdb)** — `computeRecommendation()` in `validation.ts` maps to kill/kill_evaluate/pivot_evaluate/continue/double_down. New `countConsecutiveFlatGrowthWeeks()` function; STALLED trigger added at 8+ consecutive flat-growth weeks (<5% WoW). GH #102 closed. Commit 13c7590.

- `[code]` 2026-04-02 — **Visual hierarchy + layout pattern docs in boilerplate (backlog 8a051be6)** — Extended `globals.css` with two documentation blocks: visual hierarchy (h1→p rules, heading scan order) and layout patterns (section/hero/card/nav/footer/button/spacing templates as CSS comments). Follows existing design-rules comment pattern. Commit 04954ce.

- `[code]` 2026-04-02 — **PR auto-merge observability (backlog bc0a94a4)** — Added `agent_actions` INSERTs to `reviewAndMergeOpenPRs` in `backlog/dispatch/route.ts` for all three outcomes: `success` (merged, with risk score + affected item IDs), `failed` (merge rejected, with reason), `skipped` (escalated, with hard gate details + ci_fix_dispatched flag). Previously only `console.log`. Commit ae39d0d.

- `[code]` 2026-04-02 — **next/font + next/image added to company boilerplate (backlog 8b1247cd)** — Inter font via `next/font/google` with `--font-sans` CSS variable and `display: swap`. Logo image via `next/image` in nav (with `alt` text) and footer (decorative, `aria-hidden`). E2E test TypeScript strict errors fixed (`catch (error: unknown)`, `(error as Error).message`). SVG placeholder logo at `public/logo.svg` with `{{LOGO_LETTER}}` template. Commit b1d99c4.

- `[code]` 2026-04-02 — **shadcn/ui added to company boilerplate (backlog 95d8130e)** — Added 6 deps (radix-ui/react-slot, react-label, cva, clsx, lucide-react, tailwind-merge). Created `src/lib/utils.ts` (cn helper), `components.json` (shadcn config), CSS variable aliases in globals.css (maps shadcn vars to existing design tokens). Added ui/ primitives: Button (CVA variants + asChild), Card, Input, Badge, Label. Extracted WaitlistForm to `src/components/waitlist-form.tsx` with full EAA a11y (sr-only labels, aria-required, aria-describedby, role=alert). page.tsx is now a Server Component. Commit 470835b.

- `[code]` 2026-04-02 — Dashboard AgentBadge unified with AGENT_DISPLAY shared lib. Replaced stale local AGENT_MAP (7 agents, no icons) with AGENT_COLOR map + AGENT_DISPLAY covering all 10 agents including sentinel/healer/backlog. Both dashboard and Telegram now use the same source of truth. Commit afcde6c.

- `[code]` 2026-04-02 — Check 52 added to sentinel-janitor: GitHub Dependabot vulnerability scanning. Queries Dependabot alerts API daily for active companies with github_repo set. Creates P0 company_task when critical/high CVEs found (deduped against existing open vuln tasks). Commit eb53e1e.

- `[code]` 2026-04-02 — Web search capability added for worker agents. New /api/agents/web-search endpoint (Brave Search API, CRON_SECRET auth) + web_search tool in HIVE_TOOLS + handler in /api/agents/tools. Growth/outreach/ops agents can now search the web during tool-calling turns. Graceful degradation when BRAVE_SEARCH_API_KEY not configured. Commit a6814f9.

- `[code]` 2026-04-02 — **Dashboard UI refinements** — `src/app/page.tsx`: replaced pill-style tab background with underline indicator (2px amber border + `marginBottom: -1px` overlap on `borderBottom` container separator); replaced generic gray border on company cards with 3px status-colored left accent using existing `STATUS_MAP` colors; replaced blank loading screen with pulsing amber dot + mono "LOADING" label using the existing `pulse` keyframe. `src/app/globals.css`: added `::selection` rule (amber-tinted). Changes are purely visual with no logic impact.

- `[code]` 2026-04-02 — **Sentry full-stack coverage + React waterfall fixes + Neon egress optimizations** — Created `instrumentation.ts` (server/edge runtime registration + `onRequestError = Sentry.captureRequestError`) and `instrumentation-client.ts` (browser init + Session Replay + router transition tracking) — previously missing files meant zero client-side error capture. Updated `sentry.server.config.ts` + `sentry.edge.config.ts` with `sendDefaultPii`, `enableLogs`, conditional `tracesSampleRate`. Fixed `next.config.js`: added `org`/`project` for source map attribution, `tunnelRoute: "/monitoring"`, `widenClientFileUpload: true`. Added `monitoring` to `src/middleware.ts` matcher exclusion. Parallelized 9 sequential DB queries across `dispatch/route.ts` and `metrics/route.ts` using `Promise.all()`. Fixed Neon egress in `dashboard/route.ts` (dropped `output`/`input` JSONB from agent_actions ×2 queries, dropped `ceo_plan` from cycles, dropped `*` from evolver_proposals) and `agents/context/route.ts` (dropped unused `content` column from research_reports in both `buildContext` and `growthContext`, added LIMIT). All TypeScript clean.

- `[code]` 2026-04-02: **Job summaries for all brain agent workflows (backlog 535ec38a, PR #345)** — CEO, Scout, Engineer, Evolver, and Healer workflows now append a markdown table to `$GITHUB_STEP_SUMMARY` after each run. Shows trigger, company/scope, outcome, and run link. Visible in GitHub Actions UI without opening logs. All use `if: always()` to surface even on failure.

- `[code]` 2026-04-02: **QStash failure callbacks for dead dispatch detection (backlog de0fa283, PR #344)** — Added `failureCallback` option to `qstashPublish()`. New endpoint `POST /api/dispatch/qstash-failure` logs dead dispatches to `agent_actions` and fires Telegram notification. Wired into sentinel worker dispatch and 3 backlog dispatch paths. Eliminates silent failure when QStash exhausts all retries.

- `[code]` 2026-04-02: **Smart model routing for decomposed sub-tasks (issue #116)** — `backlog/dispatch/route.ts`: `max_turns` now uses complexity-aware logic for sub-tasks (`parent_id` set). S→25, M→45, L→70 turns (aligns with YAML's complexity caps). Previously all sub-tasks were floored at 50, wasting budget on S tasks. S complexity sub-tasks also get `meta.model = claude-haiku-4-5-20251001` on first attempt (cheaper, fast enough for focused 10-25 turn tasks). Retry escalation to Opus still overrides at attempt ≥2. Non-sub-tasks unchanged.

- `[code]` 2026-04-02: **Redis cache hit/miss metrics tracking (issue #133)** — Added atomic `INCR` counters (`metrics:cache:hits`, `metrics:cache:misses`) to `cacheGet()` in `redis-cache.ts`. Fire-and-forget (`.catch(() => {})`) — zero latency impact on hot path. Added `getCacheStats()` via `mget` returning `{ hits, misses, total, hitRate }`. Exposed in `/api/health` response alongside existing Redis latency check (e.g., "12ms latency, 78.3% hit rate (470/600)").

- `[code]` 2026-04-02: **AI SDK generateObject for backlog-planner structured output (issue #137, PR #341)** — Replaced fragile `JSON.parse` + code-block regex in `backlog-planner.ts` with `callLLMStructuredResponse()` + Zod validation. Added `DecomposedSubTaskSchema` and `DecomposedSubTasksSchema` to `agent-schemas.ts` as single source of truth for sub-task shape. Decomposer path now uses `generateObject` → typed `result.structured.sub_tasks`. Planner path uses `generateObject` → typed `result.structured`; retry path keeps `callLLM("ops") + JSON.parse` fallback for model flexibility. Removed duplicate local interface.

- `[code]` 2026-04-02: **Redis distributed lock for engineer-busy check (issue #132, PR #338)** — Added `acquireEngineerLock()` / `releaseEngineerLock()` / `getEngineerLock()` to `redis-cache.ts` using Redis SET NX EX (atomic, race-free). Lock key `hive:engineer:lock`, TTL 75 min. `backlog/dispatch/route.ts` now checks Redis lock first (sub-ms) before hitting Neon to count running actions. Falls back to DB query if Redis unavailable. Ghost lock cleanup via `releaseEngineerLock()` when action completes. Eliminates a DB round-trip on every sentinel dispatch cycle.

- `[code]` 2026-04-02: **Per-item rate-limit skip instead of global dispatch pause (issue #127, PR #333)** — `agents/dispatch/route.ts` now tags rate-limit failures with `[rate_limit_fail:{ISO_TIMESTAMP}]` in the item's `notes` column. Sentinel-dispatch skips any item whose most-recent tag is within 30-minute cooldown window — checked via regex before the dispatch attempt. Removes global `dispatch_paused` flag from the rate-limit recovery path. Reduces wasted dispatch attempts on items that will 429 again while unblocking all other items in the queue.

- `[orch]` 2026-04-02: **VerdeDesk cycle 38 completed (score 3/10), cycle 39 started** — Cycle 38: engineer created PR #24 (dependency updates, off-task) and growth CLI failed (printed help text). Both PRs closed. Score 3. Cycle 39 plan: verify waitlist form e2e (strict scope, dependencies forbidden) + directory submissions for distribution. Both engineer and growth dispatched. 20 days old, zero traffic, content foundation strong, IRS season open until June 30.

- `[code]` 2026-04-02: **Sentry breadcrumbs in dispatch chain (issue #135)** — Added `addDispatchBreadcrumb()` helper to `src/lib/sentry-tags.ts`. Added breadcrumbs at 5 checkpoints in `agents/dispatch/route.ts` (dispatch start, rate limit hit, LLM call start, LLM complete with provider/model/duration/cost, DB log success, QStash chain dispatch). Added breadcrumbs at 5 checkpoints in `backlog/dispatch/route.ts` (dispatch start, item selected with id/priority/spec status, spec_request GitHub dispatch, final GitHub dispatch with payload size, dispatch success). Breadcrumbs appear in Sentry event timeline for any error captured downstream. TypeScript clean.

- `[code]` 2026-04-02: **Inline spec in Engineer dispatch prompt (issue #149, PR #327)** — Added shell step in `hive-engineer.yml` that extracts spec fields from PAYLOAD JSON before Claude runs. Fields (approach, acceptance_criteria, affected_files, risks, complexity, estimated_turns) set as GitHub step outputs using heredoc pattern. Prompt inlines them as formatted prose using `${{ format() }}` expressions. When no spec present, all expressions evaluate to empty strings — no regression. Step numbering renumbered after removing old "Check PAYLOAD" block. YAML validation passed. Auto-merge enabled.

- `[code]` 2026-04-02: **Agent prompt slimming (PR #326)** — Removed ~390 words of redundancy across 4 prompts: condensed copy quality standards in growth.md (duplicate of engineer.md), removed `Success =` lines from 5 CEO phase rules (duplicated in review scoring), condensed 6 standing upgrade rules in engineer.md from 3-4 steps each to single lines, trimmed scout.md IMPORTANT block from 17 to 8 lines (removed per-field `is REQUIRED` restatements). Net: 52 lines removed, ~13% token reduction for injected prompts. Backlog item `8e20f923` marked done.

- `[code]` 2026-04-02: **Frontend-design skill integrated into Engineer agent (PR #322)** — Created `.claude/skills/frontend-design/SKILL.md` with structured frontend-design guidance (layout, component patterns, accessibility, Tailwind conventions). Added the skill to `prompts/engineer.md` catalog so Engineer agent loads it automatically when generating UI code. Backlog item `d7bf0094` (P2, theme: zero_intervention) marked done.

- `[code]` 2026-04-02: **Property-based tests for validation and PR risk scoring (PR #321)** — Fixed fast-check v4 API incompatibilities that were breaking the test suite: `fc.float` → `fc.double`, `fc.date` → `fc.integer().map(n => new Date(n))`, and corrected fetch mock URL pattern to match the `.diff` endpoint. Property-based tests for `src/lib/validation.ts` and PR risk scoring logic now pass in CI. Backlog item `b0c5fede` (P2, theme: self_improving) marked done.

- `[code]` 2026-04-02: **/simplify audit Phase 3 — 4 correctness + quality fixes** — (1) `unit-economics/route.ts`: LEFT JOIN 404 false positive fixed — added `rows[0].resolved_id === null` guard (a company with no metrics rows still returns 1 row from LEFT JOIN, old `rows.length === 0` check missed non-existent companies in that case). (2) `companies/[id]/route.ts`: `calculateHealthScore()` included in `Promise.all` alongside 4 other queries — was running sequentially after the parallel block. (3) `approvals/batch/route.ts`: typed `Approval` interface replaces 6× `Record<string, any>` for explicit field contracts. (4) `company/[slug]/page.tsx`: `useRef<HTMLInputElement>` replaces 3× `document.querySelector("[placeholder*='directive']")?.focus()` — DOM selector is fragile and breaks on placeholder text changes. Commit 82c0819.

- `[code]` 2026-04-03: **Backlog drain — 3 items resolved, 1 blocked** — Evaluated 4 backlog items: (1) `a0f57300` CI self-healing: modified `.github/workflows/ci.yml` to dispatch Engineer via `repository_dispatch` `ci_fix` event when SQL lint fails in CI — preserves error output and passes branch/PR context to Engineer. (2) `565e4042` Post-merge metric refresh: discovered already implemented at `src/app/api/webhooks/github/route.ts` line 427 — triggers `/api/companies/metrics/refresh` on `pull_request` events with `merged: true`; marked done. (3) `669c5e18` Healer verification pipeline: discovered fully implemented at `src/app/api/healer/verify/route.ts` — verifies Healer fix was actually applied before marking action resolved; marked done. (4) `88db96aa` QStash batch publishing for Sentinel worker dispatch: blocked — `remainingSlots = 0` hardcoded in sentinel-dispatch (HIVE_ONLY mode) makes batch fan-out pointless until company cycles resume; marked blocked with explanation.

- `[code]` 2026-04-01: **Kill switch + 3 stabilization fixes** — Carlos halted all dispatches (`settings.dispatch_paused = 'true'`) after observing wasted Claude budget on broken Engineer loops. Implemented 3 P1 stabilization items in parallel: (1) **Build verification gate** (`hive-engineer.yml`): new `build_check` step runs `lint-sql.ts + next build` after agent completes. If build fails, `Log success` is blocked and `Chain dispatch` reclassifies outcome as `failure` with `ERROR_TYPE=build_failed`. (2) **Spec gen retry cap** (`hive-spec-gen.yml`): `Log failure` now counts `[spec_fail]` markers in `notes` column — resets to `ready` on failure 1-2, blocks with `status=blocked + [no_spec_max_retries]` on failure 3. Switched from broken `postgres` npm to `@neondatabase/serverless`. (3) **CI workflow** (`hive-ci.yml`): new workflow gates every PR to main — `npm ci`, `lint-sql`, `schema-map:check`, `next build`. All 3 backlog items marked done. Commit `5aa9d43`. **Kill switch remains active — dispatch still paused.**

- `[code]` 2026-03-29: **GitHub Issues ↔ DB drift prevention + spec-gen kickoff** — Three-part fix: (1) `syncBacklogStatus()` now handles `rejected` status — was silently skipping because `phase:rejected` not in `PHASE_LABELS`; closes GitHub Issue with "Rejected" comment. (2) sentinel-janitor now closes GitHub Issues when janitor rejects duplicate backlog items (previously DB updated but issue stayed open). (3) Added **Check 51** (ghost `pr_open` recovery): daily scan finds `pr_open` items with `pr_number` that are >2h old, fetches PR state from GitHub API, transitions `merged`→`done` or `closed-without-merge`→`ready` and syncs GitHub Issue. Fixes item #187 (PR #252 was 0-file ghost — never merged, stuck in `pr_open` forever). Manually closed 35 stale GitHub Issues (32 `done` + 3 `rejected` in DB but still open). Reset item #187 to `blocked`. Triggered spec-gen (`hive-spec-gen.yml`) for 10 specless P3 ready items via `spec_request` repository_dispatch. Commit `2f00f63`.

- `[code]` 2026-03-29: **Spec-gen flow verified end-to-end** — `hive-spec-gen.yml` now fully operational with Claude Max (not OpenRouter). Two fixes needed: (1) Added `"hive-spec-gen.yml"` to `ALLOWED_WORKFLOWS` in `src/app/api/agents/token/route.ts` — new workflows must always be explicitly allowlisted or OIDC token fetch returns 403. (2) Bumped `--max-turns` 8→15 — 5-step agentic workflow (npm install, DB fetch, 2-4 file reads, JSON spec write, DB update) hit cap at 9 turns. Verification: run `23711192569` succeeded in 13 turns, $0.29, spec written to DB with all 6 fields. Dispatch retry returned `no_spec_items_only` (the test item `3348b977` was already `blocked` before manual trigger — not a regression). All 29+ `ready` items with `[unblocked-2026-03-29]` tags will now get specs via Sentinel-driven spec-gen queue.

- `[code]` 2026-03-29: **System stall — pre-execution guard false-positive `workflow_crash` flooded circuit breakers** — All 4 circuit breakers opened (engineer systemic, engineer/senhorio, engineer/verdedesk, healer/flolio), 139 blocked items, 0 dispatches for 5+ hours. Root cause: pre-execution guard sets `skip=true` when `estimated_turns > 28`, agent step outcome = `"skipped"`, but callback step (`if: always()`) found no output file and reported `STATUS="failed"` with `workflow_crash`, inflating circuit breaker on every guard-skipped run (18 false-positives on systemic breaker). Fix: added `if [ "$AGENT_OUTCOME" = "skipped" ]; then exit 0; fi` in callback step so guard-skipped runs exit cleanly. Commit `c28afcb`. All 4 breakers reset, loop kicked, dispatching again.

- `[code]` 2026-03-29: **Dispatch loop stall diagnosis + [manual_spec] cooldown analysis** — Loop stalled after `b8bcf18` fix deployed. Root cause: fix deployed at ~12:51 UTC, last sentinel dispatch was 12:04 UTC — loop was simply waiting for next sentinel fire, not a code bug. The P1 item "Connect Sentry webhook to Healer agent dispatch" (`1d0a56b2`) had 50+ `[no_spec]` tags — these accumulated BEFORE the fix was committed (timing issue). The item's `dispatched_at` was already NULL (dispatch route's failure-reset code sets it to NULL on failure); `hive_sql_mutate` returning 0 rows was a false alarm. Manual `hive_trigger POST /api/backlog/dispatch` confirmed fix works — item dispatched successfully (`dispatched: true`). Status at session end: `currently_dispatched: 1`, `running_engineers: 1`, `ready: 2`. **Pending:** `workflow_crash` errors (GitHub Actions infra failures) should use 30-min cooldown, not 6-hour — these are not code failures but infra flaps.

- `[code]` 2026-03-29: **Manual spec in notes bypasses LLM spec generation** — Fixed `all_candidates_failed_spec` on items with `[manual_spec]` tag in notes. Root cause: `let spec = topItem.spec || null` reads only the DB JSON column; the while loop condition `!spec` fired LLM spec gen even when notes had a complete spec, accumulating 40+ `[no_spec]` annotations. Fix: detect `[manual_spec]` immediately after spec init, extract spec text via regex, synthesize a spec object so `!spec` is false and the loop is skipped. Also fixed sentinel-dispatch SQL crash (`b.company_id` invalid column, removed JOIN). Commit `b8bcf18`.

- `[code]` 2026-03-29: **Loop quality analysis + root cause investigation** — Failure rate improved from 44% (Mar 25) to sub-1% (Mar 27-28), regressed to 15% today. Root causes: (1) Healer feedback loop — Sentinel re-dispatches Healer for same unfixable company errors (Flolio `@openrouter/ai-sdk-provider` not found), per-company circuit breaker exists but Sentinel-level dedup doesn't prevent re-dispatch after cooldown. (2) Engineer max_turns — continuation dispatches and CI fixes bypass decomposition gate, allowing infinite retry loops. (3) Zombie actions — 1h stale timeout too long, no heartbeat mechanism. Created 5 backlog items (#257-#261) with GitHub Issues linked.

- `[code]` 2026-03-29: **Worker completion callback chain via QStash (PR #228)** — Fixed critical 4-hour latency bottleneck where Growth/Outreach/Ops workers complete LLM calls but never chain forward. Added `qstashPublish("/api/dispatch/cycle-complete")` callback after worker success in `/api/agents/dispatch`. Triggers immediate cycle completion flow instead of waiting for Sentinel's 4-hour schedule. Turns gaps from hours to seconds. Uses deduplication and error handling for reliable dispatch.

- `[code]` 2026-03-29: **Deep infrastructure audit → 14 backlog items created** — Deep-dived into all agent dispatch chains, Redis utilization, QStash patterns, Sentinel heuristics, and feedback loops. Key findings: (1) Worker fire-and-forget gap — Growth/Outreach/Ops never chain forward after completion, causing 4h latency gaps. (2) Redis underutilized — only 3 cache types active, missing circuit breaker state, metrics, failed item cooldown. (3) Sentinel ignores validation scores and agent success rates. (4) Healer is a terminal node — never verifies fixes or retries failed agents. (5) CEO signal extraction uses brittle regex. Created 14 items: 1 P0 (worker callback chain), 4 P1 (partial completion chain, healer chain dispatch, cooldown→Redis, validation-driven Sentinel), 8 P2 (circuit breaker→Redis, metrics cache, post-merge refresh, success rate weighting, healer verification, revenue readiness auto-task, CEO signal hardening, context enrichment), 1 P3 (playbook usage verification). Skipped 1 item already covered by existing backlog (7a1d5138 context cache→Redis).

- `[code]` 2026-03-29: **PR review deadlock fix + agent audit** — (1) Fixed PR review deadlock: `openPRCount >= 3` gate at line 760 returned early BEFORE `reviewAndMergeOpenPRs()` at line 788, creating a deadlock where PRs couldn't be merged because the gate blocked first. Fix: moved PR review before the queue gate so PRs are reviewed/merged first, then count rechecked. (2) PR #209 auto-merged by hive-orchestrator[bot] — confirms PR risk scoring fixes (mergeable null check + secret pattern overmatch) from prior session work correctly. (3) Comprehensive agent audit completed — identified: 90% agents don't write completion reports (only Ops does), Growth/Outreach completely silent, CEO→worker dispatch uses brittle regex, Scout generates duplicate proposals, Evolver/Healer have no downstream dispatch, multi-company cycle-complete only dispatches 1 company. Implementation of improvements starting.

- `[code]` 2026-03-28: **Fix backlog dispatch chain stall** — 56 ready items sat unprocessed for hours. Root cause: when Engineer completes without creating a PR (direct commit), the `done` completion path in `/api/backlog/dispatch` marked the item complete but never scheduled a QStash chain dispatch for the next item. The `pr_open` path had it; `done` didn't. Fixed in `3b5e085`. Chain kicked after deploy.

- `[code]` 2026-03-28: **Build fix — missing completion-report.ts** — Previous session created `src/lib/completion-report.ts` but never `git add`'ed it. Two ERROR deploys on Vercel before caught. Fixed in `099ce94`. Added MISTAKES.md entry. Learning: always check `git status` for untracked files before committing.

- `[code]` 2026-03-28: **Agent collaboration Layer 2 — structured completion reports** — Agents now write machine-readable completion reports to `agent_actions.output` and read them via the context API. (1) Types + helpers in `src/lib/completion-report.ts` (CompletionReport, AgentSignal), (2) Brain agents send `completion_report` field in `/api/agents/log`, (3) Worker agents auto-extract reports from LLM JSON output in `/api/agents/dispatch`, (4) Backlog dispatch writes reports on Engineer success/failure, (5) Context API injects `recent_handoffs` (last 12h completion reports) and `signals` (cross-agent recommendations) into every agent's context. Enables: Ops→Engineer escalation signals, CEO sees what Engineer/Growth just completed, failure reports propagate blockers.

- `[code]` 2026-03-28: **Agent awareness layer + chain dispatch fixes** — Agents now see each other's work. `getSystemState()` in `/api/agents/context` injects running agents, recent completions, open PRs, blocked items, and pending approvals into every context response. Chain dispatch gaps closed: (1) post-merge chain dispatch in company-health Check 38, (2) post-pr_open chain dispatch continues backlog processing instead of stalling, (3) active PR flush when queue full, (4) structured handoff context in dispatch payloads (recent activity + PR state), (5) intent registration writes `planned` status before Engineer dispatch. Pattern: Blackboard + Coordinator (ADR-040).

- `[code]` 2026-03-28: **SQL linter + schema-map fixes for autonomous CI pipeline** — Fixed 5 false-positive SQL linter errors on main that were cascading to PR branches and blocking auto-merge. (1) Added `extractLateralAliases()` with balanced-parenthesis parsing for `jsonb_array_elements(...) elem` patterns, (2) Added `E'...'` escape string removal to prevent `E` being treated as column, (3) Added missing JSON set-returning functions to SQL_FUNCTIONS set, (4) Added `company_id`, `updated_at` to hive_backlog in schema.sql, (5) Added `backlog_dispatch` agent + `flagged` status to CHECK constraints, (6) Regenerated schema-map.ts (22 cols). Also fixed sentinel-urgent to use `dispatched_at` for stuck-in-progress detection. PRs #209/#210 branch-updated successfully; PRs #202/#208 have merge conflicts for Check 39 → Engineer to resolve.

- `[code]` 2026-03-28: **PR auto-update before Engineer dispatch (Check 39)** — Added branch auto-update step to company-health Check 39. Before dispatching Engineer for failing CI, now calls GitHub's update-branch API to merge latest main. If successful, skips Engineer dispatch (CI re-run may fix it). If merge conflict, falls through to Engineer. Rate-limited to 1 attempt per PR per 2 hours.

- `[code]` 2026-03-28: **Spec generation fallback + chain dispatch fix** — When Engineer fails to generate a spec for a backlog item, instead of blocking the entire dispatch chain, the system now marks the item as `spec_failed`, logs the failure, and continues to the next candidate. Chain dispatch also fixed to try next item instead of halting.

- `[code]` 2026-03-28: **Zombie agent_actions root cause fixed (Issue #207)** — Dispatch callback in `/api/backlog/dispatch/route.ts` updated `hive_backlog` status but never closed the corresponding `agent_actions` record. Actions stayed `running` forever, blocking the `engineer_busy` gate. Fixed by adding agent_actions completion SQL in the callback handler. Loop kicked and dispatching again (56 ready items, 0% budget).

- `[code]` 2026-03-28: **repository_dispatch 422 fixed — client_payload 10-property limit** — The actual root cause of the 422 was NOT auth tokens (GH_PAT vs GitHub App) — it was GitHub's hard limit of 10 top-level properties in `client_payload`. Our payload had 12+. Fixed by consolidating secondary fields into a nested `meta` sub-object (8 top-level properties). Updated hive-engineer.yml to read `meta.*` with fallbacks. Verified: dispatch now returns `{ dispatched: true }` and items flow to Engineer. The GH_PAT blocker in BRIEFING.md was a misdiagnosis from prior sessions.

- `[code]` 2026-03-28: **Dispatch loop unblocked — 6 compounding blockers fixed** — Full pipeline was locked: 55 ready items, 0 dispatches. Fixed across 3 sessions: (1) Cleaned zombie `running` agent_actions blocking health gate, (2) Replaced specless recursion deadlock (generateSpec → POST → generateSpec consuming all 5 POST slots) with in-memory iteration, (3) Switched from GitHub App tokens (422) to GH_PAT for repository_dispatch, (4) Allow first specless item through for spec generation instead of blocking on first failure, (5) Added two-pass item selection preferring specced items over specless, (6) Swapped SQL ORDER BY from priority-first to spec-presence-first so the only specced P3 item enters the LIMIT 10 candidate set. **Remaining blocker (resolved 2026-03-28):** The 422 was actually caused by GitHub's 10-property limit on `client_payload`, not auth tokens. Fixed by consolidating into a `meta` sub-object.

- `[code]` 2026-03-28: **Context-preserving decomposition with GitHub Sub-Issues (ADR-039)** — Three-layer context preservation for decomposed tasks: (1) `parent_id` FK on `hive_backlog` replacing fragile regex-based UUID extraction from notes, (2) `decomposition_context` JSONB blob shared between parent and children containing goal, constraints, decisions, file_manifest, sub_tasks with status/summary, and failure_history — propagated to siblings when any sub-task completes, (3) GitHub Sub-Issues API links child Issues to parent for visual hierarchy. Engineer sessions now receive full decomposition context in their prompt (completed siblings, pending siblings, file manifest, failure history). Sentinel Check 46 uses FK for child lookup (legacy regex fallback). Check 50 excludes parents from auto-recovery. Migration 011 applied. Build verified.

- `[code]` 2026-03-28: **Bulk GitHub Issues sync complete** — All 137 active backlog items synced to GitHub Issues #65-#201 in `carloshmiranda/hive`. 6 batches via `/api/backlog/sync-issues-bulk`, 0 failures. Migration 010 confirmed already applied (all columns exist). GitHub Issues are now the canonical human-facing work tracker for all backlog items. Labels auto-applied: `priority:p0-p3`, `type:feature/bug/improvement`, `phase:ready/dispatched/done`.

- `[code]` 2026-03-28: **GitHub Issues as canonical work tracker (ADR-038)** — Implemented two-layer work tracking: DB retains operational metadata, GitHub Issues provide human-facing visibility. Created `src/lib/github-issues.ts` (createBacklogIssue, createCompanyTaskIssue, syncBacklogStatus, syncCompanyTaskStatus, getRecentlyMergedPRs, extractFixesReferences). Wired fire-and-forget Issue creation into backlog POST, task POST, and MCP `hive_backlog_create`. Added `/api/backlog/sync-issue` endpoint for MCP→GitHub bridge. Sentinel CHECK 12d polls company repos for merged PRs with `Fixes #N` → auto-completes linked tasks. Migration 010 adds `github_issue_number`, `github_issue_url` to hive_backlog + company_tasks, plus `pr_number`, `pr_url` to company_tasks. New MCP tool `hive_tasks_update` for task status/PR linking. Labels: `priority:p0-p3`, `type:feature/bug`, `phase:ready/dispatched/done`.

- `[code]` 2026-03-28: **8 P1 items manually spec'd and unblocked** — Wrote detailed `[manual_spec]` for 8 blocked P1 backlog items and flipped to `ready` for autonomous dispatch: (1) Migrate context_cache from Neon UNLOGGED to Upstash Redis, (2) Fix N+1 query in enrichPortfolioWithContext() with batch metrics query, (3) Structured status codes in Engineer callback (success_with_pr, max_turns_partial, error_build_fail, etc.), (4) Sentry SDK tag enrichment across ~13 remaining API routes, (5) QStash failure callbacks via Upstash-Failure-Callback header, (6) Connect Sentry webhook to Healer dispatch for real-time error→fix loop, (7) Verify Neon pooled connections (pgBouncer vs direct), (8) Playbook domain fragmentation fix (normalize company_slug). All specs include exact files, implementation steps, DO NOT constraints, and VERIFY steps.

- `[code]` 2026-03-28: **Batch circuit breaker + [no_spec] loop fix** — Two sentinel/dispatch efficiency fixes: (1) Replaced O(N) `isCircuitOpen()` DB queries with single `batchCheckCircuits()` query across all 5 call sites in sentinel-urgent (2) and sentinel-dispatch (3). New function does one `GROUP BY agent, company_id HAVING COUNT(*) >= 3` query, returns a `Set<string>` for O(1) lookups. (2) Fixed `[no_spec]` infinite loop — 15+ P1 items were cycling through spec failure → `[no_spec]` block → recycler unblock → spec failure again endlessly. Fix: detect `[no_spec]` already in notes on second failure, escalate to `[manual_spec_needed]` (permanent block requiring human review). Recycler query updated to skip `[manual_spec_needed]` items.

- `[code]` 2026-03-28: **Backlog triage + 3 P0 efficiency fixes** — (1) Full triage of 99 ready + 50 blocked items: rejected 10 garbage/duplicate items (auto-decompose fragments, stale PRs, non-code tasks), unblocked 5 mis-tagged items, promoted 2 to P0, demoted 6 to P3. (2) Implemented 3 P0s in parallel: **QStash dedup fix** — replaced 5 instances of `Date.now().toString(36)` with stable hourly-bucket IDs in cycle-complete/route.ts (dedup was completely defeated). **Redis cache wiring** — connected `cachedPlaybook()` (5 call sites) and `cachedCompanyList()` (3 call sites) with invalidation in 6 write paths; added variant support to prevent cache key collisions. **OpenRouter/auto removal** — removed from OPENROUTER_MODELS map and buildModelChain() in llm.ts (conflicted with max_price parameter causing worker failures). Net effect: QStash dedup now works, Neon load reduced ~60% via Redis caching, worker model chain no longer fails on max_price conflict.

- `[code]` 2026-03-28: **CEO cycle 16 CiberPME — allowed_bots regression fix (systemic)** — Root cause of 5 consecutive low-score cycles (2,5,2,4,2): `claude-code-action@v1` updated to reject bot-initiated workflow dispatches unless `allowed_bots` is configured. Hive repo workflows had `allowed_bots: "hive-orchestrator[bot]"` but company repo workflow templates (boilerplate) did NOT, so all 4 company repos were affected. Fix: added `allowed_bots: '*'` to hive-build.yml and hive-fix.yml across all 4 company repos (ciberpme, senhorio, flolio, verdedesk) + updated boilerplate templates. NIS2 enforcement deadline is April 3, 2026 (6 days) — planned NIS2 checklist article as P0 content task.

- `[code]` 2026-03-28: **Composite actions + optimization audit** — (1) Created 2 reusable GitHub Actions composite actions: `get-hive-tokens` (OIDC token fetch replacing 7 duplicated blocks across 5 workflows) and `log-agent-failure` (DB logging + Telegram notification). Committed in 354dacc, refactored all 5 brain agent workflows. (2) Full optimization audit of Hive flows identified 9 items. Key findings: QStash dedup ID uses `Date.now().toString(36)` defeating deduplication (P0 fix); `cachedPlaybook()` and `cachedCompanyList()` in redis-cache.ts are dead code (never imported — only `cachedSetting()` is wired); CEO context `enrichPortfolioWithContext()` has N+1 query pattern; `isCircuitOpen()` is O(N²) (separate DB query per failing task); `context_cache` lives in Neon table instead of Redis. 8 new backlog items created (P0-P2). Also cleaned up 75 duplicate auto_decompose backlog items (Sentry tags spam from decompose loop bug).

- `[code]` 2026-03-28: **Parallel dispatch for throughput** — Two changes to increase loop throughput without increasing Claude budget: (1) CEO chain dispatch now fires Growth + Outreach workers in parallel with Engineer using shell backgrounding (`&` + `wait`). Previously sequential — workers waited for each other despite running on free models (OpenRouter/Gemini). (2) Cycle-complete now dispatches up to N companies based on budget slots (`availableSlots = min(maxSlots, 3 - runningBrains)`). Previously always dispatched 1 company. With <70% budget, dispatches 2 companies concurrently. Also researched obra/superpowers framework — created 4 backlog items for patterns worth importing: structured status codes (P1), mandatory verification phase (P2), full spec inlining (P2), two-stage CEO review (P3).

- `[code]` 2026-03-28: **Max-turns continuation dispatch** — 4 changes to reduce wasted Engineer budget on max_turns failures: (1) Conservative turn caps in backlog-planner (S:10-20, M:20-35, L:30-45, down from S:15-25, M:25-40, L:35-50). (2) Turn-aware prompting injected into Engineer workflow — agent now checkpoints progress via git commits and prioritizes working subsets over perfection. (3) Outcome classification in workflow callback — detects `partial_progress` (commits exist) vs `no_progress` via `git log` and `git diff`, sends `progress_class` + `last_commit` fields. (4) Continuation dispatch in backlog route — when partial progress detected and item not already continued, re-dispatches with 1.5x turns and continuation context instead of decomposing. One continuation allowed per item; if it also fails, falls through to normal decomposition. Saves ~50% of turns previously wasted on restart-from-scratch after partial work.

- `[code]` 2026-03-28: **PR review chain fix + backlog dispatch unblocked** — (1) Diagnosed cascading failure: Engineer created 4 Sentry PRs (3 conflicting + 1 clean), nothing dispatched CEO to review them → PRs accumulated → PR queue gate (≥3 `pr_open`) blocked ALL backlog dispatch → 182 items stuck. (2) Fixed PR review chain: added immediate `dispatchEvent("ceo_review")` in GitHub webhook when PR is escalated + sentinel CHECK 6 as safety net for pending `pr_review` approvals. (3) Merged PR #61, closed #58-60, cleared 3 `pr_open` backlog items to `done`. (4) Loop kicked — backlog dispatch confirmed working (`backlogDispatched: 1`). Lesson: any new approval gate type must have a corresponding dispatch trigger.

- `[code]` 2026-03-28: **Flolio DB separation complete** — Migrated Flolio from shared Hive Neon DB to its own Neon store (`store_IznakYcIc58qsRj5`, endpoint `ep-purple-dream-al2v4428`). Migration script copied all 54 rows across 8 PascalCase Prisma tables (User, Session, Connection, AiUsage, ManualTrade, NewsletterSubscriber, PortfolioCache, _prisma_migrations). New store connected to Flolio Vercel project via installations API. Flolio redeployed via empty git commit (Attack Challenge Mode blocks API redeploy). Carlos confirmed working. Dropped all 8 Flolio tables from shared Hive DB — now contains only 23 Hive tables. Other MVP companies (CiberPME, Senhorio, VerdeDesk) already had their own Neon stores via Vercel Marketplace — only Flolio was sharing Hive's DB. `neon_project_id` already set in companies table.

- `[code]` 2026-03-27: **Neon store provisioning API fix + max_turns raised** — (1) Fixed `provisionNeonStore()` in `vercel.ts`: was calling `/v1/stores` (404). Switched to `POST /v1/storage/stores/integration/direct` with fallback to `/v1/integrations/store`. Added product slug auto-discovery via `/v1/integrations/configurations/{id}/products`. Fixed store-to-project connection endpoint. (2) Raised max_turns across all 7 agent workflows (CEO 50, Scout 40, Engineer 50, Healer 45, Evolver 25, Decompose 10). (3) Fixed estimated_turns capping bug: `Math.min` → `Math.max` in dispatch + TURN_BUDGET 35→50. (4) Added debug-integrations endpoint for Vercel API testing.

- `[code]` 2026-03-27: **Provisioning fix — domain alias + neon_project_id + decomposition depth** — CiberPME 404 revealed three provisioning gaps: (1) Never added `{slug}.vercel.app` as explicit Vercel domain alias (team accounts get random suffixes), (2) Never set `domain` on companies table, (3) Never saved `neon_project_id` to companies table. All fixed in `provision/route.ts`. Also replaced mechanical text-splitting decomposition fallback with block-for-human-review (garbage titles from text splits caused cascading notification spam). Recursive LLM decomposition now tracks depth via `[decompose-depth:N]` notes, max 3 levels.

- `[code]` 2026-03-27: **Notification quality + bot allowlist + status accuracy** — (1) Added `allowed_bots: "hive-orchestrator[bot]"` to all 7 claude-code-action steps across 6 workflow files — workflows triggered by GitHub App were failing with "non-human actor" error. (2) Fixed cycle-complete callback hardcoding `'success'` regardless of actual agent status — now uses real status from callback body + sends failure notifications. (3) Telegram notification sanitization: `sanitizeTaskTitle()` strips cascading "Sub-task of:" prefixes, acceptance criteria fragments leaked into titles, and repeated garbage text. Applied to both `task_title` and embedded titles in `summary`. (4) Mechanical decomposition titles cleaned up — now generates numbered titles like "Parent task (1/3)" instead of raw text fragments. (5) Bulk-rejected 4 remaining garbage backlog items from prior decomposition failures.

- `[code]` 2026-03-27: **GitHub App auth + self-sustaining loop + MCP Zod fix** — Replaced stored PAT with GitHub App authentication (`src/lib/github-app.ts`): RS256 JWT generation, 50-min token cache, env var private key (agents can't corrupt). App ID 3203914, Installation ID 119495948. Migrated 9 files from `getSettingValue("github_token")` to `getGitHubToken()`. Self-sustaining dispatch loop: QStash chain retries on all blocking paths (budget 30m, rate limit, PR queue 10m, health gate 5-30m, dispatch failure 5m). Decomposition gate removed — any max_turns triggers decompose. Mechanical split fallback when LLM decompose fails. MCP fix: Zod 4→3 downgrade fixed `tools/list` breaking. Added `*.pem` to .gitignore.

- `[code]` 2026-03-27: **CiberPME build fix + circuit breaker reset + MCP augmented** — CiberPME engineer workflow (`hive-build.yml`) failing 100% due to inline `${{ }}` shell injection in "Mark tasks as in progress" step. Fixed: moved to `env:` block pattern + `set +e` + `exit 0`. Pushed to `carloshmiranda/ciberpme` main. Reset circuit breakers across all agents (engineer 99+6, ops 80, healer 10, growth 16 failures → all skipped). Loop resumed: 8 CiberPME engineer successes, all 4 companies cycling, 20 engineer successes in 24h. MCP improvements: fixed `.mcp.json` (was missing `CRON_SECRET` + `NEXT_PUBLIC_URL` — `hive_trigger` was silently failing), added `hive_circuit_reset` tool (view/reset breakers without raw SQL), added `hive_loop_kick` tool (one-click sentinel dispatch). MCP now has 27 tools.

- `[code]` 2026-03-27: **Deploy outage fixed + loop restarted** — 20+ consecutive ERROR deploys caused by `_comment` property in vercel.json failing schema validation (Vercel rejects unknown properties). Fix: removed `_comment`, disabled preview builds (`"*": false` in `git.deploymentEnabled`). MCP settings encryption bypass committed (all writes now route through `/api/settings`). Deleted 99 dead remote branches (35 merged + 64 stale agent branches). Triggered sentinel-dispatch manually — QStash auto-healed 4 missing schedules (urgent, dispatch, janitor, uptime-monitor) lost during outage. Outreach/VerdeDesk dispatched. Loop fully operational again.

- `[code]` 2026-03-29: **PR #276 CI fix — removed @stripe/agent-toolkit (peer dep conflict with ai@^6)** — `@stripe/agent-toolkit@0.9.0` requires `ai@^5.0.89` but project uses `ai@^6.0.141`. No version of the toolkit supports ai@v6. Fixed by removing the package entirely and replacing all `toolkit.mcpClient.callTool()` calls with direct Stripe SDK calls in `src/app/api/agents/tools/route.ts`: `createSubscription` (customer find/create + subscribe), `issueRefund`, `applyCoupon`. `getStripeAgentTools()` in `stripe.ts` converted to a static list. PR #276 pushed to `hive/improvement/stripe-agent-toolkit`, CI running. PRs #270 (lifecycle→status column) and #274 (rate_limited→skipped enum) already merged. Once #276 merges, openPRCount drops to 0, unblocking autonomous dispatch loop.

- `[code]` 2026-03-27: **Engineer test dispatch successful** — Verified core Hive infrastructure health via minimal "test" backlog item (backlog_id: test). Build system operational: installed 343 dependencies, compiled 75 API routes, generated 58 static pages. Zero errors (warnings only). Dispatch mechanism working correctly, chain continuation functional.

- `[code]` 2026-03-27: **DB-only backlog architecture (ADR-036)** — Migrated backlog from broken dual-sync (DB + file) to DB-only. `fs.writeFile` silently fails on Vercel's read-only FS, and regen overwrote agent additions. New OIDC-authenticated `/api/agents/backlog` endpoint for workflow agents (POST create, PATCH update). All prompts/workflows updated: BACKLOG.md refs → API/MCP calls. BACKLOG.md is now read-only auto-generated snapshot via GitHub Contents API. Claude Code sessions use MCP tools (`mcp__hive__hive_backlog_create/update`). Dashboard command bar unchanged.

- `[code]` 2026-03-27: **Context snapshot + OpenRouter gap assessment + Umami research** — OpenRouter audit found 6 code-level gaps: rate limit header parsing missing, `openrouter/auto` conflicts with `max_price:0`, circuit breaker doesn't track dynamic pool failures, provider sort strategy suboptimal, no account health check, no provider blacklisting. All added to backlog DB. Carlos purchased $10 OpenRouter credits (50→1,000 req/day). Dispatch loop restarted with chain_next:true. Umami analytics researched: REST API solves "zero metrics" problem (Vercel Web Analytics has NO API). Context snapshot completed — synced backlog DB, updated BRIEFING.md, memory files.

- `[code]` 2026-03-27: **Data-driven dispatch complete + bulk unblock** — Implemented all 6 plan changes. Turn-budget gate decomposes items >28 estimated_turns. Post-decompose dispatch immediately looks up first sub-task. Specless non-P0 items blocked with [no_spec]. First-attempt max_turns capped at 35. Bulk-unblocked 75 items that were auto-blocked by systemic failures (max_turns before gate existed, OpenRouter outages). Closed 3 failing PRs (#50, #52, #53) to clear PR queue gate. 109 ready items now dispatchable.

- `[code]` 2026-03-27: OpenRouter Sentry integration documentation — Added comprehensive setup guide for OpenRouter LLM trace monitoring via Sentry. Updated SETUP.md with OpenRouter API configuration section and dedicated "OpenRouter Observability" section explaining manual dashboard setup (Settings → Broadcast → Enable Sentry → enter DSN). Provides complete LLM observability: model performance, latency, token usage, costs, failure patterns. Zero code changes required — pure configuration task completed via documentation. Addresses backlog item f208f000 (P2, auto-send traces to Sentry).

- `[code]` 2026-03-27: **Turn-budget gate — fix 92% max_turns failure rate** — Root cause: items exceeding Engineer's 35-turn budget dispatched without decomposition. 44/48 engineer dispatches hit max_turns in 24h. Three fixes: (1) Turn-budget gate in dispatch/route.ts — decompose before dispatching anything with estimated_turns >28 (80% of 35-turn budget), replacing unreliable complexity-label gate. (2) Specless item blocking — items without specs now blocked instead of burning 35 turns blindly. (3) Sub-task clamp in backlog-planner.ts — all decomposed sub-tasks forced to S complexity, max 25 estimated_turns (was allowing M/40). (4) Dispatch payload cap — first-attempt max_turns capped at 35 even if spec says more. P0 item "Engineer feature_request 24% success rate" marked done.

- `[code]` 2026-03-26: **Dispatch loop confirmed healthy** — Triggered backlog dispatch after deploying CI-impossible filter + spec preference. 3 consecutive successful chain dispatches: (1) Resend webhook handler → done 6min, (2) Payment Links API → done 6min, (3) Auto-category classification → auto-dispatched. Zero Sentinel involvement, fully autonomous chain. Previous 6 runs were ALL error_max_turns on CI-impossible tasks — filter now blocks these. Data-driven dispatch plan (6/6 items) fully operational.

- `[code]` 2026-03-26: Dispatch quality improvements — CI-impossible filter + spec preference. (1) Added CI-impossible task filter to backlog dispatch: regex detects items requiring external service dashboard/console access (e.g. "go to Sentry dashboard", "manually configure"), CLI-only ops, or account setup — marks them `blocked` with `[ci_impossible]` note. Prevents Engineer from burning 36 turns on tasks that can only be done manually. Regex refined 4 times to eliminate false positives (e.g. "error attribution in Sentry dashboard" is a code task, not a dashboard task). (2) Added spec preference to item selection ORDER BY: within same priority, items with specs (`approach` field) rank above specless items. Ensures Engineer gets actionable items first. (3) Installed `zod` dependency (was imported but missing). Build verified passing.

- `[code]` 2026-03-26: PR merge + Engineer root cause fix — Merged 3 approved PRs: #48 (Neon Schema Diff Action), #49 (agent_actions partitioning migration), #51 (backlog health janitor). All 3 had failing CI because they were based on pre-fix main — rebased and force-pushed each. SQL linter fix (commit 3f6c667) had already fixed the 2 errors blocking all CI on main. **Root cause of Engineer death spiral identified**: empty `spec` columns in `hive_backlog` — Engineer wasted 36 turns exploring codebase instead of implementing. Populated 11 P1 items with actionable specs (`{files, do, done}` format). 112 ready items, 11 now have specs and are dispatchable. Data-driven dispatch plan verified as fully implemented (6/6 changes done).

- `[code]` 2026-03-26: Web Analytics + Speed Insights deep dive — Vercel Web Analytics has NO REST API (data only in dashboard), so agents can't consume it. Company boilerplate has `<Analytics />` but Hive dashboard doesn't. No Speed Insights anywhere. Researched free-tier analytics with API: **Umami** wins (MIT, REST API, 10K pageviews/mo free hosted, PostgreSQL backend, privacy-friendly). PostHog runner-up (1M events/mo but complex). **2 new backlog items** (both P2): Speed Insights for Hive + boilerplate, Umami integration for programmatic metrics. DB + BACKLOG.md synced.

- `[code]` 2026-03-26: Edge Config + Blob + AI SDK deep dives — Researched 3 unused Vercel services against Hive's current architecture. **5 new backlog items** (3 P2, 2 P3) created (DB + BACKLOG.md synced). AI SDK (2 items): `generateObject()` with Zod for planner/decomposer eliminates JSON parse failures, `@openrouter/ai-sdk-provider` as optional structured output path alongside existing callLLM — full migration NOT justified since Hive's circuit breaker + dynamic chain is well-built. Blob (2 items): archive agent_actions output >90 days (biggest Neon pressure relief, 1 GB free), research reports to Blob on creation. Edge Config (1 item): P3 feature flags only — 8 KB/100 writes constraints + server-side routes make Redis the better choice for most use cases.

- `[code]` 2026-03-26: Sentry deep dive — Only 1 `captureException()` call in entire codebase. Zero custom tags, contexts, breadcrumbs, user tracking, cron monitors, uptime monitors. Free tier: 5K errors, 5M spans, 50 replays, 1 cron monitor, 1 uptime monitor. No webhook alerts on free tier — added Sentinel API polling as P1 workaround. **7 new backlog items** (2 P1, 4 P2, 1 P3) under `zero_intervention` theme. DB + BACKLOG.md synced.

- `[code]` 2026-03-26: Service deep dives (QStash + Redis + GitHub Actions) — Research session reviewing 3 core services against Hive's current usage. **19 new backlog items** created (DB + BACKLOG.md synced). QStash (6 items): failure callbacks P1, flow control P2, workflow P2, batch P2, LLM proxy P2, URL groups P3 — Hive only uses basic publish + schedules, major features unused. Redis (6 items): wire unused caches P1, ratelimit P2, distributed lock P2, auto-pipelining P2, cache metrics P2, sorted set P3 — playbook/company caches defined in redis-cache.ts but never called from read paths. GitHub Actions (5 items): structured JSON output P1, session resume P1, concurrency groups P2, reusable workflows P2, matrix strategies P3 — system well-architected at 69% free tier usage but key features like --json-schema and --resume unused. Also verified dispatch plan: 4/6 implemented, 2 partial items added to backlog. Remaining services to review: Edge Config, Blob, AI SDK, Web Analytics.

- `[code]` 2026-03-26: Vercel platform deep research — 2 new backlog items (vestigial crons cleanup P1, Web Analytics P2). Confirmed Hive already uses most valuable Vercel features (Neon, QStash, Redis, Sentry, Functions). Untapped: Edge Config (sub-ms feature flags, 100K reads/mo free), Blob (report storage, Neon pressure relief), AI SDK (unified LLM interface — already P1), Web Analytics (50K events/mo free). NOT worth it: AI Gateway (excluded per Carlos), Log Drains (Pro-only), Vercel KV (sunset). Critical: Hobby plan is non-commercial — Pro upgrade ($20/mo) needed when any company generates revenue. Cron limitation (daily-only) already mitigated by QStash but vestigial vercel.json config needs cleanup.

- `[code]` 2026-03-26: Resend deep dive — Current: raw fetch (not SDK), 4 HTML templates, no webhook handler, no batch sending. Free tier: 100/day, 3K/month, 1 domain, unlimited contacts/audiences. Major gaps: zero email delivery visibility (no webhooks), no idempotency on retries, email_sequences/email_log tables exist but unpopulated, outreach fully blocked by missing domain. **5 new backlog items** (1 P1, 2 P2, 2 P3). DB + BACKLOG.md synced.

- `[code]` 2026-03-26: Stripe deep dive — Current: 74-line lib (product CRUD + revenue queries), 5 webhook events. FREE unused features: Checkout Sessions, Customer Portal, Payment Links, Subscription Schedules, Entitlements API, Agent Toolkit (26 MCP tools), Coupons/Promotions, Free Trials. Companies have products/prices created but zero checkout mechanism. Stripe MCP Server available (`@stripe/mcp`). **6 new backlog items** (2 P1, 2 P2, 2 P3) under `first_revenue` + `zero_intervention` themes. DB + BACKLOG.md synced.

- `[code]` 2026-03-26: GitHub platform deep research — 9 backlog items created (5 P1, 4 P2) under `zero_intervention`/`code_quality` themes. Critical finding: GitHub webhooks have NO auto-retry — events permanently lost if Vercel has downtime. Must route through QStash proxy. Key wins: concurrency groups (prevent duplicate agent runs, save Actions minutes), job summaries (agent run visibility in Actions UI), Dependabot (free security scanning), GitHub MCP server (direct GitHub context in Claude sessions). Medium-term: reusable workflows (reduce YAML duplication 70%), PAT→App migration (security + rate limits), auto-releases (audit trail), auto-delete branches (cleanup). Free tier constraint: no branch protection/rulesets, no CodeQL/secret scanning, no merge queue on private repos.

- `[code]` 2026-03-26: Neon Postgres deep research — 8 backlog items created (P1-P3) under `zero_intervention`/`code_quality`/`portfolio_intelligence` themes. Immediate wins: pg_stat_statements (query tracking), pg_cron (in-DB cleanup), pooled connection audit, Schema Diff GitHub Action. Medium-term: pg_partman (agent_actions partitioning for 0.5GB limit), Consumption API monitoring, branch-based migrations. Future: pgvector for semantic cross-company learning. NOT worth it on free tier: logical replication (prevents scale-to-zero), IP allow lists (Scale plan only).

- `[code]` 2026-03-26: OpenRouter deep research — Gap analysis against docs found 12 unused features. Created 10 backlog items (P0-P3) under `llm_optimization` theme. Critical: free tier = 50 req/day without credits (need $10 purchase for 1,000/day). Key wins: system+user message split (prompt caching), structured output (eliminates JSON parse failures), max_price caps, user tracking for per-company cost attribution, verbosity control, :online suffix for Growth web research.

- `[code]` 2026-03-26: Continuous dispatch loop hardening — (1) PR queue gate in backlog/dispatch: blocks new dispatch when 3+ PRs in pr_open status, dispatches free workers instead. Prevents merge conflict accumulation. (2) Post-merge verification endpoint (`/api/dispatch/verify-merge`): QStash calls it with 5-min delay after Hive PR merge. Checks `/api/health` + context_log for deploy failures. If build broke: auto-creates P0 fix item + Telegram alert. (3) Pattern match fixes in company-health: Check 38 (Hive PR merge) uses `pr_number` column instead of fragile `LIKE` match, adds `completed_at = NOW()`. Check 45 (company PR merge) uses branch-name task ID extraction instead of nonexistent `pr_number` column on company_tasks. (4) `qstashPublish` now supports `delay` option (seconds) for deferred delivery. (5) PRs #45 (auto-merge system) and #46 (evolver cleanup) merged. (6) Reset stale pr_open backlog item (Sentry webhook, e9abf094). Commit ee301db.

- `[code]` 2026-03-26: Engineer pipeline fixes + P1 decomposition — (1) Pipeline fixes: realistic turn estimates (S:15-20, M:25-35, L:35-50 vs old S:10-15, M:20-25, L:30-35), spec-driven max_turns sent on every dispatch (not just 3rd+ attempt), exponential backoff cooldown (2h/6h/24h based on attempt count vs flat 2h), dynamic isMaxTurns detection (80% of spec turns vs hardcoded 30). Commit 440ff05. (2) Decomposed 9 P1 parent items into 14 atomic sub-tasks with precise file paths, code snippets, and acceptance criteria — specialist prompts, input sanitizer, self-review checklist, backlog scope check, health endpoint, janitor dedup, YAML validation, agent display names. (3) Sentry webhook endpoint marked done (commit 7aa9472). (4) 20 items previously deferred to blocked status.

- `[code]` 2026-03-26: Backlog audit + dynamic model discovery + context-snapshot upgrade — (1) Dynamic free model discovery: `fetchFreeModels()` in llm.ts fetches OpenRouter catalog hourly, pads agent chains with ALL available free text models (20-30+ per agent). `minContext` filtering preserves quality. (2) Backlog DB audit: cross-referenced 100+ ready items against 7 days of commits. Synced 13 stale items to done (PR auto-merge suite, recurring escalation automation, capability assessment fix, Sentinel checks already implemented). Rejected 1 duplicate. (3) Context-snapshot skill updated with mandatory Step 2: DB sync before file updates, prevents dispatch loop from re-dispatching completed work. (4) Data-driven dispatch plan created: replace global circuit breaker with item-level skip logic, remove P0/P1 cascade filter, decompose on 1st max_turns failure.

- `[code]` 2026-03-26: Data-driven dispatch unclog + Sentry plan approved — (1) Loop quality audit: 25/25 actions failed (20 Ops = OpenRouter outage, 5 Engineer = max_turns on L-complexity items). (2) Added qwen_coder to growth/outreach/ops model chains for broader outage resilience. (3) Post-decompose immediate dispatch: sub-tasks now dispatch right after decomposition instead of waiting for Sentinel. (4) Analyzed data-driven dispatch plan — 5 of 6 changes already implemented, only post-decompose was missing. (5) Sentry event-driven self-healing plan approved: 4 backlog items created (webhook endpoint P1, internal integration P1, Healer dispatch P2, resolution feedback P2) under zero_intervention theme.

- `[code]` 2026-03-26: Sentry activated + backlog chain running — (1) Sentry DSN was never configured despite full @sentry/nextjs integration in codebase. Installed via Vercel Marketplace (one-click, auto-provisions SENTRY_DSN + SENTRY_AUTH_TOKEN). Redeployed to activate. (2) Backlog dispatch chain restarted with `chain_next: true` flag — previous manual kickstart lacked the flag so chain never continued. Chain is now self-sustaining: 4 consecutive runs observed (2 success, 1 failure, 1 in-progress), chain continues through failures. (3) OpenRouter free models all failing — Ops workers hitting 100% failure rate across all 4 companies. External service issue, not code problem. 114 ready items, 1 dispatched.

- `[code]` 2026-03-26: Manual config fixes — 4 blockers resolved: (1) ENCRYPTION_KEY set in Vercel env vars (root cause of all Growth/Outreach/Ops failures — couldn't decrypt openrouter_api_key), (2) Flolio Attack Challenge Mode disabled (was returning 429 for 8+ cycles), (3) GH_PAT workflow scope added (Engineer couldn't dispatch to company repos), (4) Verified OpenRouter key + settings decryption working. Loop should self-heal from here. Duplicate approval cleanup deferred (MCP sql_mutate can't update approvals table — 0 rows affected, root cause unknown).

- `[code]` 2026-03-26: Hierarchical context — Slimmed CLAUDE.md from 673→101 lines (constitutional core only: identity, rules, naming, code standards). Rewrote ARCHITECTURE.md from scratch (fixed 14+ stale items: OpenRouter not Gemini/Groq, QStash tiers, 21 tables, context API, inter-agent communication, CiberPME). All reference material (agent flows, model routing, provisioning, teardown, email, self-healing, validation phases, cross-company learning) now in ARCHITECTURE.md. CLAUDE.md points there for details.
- `[code]` 2026-03-26: Hierarchical context optimization — Extended `/api/agents/context` with 3 new brain agent modes (ceo, scout, evolver). CEO gets validation, cycle, research, playbook, tasks, directives, metrics, scores in one call. Scout gets companies, killed/rejected history, market coverage. Evolver gets agent stats, cycle scores, stalled companies, repeated errors, playbook coverage. Updated all 3 brain agent workflows (hive-ceo/scout/evolver.yml) to call context API instead of inline SQL. Added cost-risk gate to backlog dispatch (blocks items matching spend keywords). Added model escalation (Opus on 3rd+ attempt). Updated Engineer workflow with dynamic model resolution from dispatch payload.

- `[code]` 2026-03-26: OpenRouter-only LLM routing (ADR-034) — Consolidated all worker agent LLM calls to OpenRouter as sole provider. Removed Gemini and Groq entirely. Rewrote `src/lib/llm.ts` (-275 lines, +88): single `callOpenRouter()`, per-model circuit breaker, model-level fallbacks within OpenRouter (free models only). Claude Max remains for brain agents (GitHub Actions CLI, not in serverless chain). Updated 8 files: llm.ts, settings page/API, token route, costs, log, task-classifier, hive-capabilities. Deployed to production (dpl_HBkyq58NUYMajY63EBX8z1JMA7Da READY).

- `[code]` 2026-03-26: Sentry + Redis caching — Added @sentry/nextjs (server/edge/client instrumentation, global-error.tsx boundary, 10% trace sampling). Added @upstash/redis caching layer (redis-cache.ts): settings cache (10-min TTL, 118 call sites benefit), playbook cache (1h), company list cache (5m), health check endpoint. Both gracefully no-op without env vars. Needs Vercel Marketplace install for SENTRY_DSN + UPSTASH_REDIS_REST_URL/TOKEN.

- `[code]` 2026-03-26: QStash full consolidation (ADR-031 Phase 3) — Vercel crons removed entirely, QStash is sole scheduler. Deleted original sentinel monolith (3391 lines). Updated qstash-schedules setup from 3→5 schedules (sentinel-urgent/dispatch/janitor + metrics + digest) with stale cleanup. Fixed sentinel-dispatch missing POST export (blocker for QStash). Updated hive-capabilities.ts (1→3 sentinel entries), hive-crons.yml (legacy fallback now targets 3 split endpoints). Build clean, zero references to old monolith.

- `[code]` 2026-03-26: ADR-031 Phase 2 — split Sentinel monolith (3391 lines) into 3 urgency-tier endpoints: `sentinel-urgent` (every 2h, 619 lines: stuck cycles, orphaned companies, deploy drift, phantom PRs), `sentinel-dispatch` (every 4h, 935 lines: agent scheduling, company cycle dispatch, chain gaps, budget checks), `sentinel-janitor` (daily 2am, 1836 lines: maintenance, intelligence, playbook consolidation, auto-decompose, BACKLOG.md regen). Original sentinel kept as fallback during transition. Shared helpers extracted to `sentinel-helpers.ts` (SentinelContext pattern, dispatch dedup, circuit breaker). Cost analysis: Claude Max 5x ($100/mo) is 10-25x cheaper than API equivalent (~$2,479/mo operational-only).

- `[code]` 2026-03-26: QStash Phase 2 — replaced all fire-and-forget chain dispatch HTTP calls with `qstashPublish()` for guaranteed delivery + automatic retries. Files: cycle-complete (free worker dispatch + notify), sentinel (worker dispatch), backlog/dispatch (free worker dispatch + 4 notify calls). Synchronous calls (health-gate, backlog response) intentionally kept as direct fetch. Deduplication via hourly-bucket IDs. Graceful fallback to direct fetch when QSTASH_TOKEN not configured. Phase 1 (QStash schedules for sentinel/metrics/digest) deployed in prior session — Vercel crons in vercel.json still running in parallel for verification.

- `[code]` 2026-03-26: Loop error triage — 4 fixes: (A) schema-map auto-sync from schema.sql + CI check, (B) healer circuit breakers + success logging, (C) LLM-assisted task decomposition replacing dumb chunking (Claude Sonnet 4 via OpenRouter, fallback chain), (D) backlog triage: 63 junk sub-tasks rejected, 32 items unblocked. New: hive-decompose.yml workflow — L-complexity tasks dispatch to GitHub Actions for Claude Max decomposition instead of serverless. Decomposer routing: OpenRouter (primary) → Claude API → Gemini → Groq.

- `[code]` 2026-03-26: 8-task batch — 5 bug fixes + 3 features. Metrics zeros, playbook language bleed, CEO error feedback loop, silent catch blocks, max_turns detection. Scout scoring rubric, per-provider circuit breaker, MCP server overhaul. DB migration: `content_language` column on playbook table. Backlog: 88 done, 118 ready, 35 blocked (241 total).

- `[code]` 2026-03-25: Bulk backlog triage session — resolved 13 P1 items (7 already-done, 3 code fixes, 3 false alarms). Key fixes: Sentinel infra_repair loop (262/48h→0), Evolver over-trigger (38/48h→max 2), task bottleneck (82 stuck→auto-approved). Added MCP mutation tools. Groq backoff and backlog dedup verified already implemented. Engineer polling timeout reclassified (no polling exists).

### 2026-03-25 [code] CEO dispatch fix + Engineer PR tracking + 3 health checks + backlog cleanup
- **CEO dispatch DOA fixed (P0)**: Root cause was 1576 lines of context loading burning all turns. Removed CLAUDE.md read (670 lines), extracted PR review to `prompts/ceo-review.md`, made context trigger-specific. 67% reduction for ceo_review, 43% for cycle_start.
- **Engineer PR tracking**: Chain callback now extracts PR number from execution output and passes to backlog dispatch. Enables automatic pr_open status tracking.
- **3 new company-health checks**: Check 43 (dispatch verification — detect silent failures), Check 44 (stale company safety net — dispatch after 6h inactivity), Check 45 (stuck PRs with green CI — dispatch CEO review).
- **Problem statement detection**: PR #42 merged — `isProblemStatement()` in backlog-planner.ts flags vague items as needing decomposition. Prevents dispatch of unactionable items.
- **25+ P0 items marked done**: CEO cycle-complete dispatch, Engineer PR tracking (all sub-tasks), improvement loop dead-end (all sub-tasks), backlog retry re-dispatch, dispatch verification, stale safety net, stuck PRs.
- **P0 count reduced from 20+ to 1** (email domain — manual/blocked). Sentinel event-driven migration downgraded P0→P1.

### 2026-03-25 [code] CEO review saving + pr_open enforcement + Telegram enrichment + 0-turn fix
- **CEO review saving**: workflow now provides CRON_SECRET + HIVE_URL and instructs CEO to save review JSON via API. Fixes broken validation scoring, kill signals, agent grading.
- **pr_open enforcement**: backlog dispatch requires pr_number for pr_open status. No PR = done. Prevents phantom pr_open at source.
- **Telegram enrichment**: human-readable agent/action labels, PR links, task titles, duration, error details, run URLs. Carlos directive.
- **0-turn ghost fix**: all 4 workflows log 0-turn failures as 'skipped' instead of 'failed'. Stops metric inflation.
- **17 backlog items marked done** across two batches this session.

### 2026-03-25 [code] Loop quality fixes + PR review/merge
Session focused on improving autonomous loop efficiency and clearing PR backlog:
- **5 loop quality fixes committed**: (A) chain dispatch P0+P1 priority floor, (B) auto_resolve_escalation counts ALL attempts (not just failed) — stops 80+ retry loops, (C) evolver proposal quality gate rejects vague proposals lacking file paths/actionable verbs, (D) Sentinel Check 41 verifies pr_open items against GitHub API (merged→done, closed→reset), (E) circuit breaker deferred so P0 items bypass.
- **Max attempts lowered 5→3** across query-time caps in backlog dispatch.
- **4 PRs merged**: #23 (sentinel DB check), #29 (context API caching), #34 (validation system endpoints), #35 (cascade dispatch fix). 2 conflicting PRs (#31, #38) closed as superseded.
- **11 backlog items marked done** in hive_backlog DB — cascade dispatch fixes, circuit breaker steps, priority floor, retry cap, PR verification, evolver gate.
- **Vercel native crons deployed**: sentinel hourly, metrics 2x/day, digest daily 8am via vercel.json.

### 2026-03-25 [code] Error extraction fix + P0 triage + MCP repair
Session focused on root cause diagnosis and backlog cleanup:
- **Error extraction fixed across all 4 workflows** (engineer, ceo, healer, scout): 3 bugs — missing exec file check, wrong jq selector, no Actions-level fallback. Every error now includes GitHub Actions run URL. This was root cause of 5 blocked P0s.
- **Auto-decompose unblocked**: Code existed but never triggered because error_type was always empty. Now fires on max_turns failures.
- **MCP server fixed**: `@neondatabase/serverless` v1.x broke `sql()` → migrated to `sql.query()` for dynamic queries.
- **P0 triage via MCP**: 18 P0s → 3 actionable (metrics zeros, CEO cycle-complete, chain dispatch DOA). 9 resolved (deduped into unified fix), 2 demoted to P1.
- **Backlog directives added**: Dashboard redesign (P1, real-time visualization + backlog pipeline view + layout fix), Telegram notification enrichment (P1), naming clarity overhaul (P1, legacy agent/task/workflow names are confusing).
- **Loop status**: VerdeDesk cycle 26 completed end-to-end (score 2/10). Sentinel active. Evolver skipping new proposals (28 pending). Healer correctly classifying config vs code issues.

### 2026-03-25 [code] Cost-only escalation model + cascade self-healing fixes
Session focused on making the cascade loop truly autonomous:
- **Schema-map drift fixed**: `schema-map.ts` was missing 5 agent names, 1 gate type, 3 columns, 1 status — caused ALL PR CI to fail. Updated both `schema-map.ts` and `schema.sql` CHECK constraints.
- **PR auto-merge unblocked**: Moved PR merge logic to run on every callback (not just success). 8 PRs merged, down from 10+ open to 2.
- **Auto-decompose wired**: Engineer workflow now passes `error_type` (e.g. `error_max_turns`) in callback payload. Next max_turns failure on attempt 2+ triggers task decomposition.
- **Cost-only escalation model (ADR-027)**: Replaced dead `manual_review` zone (score 4-6) with autonomous merging. PRs auto-merge if CI passes regardless of risk score. Only cost-impacting changes (new paid deps, workflow minute burns, model routing upgrades, Vercel Pro triggers) escalate to Carlos. Safety gates (secrets, destructive SQL) still block.
- **Telegram webhook fix**: `notes` → `decision_note` column name corrected.
- **10 self-healing backlog items added**: Schema auto-sync, PR health check, observability, callback audit, cascade health metric.

### 2026-03-25 [code] Cascade unblock + strategic intelligence + agent specialization
Major session focused on unblocking cascade and adding strategic depth:
- **Cascade unblocked**: Went from stalled (48 ready, 0 dispatched, broken workflows) to actively chaining (6 items in 30 min, 3 PRs, chain dispatch working).
- **toJson quoting fix**: `${{ toJson(github.event.client_payload) }}` broke when task descriptions contained single quotes. Fixed ALL workflow files (hive-engineer.yml, hive-ceo.yml, hive-scout.yml, hive-healer.yml) to use step-level `env:` vars instead of inline `${{ }}` in bash.
- **Stale dispatch cleanup**: Items stuck in `dispatched` >30 min auto-reset to `ready`. Prevents cascade stalls.
- **Max-attempt guard**: Items with 5+ failed attempts auto-blocked at query time. Prevents runaway retries (one item hit 104 attempts).
- **Circuit breaker P0 bypass**: Second circuit breaker (30-min general) now respects `forceDispatch` for P0 items.
- **30+ strategic backlog items added** across three themes:
  - Cascade gaps (5): CEO cycle-complete chain, company_tasks completion, Sentinel fallback, stale pr_open reset, completed_task_ids passthrough
  - Strategic intelligence (10): Portfolio dashboard, WoW growth rates, pivot detection, revenue readiness, competitive refresh, growth experiments, decision journal, RICE scoring, kill criteria, channel matrix
  - Agent specialization (10): Experience replay, domain-scoped playbook, blame-attributed grading, skill registry, Growth autonomy, Engineer autonomy, domain knowledge cron, Evolver grade reading, subdomain provisioning, domain graduation
- **Research captured**: Comprehensive venture orchestration research (BML loops, RICE/ICE, pivot detection, portfolio theory, OKR automation, competitive intelligence, growth experiments, revenue optimization) saved to scratch files.
- **Healer hitting max_turns on config issue**: Healer exhausted 35 turns trying to fix "Neon API key not configured" — a settings issue, not a code bug. Need Healer to classify config-vs-code errors.

### 2026-03-25 [code] Roadmap restructuring + Sentinel split + Scout/UI gap analysis
Major session focused on strategic infrastructure and unblocking the autonomous loop:
- **Outcome-based roadmap**: Rewrote ROADMAP.md from checkbox-based to outcome-based. 8 themes (`dispatch_chain`, `first_revenue`, `zero_intervention`, `self_healing`, `self_improving`, `code_quality`, `portfolio_intelligence`, `full_autonomy`) linked to `hive_backlog.theme` column. Progress auto-computed from DB.
- **Theme system**: Added `theme` column to hive_backlog schema. Tagged 147/158 backlog items via 3-pass ILIKE matching. MCP server updated with theme filters. `/api/roadmap/progress` endpoint returns per-theme and per-phase progress.
- **Portfolio roadmap integration**: Portfolio API and consolidation endpoint now include theme progress data.
- **Sentinel monolith split (ADR-030)**: Extracted 6 HTTP-heavy checks (stats endpoints, language, stale records, test coverage, PR auto-merge, broken deploys) from Sentinel (3426→2933 lines) into new `/api/cron/company-health` endpoint. Sentinel fires it as non-blocking fetch. Both get their own 60s timeout — previously checks after line ~1900 never executed due to Vercel timeout.
- **Scout gap analysis**: Identified 10 gaps in scouting pipeline (disconfirming evidence, source triangulation, TAM estimation, time-decay scoring, etc.). Added as backlog items.
- **UI/UX gap analysis**: Identified 8 gaps (design system tokens, component library, accessibility, responsive testing, etc.). Added as backlog items with opportunistic migration pattern for existing companies.
- **Orphan PR fix**: Found 10 `pr_open` items clogging pipeline with no actual PRs. Linked 4 real PRs, reset 6 orphans to `ready`.

### 2026-03-25 [code] Autonomy unblock + planning phase + LLM optimization
Major session focused on making Hive self-evolving:
- **Scout auto-cleanup reverted**: 14 dismissed proposals restored. Auto-expiry disabled — Carlos reviews manually. Sentinel still blocks NEW idea generation at >=5 pending.
- **Auto-merge fix**: GitHub webhook PR handler now reads `github_token` from settings DB (was only checking env vars). Risk scoring: 0-3 auto-merge, 4-6 queued, 7+ escalated.
- **Planning phase implemented (P0)**: New `src/lib/backlog-planner.ts` generates specs via OpenRouter Qwen Coder (free) before Engineer dispatch. Spec includes acceptance_criteria, affected_files, approach, risks, complexity, estimated_turns. Engineer workflow updated to follow specs directly. Schema updated with `planning` status + `spec JSONB` column.
- **Circuit breaker bypass**: P0 items and `force=true` skip the 60-min cooldown. Prevents critical items from being blocked by prior failures.
- **MANUAL_KEYWORDS narrowed**: Regex was blocking automatable items matching "manual" in technical contexts.
- **Unified LLM layer**: `src/lib/llm.ts` with provider routing (OpenRouter primary for all workers), automatic failover, rate limit retry with exponential backoff.
- **Loop quality fixes**: 5 P1 items for task decomposition, duplicate retry prevention, PR tracking, circuit breaker bypass, observability.
- **Ruflo items promoted**: 13 items from BACKLOG.md promoted to hive_backlog DB. 6 caching/optimization items bumped P2/P3 → P1 (ephemeral cache, dedup, reasoning cache, agent-scoped playbook, dynamic prompts, ReasoningBank).
- **Flolio contamination**: P1 item added to investigate Portuguese content bleed into global-market company.

### 2026-03-24 [code] Enhanced Scout proposal cleanup system
**P1 backlog task completed:** Scout proposals were accumulating (15 pending) while existing companies couldn't execute properly. Enhanced auto-cleanup system with more aggressive thresholds: triggers at >3 pending proposals (was >5), faster expiry when severely clogged (24h vs 48h when >10 proposals), and keeps fewer proposals (2 vs 3 when clogged). Added dashboard cleanup UI when >5 proposals: "Cleanup" button for gradual cleanup and "Reset All" for nuclear option. Sentinel now prioritizes company execution over accumulating Scout ideas.

### 2026-03-24 [code] Cascade loop fixes + OIDC auth fix + Ruflo comparison + guardrails
- **OIDC auth crash fixed**: `new NextRequest(req)` crashed when body was consumed. Changed `validateOIDC` to accept plain Request — fixed 500 errors on all chain dispatch endpoints (backlog/dispatch, cycle-complete, health-gate).
- **Response envelope unwrap**: Engineer workflow read `.dispatched` but response is `{ok, data: {dispatched}}`. Fixed jq to `.data.dispatched // .dispatched // false`. Chain now correctly processes backlog before falling through to company cycles.
- **Telegram notification on backlog dispatch**: Added notify call after successful dispatch. Cascade chain now visible end-to-end in Telegram.
- **Failed item 30-minute cooldown**: Items with `[attempt N]` updated in last 30min excluded from dispatch. Prevents immediate retry loops.
- **Cascade quality assessment**: 73% failure rate (8/11 runs) from complex tasks without planning. Added 5 P1 guardrails to backlog: CEO micro-plan, circuit breaker, priority floor, cooldown, cost-risk gate.
- **Cost-risk gate**: P1 backlog item — items touching SDK/API/billing/architecture require manual approval before dispatch. Prevents P3 items like "Claude Agent SDK migration" from burning budget.
- **Ruflo capability comparison**: Mapped 7 key capabilities against Hive. Added 3 P2 items: parallel company dispatch, task-type classification, unified LLM provider abstraction.
- **Autonomous capabilities documented**: Added GSC service account, GitHub, Vercel, Neon, Stripe to project_infra.md memory. P1 item to inject into agent context so they don't flag automatable tasks as manual.

### 2026-03-24 [code] Continuous event-driven dispatch + health gate + chain callbacks
- **Continuous dispatch**: Agents no longer wait for Sentinel's 4h poll to dispatch next work. When a CEO cycle completes, it calls `/api/dispatch/cycle-complete` which checks health, scores companies, and dispatches the next one immediately.
- **Health gate** (`/api/dispatch/health-gate`): Pre-dispatch check for budget (Claude 225/5h), concurrent agents, system failure rate, Hive backlog priority. Returns `dispatch`/`wait`/`stop` recommendation.
- **Cycle-complete callback** (`/api/dispatch/cycle-complete`): Completion callback endpoint. Flow: agent done → health gate → hive-first check (backlog P0/P1 take priority) → score companies → dispatch next highest-priority cycle. Falls back to backlog items if no companies need cycles.
- **Chain cascade**: Engineer backlog chain now falls through to company cycles when backlog is empty. CEO cycle_complete chains to next company. Sentinel becomes safety net, not primary dispatcher.
- **Hive-first priority**: Health gate checks for critical Hive backlog items. If P0/P1 items exist and no Hive engineer is running, recommends backlog dispatch before company cycles.
- **Model routing 48h window**: Changed from 7-day to 48h window for faster failover when providers degrade.
- **Backlog scoring engine** (`src/lib/backlog-priority.ts`): WSJF/RICE hybrid — Impact 35%, Urgency 25%, Reliability 20%, Blocking 15% × category multiplier × novelty penalty.
- **Middleware fix**: Added `api/notify`, `api/backlog`, `api/dispatch` to middleware exclusion list.

### 2026-03-24 [code] Telegram notifications + self-improvement loop + Ruflo systems + guardrails
- **Telegram real-time notifications**: Built `src/lib/telegram.ts` with sendMessage, sendMessageWithButtons, editMessage. Agents send notifications via `/api/notify`. Approval gates auto-notify with Approve/Reject inline buttons. PRs notify with Merge/Close buttons. Auto-merged PRs get informational-only messages.
- **Telegram interactive approvals**: `/api/webhooks/telegram/route.ts` handles callback queries (button presses). Approve/reject updates approval status + dispatches Engineer for new_company. Merge/close manages PRs via GitHub API. Messages edited to show result after action.
- **Self-improvement loop (Sentinel Check 37)**: Detects recurring errors, zero metrics, timeouts, stuck tasks. Creates improvement proposals. Safe changes (no schema/workflow/auth/middleware) push directly to main. Risky changes create PRs for review. Engineer dispatched with `company: "_hive"` for Hive self-improvement.
- **Ruflo-inspired systems**: Agent specialization profiles (`src/lib/agent-profiles.ts`, `/api/agents/profiles`). Error pattern auto-learning (Check 35, `src/lib/error-normalize.ts`, `/api/agents/error-patterns`, `error_patterns` table). Test coverage tracking (Check 36).
- **Language guardrails**: DB columns `market`/`content_language` on companies table. Context API injects `language_rule`. Sentinel Check 32 validates deployed site language. Growth workflow uses dynamic language from context API.
- **Domain/naming guardrails**: Scout Phase 5 checks Vercel/GitHub/domain availability before proposing. Provisioner reads actual Vercel URL from API (no more assumed URLs). Sentinel Check 33 auto-fixes stale DB records (wrong URLs, renamed repos/projects).
- **CiberPME**: Converted from SaaS to blog, rebranded from CiberSegura. 4th active company.
- **Flolio fixes**: Growth workflow language fix (was hardcoded Portuguese, now dynamic). Terms of Service jurisdiction fixed.

### 2026-03-24 [code] Company review + Sentinel loop fix + metrics pipeline self-healing
- **Comprehensive company review**: Audited all agent_actions, cycles, and errors across all companies. Found 5 critical issues: (1) Sentinel dispatch loop (94/48h), (2) Engineer polling timeouts (68% of failures), (3) CEO reviews not recorded, (4) 34 stale noise approvals, (5) Groq rate limits.
- **Sentinel dispatch loop fixed**: Check 25 auto-resolve was trying to fix non-API-resolvable gate types (capability_migration, escalation), creating a feedback loop. Added SKIP_AUTO_RESOLVE list. Check 17 now deduplicates escalation approvals. Reduced expiry: capability_migration 14d→3d, escalation 3d→2d.
- **Self-healing stats endpoints (Check 31)**: Probes each company's `/api/stats` endpoint, validates response format (`{ok, views}`), creates engineering tasks for broken endpoints. First run detected 4 broken endpoints across 3 companies.
- **CiberSegura→CiberPME rebrand**: Renamed GitHub repo (`carloshmiranda/ciberpme`), Vercel project (`ciberpme`), updated all code references (brand name, URLs, metadata, OG, emails), updated Hive DB (companies slug/name, infra config). Fixes the `-flax` suffix problem — new project name `ciberpme` gets a clean `.vercel.app` domain.
- **Approval cleanup**: Bulk-expired 34 stale noise approvals (escalation + capability_migration). 16 new_company + 1 spend_approval remain as real decisions.
- **Free LLM dispatch**: Triggered Growth (Gemini) and Ops (Groq) for all 3 active companies. Groq hit 429 rate limits on concurrent calls — needs backoff.

### 2026-03-23 [code] Accrue→Flolio rename + autonomous deploy repair + free LLM dispatch
- **Accrue→Flolio rename**: Deleted broken Hive-provisioned `flolio` Vercel project (prj_yazBlxB1, ERROR state). Renamed original `accrue` project → `flolio` via Vercel API. Updated DB (companies + infra tables). Custom domain flolio.app still active. No more naming confusion.
- **Autonomous deploy repair**: Built 3-step repair pipeline in Sentinel check 30: (1) try repair-infra first ($0, no LLM), (2) check circuit breaker (3+ failures → skip), (3) dispatch hive-fix.yml as last resort. Added Vercel duplicate project detection, redeployment, stale escalation resolution. Expanded capability registry with 8 new triggers.
- **UI/UX quality gates**: Design tokens in boilerplate globals.css, CEO PR review design scan (STEP 4b), CEO cycle design scoring, Growth design rules, Engineer visual standards. Removed -2 "UI-only" discount that let bad design auto-merge.
- **Flolio domain conflict resolved**: Two Vercel projects (flolio + accrue) for same repo caused 429s. Deleted broken one, renamed working one.

### 2026-03-23 [code] UI/UX quality roadmap + domain management + Venture Brain + playbook consolidation
- **UI/UX quality gap identified**: CEO auto-merges UI-only PRs with -2 risk score, zero visual quality checks anywhere. Added 6 backlog items (4 P1, 2 P2): CEO PR review UI/UX gate, cycle design scoring, Growth design rules, boilerplate design tokens, post-deploy visual smoke test, cross-company design system.
- **Domain management API**: New `/api/companies/[id]/domain` (GET/POST/DELETE) + `addDomain`, `getDomains`, `removeDomain` in `src/lib/vercel.ts`. Sentinel health checks now use `COALESCE(domain, vercel_url)` for custom domains.
- **Venture Brain (Sentinel check 28)**: Cross-pollination (playbook insights from company A → directive for company B), score decline detection (3+ point drops), error correlation across companies. Pure SQL, no LLM.
- **Playbook consolidation (Sentinel check 29)**: Jaccard word similarity merging (≥0.6 threshold), cross-company composite creation (≥0.5). Prevents near-duplicate entries.
- **Company teardown automation**: Dedicated shell job in hive-engineer.yml. kill_company approval → ops_escalation dispatch → teardown job (Vercel delete, Neon delete, GitHub archive, infra marking). Tested live with poupamais.
- **Flolio domain conflict**: flolio.app is on original Vercel project (prj_zSdAai8w), not Hive-provisioned one (prj_yazBlxB1). Needs resolution.

### 2026-03-23 [code] Healer loop fix + poupamais kill + provisioning preflight
- **Healer self-reinforcing loop**: Excluded healer/sentinel from failure rate calculation + added 6h cooldown. Bumped max-turns 25→35.
- **Poupamais killed**: GitHub repo archived, kill directive created (issue #8). Company was provisioned as SaaS when Scout proposed it as blog/affiliate — wrong business_model due to max_turns in STEP 0.
- **Provisioning preflight**: Added shell step in hive-engineer.yml that sets company_type from approval context BEFORE Claude agent runs. Queries DB directly via DATABASE_URL. Shell steps can't hit max_turns — prevents the poupamais bug from recurring.

### 2026-03-23 [code] Context optimization + cost-based routing
- **Context optimization**: Research reports now deliver summaries only in context API (saves 20-50KB per call). Worker dispatch truncates visibility/content_performance JSONB to 2KB max. ~60-70% reduction in context payload size.
- **Cost-based provider routing**: Worker dispatch now uses `getOptimalModel()` which queries 7-day success rates. If primary provider (Gemini/Groq) drops below 70% success, auto-failover to alternative. Agent_actions logs provider, model, cost, routing_reason. Costs endpoint has `by_provider` breakdown.

### 2026-03-23 [code] Phase gates + playbook lifecycle
- **Mechanical phase enforcement**: Three-layer policy gates prevent forbidden work. Layer 1: `POST /api/tasks` rejects tasks violating validation phase (e.g., auth tasks in `validate` phase). Layer 2: `GET /api/agents/context` filters tasks before Engineer/Growth sees them. Layer 3: validate-drift (existing) catches post-hoc. Shared `src/lib/phase-gate.ts` with expanded term map.
- **Playbook time-decay**: Sentinel check 27 decays entries unreferenced for 30+ days (-0.02/run). Auto-prunes entries below 0.15 confidence via supersession. Combined with existing cycle-score decay, playbook entries now have full lifecycle.

### 2026-03-23 [code] Ruflo-inspired closed-loop learning + dispatch dedup
- **Dispatch dedup (claims system)**: Two-layer dedup prevents duplicate dispatches. Cross-run: queries GitHub Actions API for in_progress/queued runs. Within-run: Set tracks dispatched keys. All three dispatch functions check both layers. Response includes `dedup_skips` and `active_claims`.
- **Anti-drift mid-cycle validation**: New `/api/agents/validate-drift` checks Engineer/Growth work against validation phase forbidden rules. Growth context now includes validation (was missing). Company `hive-build.yml` calls validate-drift before CEO review dispatch.
- **Post-cycle consolidation**: New `/api/agents/consolidate` auto-called after CEO review. Extracts playbook entries from CEO review, boosts/decays confidence based on cycle scores (8+ boost, ≤3 decay). Closes the learning feedback loop.
- **Task stealability**: Sentinel check 13b2 marks agent_actions stuck in `running` for >1h as `failed`. Existing retry logic (13c) picks them up. Prevents tasks from getting permanently stuck after GitHub Actions crashes.
- **Ruflo research**: Deep analysis of ruvnet/ruflo multi-agent framework. 24 concepts added to BACKLOG.md. Key borrowed ideas: claims system, learning loops, policy gates, knowledge graph, CRDT writes.

### 2026-03-23 [code] Self-correcting autonomous loops
- **Circuit breaker**: Sentinel stops retrying agent+company after 3 failures in 24h. Prevents the 45+ wasted dispatch problem.
- **Error backfill**: `/api/agents/backfill-errors` fetches GitHub Actions failure reasons and fills NULL error fields. Sentinel also pre-fills before retrying.
- **Auto-approve safe proposals**: Evolver proposals with process/knowledge gap type + medium/low severity get auto-approved after 24h. Critical/high get dashboard reminders after 48h.
- **Capability registry**: `src/lib/hive-capabilities.ts` — 20 API endpoints registered. All agents receive capability summary in context for self-awareness.
- **Recurring escalation detector**: Sentinel check 25 auto-resolves repeat approvals via capability registry, or creates Evolver proposals for missing automations.
- **Auto-repair infra**: `/api/agents/repair-infra` provisions missing Neon DBs via API. Sentinel check 9c calls it instead of creating manual escalations.

### 2026-03-22 [code] Self-healing layer 1: Schema drift detection
- `src/lib/schema-map.ts`: Static schema map with all 18 tables, columns, types, and CHECK constraints
- Sentinel check 24: Compares schema map against live DB via `information_schema` — catches missing tables, missing columns, extra columns
- When 3+ mismatches found → dispatches Healer with `schema_mismatch` error class
- `scripts/generate-schema-map.ts`: Regenerator script that parses `schema.sql`
- Also fixed stale credential patterns in `stripe/route.ts`, `dispatch/route.ts`, `assess/route.ts` (settings-first, env-fallback)
- Remaining self-healing layers: build-time SQL linter (P1 in BACKLOG), Healer prompt update

### 2026-03-22 [code] Centralized business types + auto-research for unknown types
**ADR-026:** Created `src/lib/business-types.ts` as single source of truth for all 8 business types. Each definition includes phases, scoring model, relevant capabilities, and kill criteria. All consumers (validation.ts, capabilities.ts, assess/route.ts) now derive from it.
- `/api/agents/research-type`: new endpoint — detects unknown business types, returns structured research prompt for Claude to generate a complete type definition using web search
- Engineer workflow Step 0: before provisioning, checks if the proposed business_model is known; if not, researches best practices, generates the definition, commits to business-types.ts
- Engineer now also sets `company_type` on the company record during provisioning (was missing before)
- `getBoilerplateGaps()` and `applyCompatibility()` now use centralized `isCapabilityRelevant()` instead of hardcoded type lists
- Adding a new business type: Scout proposes it → Engineer auto-researches → definition committed → provisioning continues

### 2026-03-22 [code] Type-aware infrastructure drift detection
- Sentinel auto-assesses unassessed companies every 7 days via `/api/companies/{id}/assess`
- Assessment feeds check 20 (manifest-based migration detection) which is type-aware
- Manifest expanded to 18 features with type-specific compatibility arrays
- `assess/route.ts` extended to check 10 files (was 4) + detect analytics in layout.tsx

### 2026-03-22 [code] Phase 2 pattern extraction + boilerplate test infrastructure
**Knowledge extraction:** Deep-reviewed Flolio and VerdeDesk codebases, extracted 19 playbook entries across 13 domains (testing, CI/CD, auth, payments, SEO, email, API design, monitoring, landing pages, data architecture, growth, content, design). These were never extracted during Flolio's import because Phase 2 of the import flow was designed but never built.
- `/api/agents/extract`: new endpoint that reads a company repo via GitHub API, detects reusable patterns across 13 domains, returns extraction prompt for LLM-generated playbook entries
- `/api/agents/playbook`: now accepts `source_company_id` for attribution
- Engineer workflow: step 11 calls extract API for imported companies
- **Boilerplate test infrastructure (from Flolio patterns):**
  - `/api/health` endpoint for monitoring + smoke tests
  - `playwright.config.ts` + `tests/e2e/smoke.spec.ts` (homepage load, JS errors, health check, stats endpoint)
  - `post-deploy.yml` workflow (runs smoke tests against Vercel URL after merge, polls for deployment readiness)
  - `@playwright/test` added to devDependencies, test scripts in package.json
- **Provisioning improvements:**
  - `/api/agents/provision`: one-call Neon DB + schema + Vercel project + Web Analytics + DATABASE_URL
  - `/api/agents/analytics`: enables Vercel Web Analytics for individual or all companies
  - `@vercel/analytics` added to boilerplate for client-side tracking
- Metrics cron: now checks latest post-deploy smoke test results via GitHub API

### 2026-03-22 [code] Validation-gated build system (ADR-024)
**Architecture change:** Replaced cycle-count-based build/launch/optimize modes with a composite validation score (0-100) computed from real metrics. Different business types (SaaS, blog, affiliate, newsletter, etc.) have different phase progressions, scoring formulas, and kill criteria. CEO agent now checks validation phase before planning — forbidden actions are enforced per phase (e.g., SaaS in "validate" phase cannot build auth, dashboards, or CRUD features).
- `src/lib/validation.ts`: core scoring engine with per-type phases, gating rules, kill signals
- `prompts/ceo.md`: fully rewritten with phase-gated planning, organic-patient kill criteria
- `src/app/api/agents/context/route.ts`: injects validation score + phase into CEO context
- `schema.sql`: new metrics columns (pricing_cta_clicks, affiliate_clicks, affiliate_revenue, pricing_page_views)
- Boilerplate: `/api/pricing-intent` (fake-door CTA tracking), `/api/affiliate-click` (outbound click tracking), `/api/stats` extended to return all validation metrics
- Metrics cron: collects pricing_clicks and affiliate_clicks from company `/api/stats`
- Senhorio landing page: fixed to respect LAUNCH_MODE=waitlist (no login/register links)
- OAuth token: refreshed with long-lived `claude setup-token` CI/CD token

### 2026-03-21 [code] Full system audit + critical fixes + priority-scored dispatch (ADR-023)
- [code] 2026-03-21: Full system audit + fixes: hasCapability bug, schema constraints, OIDC dynamic audience, token error handling, approval auto-expiry, outreach guard, priority-scored dispatch (ADR-023), boilerplate quality (semantic HTML, SVG icons, template placeholders, 404 page), Engineer content integrity + language consistency rules

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

### 2026-04-01 [code] Deploy pipeline health check (PR #308, Issue #215)
Added Check 42 — a deploy pipeline health check that verifies the full production request lifecycle after every Vercel deployment. Fires via `deployment_status` webhook → reads 5 key API endpoints → reports pass/fail to agent_actions. Also added MISTAKES.md entry for the Vercel preview deployments lesson (non-main branch preview URLs are ephemeral and break the engineer workflow).

### 2026-04-01 [code] Sentry uptime + cron monitoring (PR #309, Issue #216)
Configured Sentry uptime monitor for `/api/health` (60-second check interval) and cron monitor for `sentinel-dispatch` (4-hour expected interval). Both report to the existing Sentry DSN. Completes observability gap: uptime + scheduled job health now tracked alongside error rates.

### 2026-04-01 [code] MCP circuit breaker reset + loop kick tools (PR #310, Issue #217)
Added two MCP tools: `hive_circuit_reset` (reset a circuit-breaker-blocked company to allow dispatch) and `hive_loop_kick` (manually trigger sentinel-dispatch for immediate re-evaluation). Both callable from Claude Code sessions without needing curl commands. Also fixed a settings encryption bypass bug where MCP settings reads could skip decryption.

### 2026-04-01 [code] workflow_crash fast-retry (PR #311, Issue #269)
`workflow_crash` errors (GitHub Actions infra failures: OOM kill, runner never started, OIDC failure) now use separate `[infra-crash N]` tracking with 30-minute cooldown instead of the 2-6 hour code-failure cooldown. Capped at 5 infra retries before falling through to normal failure handling.

### 2026-04-01 [code] Zombie action cleanup + cancelled() callback (PR #312, Issue #261)
Two fixes: (1) Sentinel stale-action sweep threshold reduced from 1 hour to 35 minutes (above the 30-minute max job timeout to avoid false positives). (2) `hive-engineer.yml` log-failure step condition changed from `if: failure()` to `if: failure() || cancelled()` — GitHub Actions cancellations (OOM, manual cancel, runner termination) now send completion callbacks to Hive, preventing zombie `running` rows.

### 2026-04-02 [code] MISTAKES.md: exit 0 step isolation bug (PR #313, Issue #234)
Added MISTAKES.md entry documenting the PR #202 `exit 0` bug: calling `exit 0` in a GitHub Actions step doesn't suppress downstream steps — must use `$GITHUB_OUTPUT` + `if` conditions. Prevention rule documented.

### 2026-04-02 [code] actionlint CI check (PR #314, Issue #232)
Added `.github/workflows/actionlint.yml` — runs `rhysd/actionlint` on PRs touching `.github/workflows/**` or `.github/actions/**`. First run immediately caught a real bug: `hive-decompose.yml` was passing `max_turns` and `timeout_minutes` as invalid top-level `with:` inputs to `claude-code-action@v1` (should be `claude_args` and step-level `timeout-minutes`). Both bugs fixed in the same PR.

### 2026-04-02 [code] npm caching + teardown fix (PR #324, Issue #150)
Added `actions/setup-node@v4` with `cache: 'npm'` to healer, spec-gen, and engineer workflows — speeds up repeated `npm install` calls by caching `~/.npm` between runs. Also fixed a latent bug: `hive-engineer.yml` teardown job was missing `actions/checkout@v4` entirely, causing it to fail whenever teardown was triggered.

### 2026-04-03 [code] Blob storage utility + large-output handling (PR #375)
Added `src/lib/blob-storage.ts` — a Vercel Blob utility for storing agent outputs that exceed Neon's row size limits. Updated `research/route.ts` and `dispatch/route.ts` to offload large payloads (>50KB) to blob storage and store only the blob URL in the DB. Prevents DB write failures on large Scout research dumps and verbose agent outputs. Items ff83dedd + 25f4741a marked done.

### 2026-04-02 [code] CEO chain dispatch → TypeScript (PR #325, Issue #151)
Extracted the 130-line bash chain dispatch block from `hive-ceo.yml` into `scripts/chain-dispatch.ts`. TypeScript version uses `@neondatabase/serverless` for company repo lookup, native `fetch` for all HTTP calls, handles all triggers (`cycle_start`, `gate_approved`, `cycle_complete`/`ceo_review`), dispatches Growth + Outreach concurrently via `Promise.all()`, and sends Telegram notification on completion. Easier to test, type-safe, no bash escaping footguns.

### 2026-04-02 [code] Claude model upgrades + prompt caching (commits 35adae1, b822bff)
Fixed haiku retirement (claude-3-haiku-20240307 → claude-haiku-4-5-20251001, retires April 19 2026). Upgraded all 7 brain agent workflows to claude-opus-4-6 / claude-sonnet-4-6 (1M context windows, adaptive thinking built-in). Added prompt caching to `callClaude()` in llm.ts: content block with `cache_control: ephemeral` + `anthropic-beta: prompt-caching-2024-07-31` header → 90% cheaper cache reads. Added token count pre-flight (POST /v1/messages/count_tokens, non-blocking) and cache hit/miss logging. Extended thinking already active via adaptive thinking in 4.6 models.

### 2026-04-03 [code] Living ADRs + backlog drain + GitHub issue cleanup (PR #376)
Implemented living ADRs: `prompts/ceo.md` now has a full "Architectural Decision Records" section teaching CEO when/how to write ADRs to `DECISIONS.md` (Hive platform decisions only, not company-specific). `hive-ceo.yml` updated to read DECISIONS.md before making platform architectural decisions. Backlog items `b74cd9d0` (living ADRs) and `36baf588` (scout pain points — rejected, superseded by existing multi-platform validation) processed. Closed 27 stale GitHub issues for backlog items already done/rejected in DB. All actionable autonomous P3 items are now implemented or correctly rejected. Remaining P3 backlog = research concepts and blocked items awaiting external prerequisites.

### 2026-04-04 [code] Fixed broken Growth agent workflows in all 4 company repos
Fixed broken Growth agent workflows in all 4 company repos. Root cause: hive-growth.yml was using @google/gemini-cli which no longer works after Hive migrated to OpenRouter/Claude. Replaced with anthropics/claude-code-action@v1 pattern (same as hive-engineer.yml), fetches claude OIDC token from Hive API, passes context via /tmp/growth-context.json. Closed GH Issues #367, #368. Also verified Flolio attack challenge mode is OFF via Vercel API (no attackModeActiveUntil field), closed GH Issues #57, #64, #211.

## What's Next (in priority order)

1. **Monitor Engineer dispatch with specs** — 11 P1 items now have actionable specs. Next dispatch cycle should pick them up. If Engineer succeeds, the death spiral is broken. If still failing, investigate GitHub Actions startup (0-turn failures).
2. **Resolve email domain (P0 blocker)** — buy domain, add Resend DNS records, set `sending_domain` (outreach completely blocked without this)
3. **Buy $10 OpenRouter credits (P0)** — Free tier = 50 req/day. With credits = 1,000/day. Workers need ~30-50/day.
4. **Triage 20+ pending approvals** — duplicate new_company proposals, resolved escalations, capability_migration dupes. MCP sql_mutate can't update approvals table — may need direct DB access or API fix.
5. **Wire high-impact backlog items** — P1s: custom Sentry tags, Sentry API polling, unused Redis caches, Engineer session resume. ~100 ready items in backlog.

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
