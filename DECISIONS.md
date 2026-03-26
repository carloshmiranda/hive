# Architectural Decisions

> When a significant architectural choice is made, document it here. This prevents re-debating settled questions and helps future Claude Code sessions understand the reasoning behind the current design.

## Format

```
### ADR-NNN: Title
**Date:** YYYY-MM-DD
**Status:** accepted | superseded by ADR-NNN | deprecated
**Context:** What situation prompted this decision?
**Decision:** What did we decide?
**Alternatives considered:** What else was on the table?
**Consequences:** What are the tradeoffs?
```

---

### ADR-001: Mac-based intelligence, cloud-based serving
**Date:** 2026-03-18
**Status:** Superseded by ADR-011, ADR-019
**Context:** The orchestrator needs Claude-level reasoning for company management. Options: run agents on Vercel serverless, run on a VPS, or run on Carlos's Mac via Claude Code CLI with his Max 5x subscription.
**Decision:** Intelligence layer runs on Mac via `claude -p`. Serving layer (dashboard, webhooks, company sites) runs on Vercel.
**Alternatives considered:**
- Full cloud on Vercel with Gemini API: weaker reasoning, 60s function timeout constraint, but always-on
- VPS with Claude API key: best of both worlds but adds $$ API costs on top of subscription
- Mac + Gemini hybrid: commodity tasks on Vercel, strategic on Mac — considered but added complexity for Phase 1
**Consequences:** Mac must be on for nightly loop. Companies still serve traffic 24/7 (Vercel). Subscription quota is shared with interactive use. Migration path to cloud is built into `dispatch()` abstraction.

### ADR-002: Single Stripe account, products tagged by company
**Date:** 2026-03-18
**Status:** Accepted (supersedes initial Connect design)
**Context:** Each Hive company needs payment processing. Initially designed with Stripe Connect (connected accounts per company).
**Decision:** Single Stripe account. Products and prices tagged with `metadata.hive_company`. Revenue queries filter by metadata.
**Alternatives considered:**
- Stripe Connect Standard: separate accounts per company. Adds 0.25% fee, onboarding friction, and complexity for no benefit when one person owns all companies.
- Stripe Connect Express: even more restrictions, designed for marketplaces.
**Consequences:** All revenue in one Stripe account. Easy to manage. MRR/revenue per company derived from metadata filtering. Can't give companies independent Stripe dashboards (not needed for solo operator).

### ADR-003: Neon via Vercel Marketplace, not separate account
**Date:** 2026-03-18
**Status:** Accepted
**Context:** Hive needs Postgres. Neon is Vercel's native database. Initially designed as a manual Neon setup.
**Decision:** Provision Neon through Vercel Marketplace. DATABASE_URL auto-injected. Billing through Vercel.
**Alternatives considered:**
- Separate Neon account: more control, separate billing, but adds a manual step and another login.
- Supabase: full-stack backend, but overkill — we only need Postgres.
- PlanetScale: MySQL, not Postgres.
**Consequences:** One fewer account to manage. Vercel dashboard shows storage alongside hosting. Sub-company databases still use Neon API (separate projects within the same Neon org).

### ADR-004: Sequential nightly loop, not parallel agents
**Date:** 2026-03-18
**Status:** Accepted
**Context:** Claude Code Max 5x has a shared quota pool. Running 5 concurrent `claude -p` processes would hit the same rate limit.
**Decision:** Process companies sequentially. Budget ~40 messages per company. Run overnight when interactive usage is zero.
**Alternatives considered:**
- Parallel with rate limiting: still hits shared pool, adds complexity
- Parallel with API key: costs per token, defeats subscription value
- Staggered with delays: complex scheduling for minimal benefit
**Consequences:** 5 companies × 15 min each = ~75 min nightly. Acceptable for portfolio of 3-5. Becomes a bottleneck at 10+, which is when cloud migration (ADR-001 escape hatch) becomes necessary.

### ADR-005: GitHub Issues as the directive channel
**Date:** 2026-03-18
**Status:** Accepted
**Context:** Carlos needs to communicate with the orchestrator between cycles. Options: dashboard chat, email replies, GitHub Issues, Telegram bot.
**Decision:** Dashboard command bar creates GitHub Issues. Direct GitHub Issue creation also works. Orchestrator reads open issues with `hive-directive` label.
**Alternatives considered:**
- Dashboard-only directives: fast but no audit trail, no mobile access
- Email replies to digest: natural but hard to parse reliably
- Telegram bot: real-time but adds another service
**Consequences:** Full audit trail in GitHub. Accessible from phone (GitHub app). Claude Code can create issues natively. Directives visible in both dashboard and GitHub. Slight latency — processed at next cycle, not instantly (acceptable for strategy-level directives).

### ADR-006: Two-tier event processing
**Date:** 2026-03-18
**Status:** Accepted
**Context:** Nightly-only processing leaves 23 hours of unprocessed events. Payments, deploys, and failures happen throughout the day.
**Decision:** Tier 1 = Vercel webhooks (real-time, deterministic, no AI). Tier 2 = nightly Claude Code loop (strategic). Webhooks keep Neon current; the nightly loop reads pre-collected data.
**Alternatives considered:**
- Always-on agent: requires cloud deployment + API costs
- Shorter cycle intervals (every 4 hours): burns more subscription quota
- Pure webhook-driven with AI: Vercel function timeout (60s) too short for Claude reasoning
**Consequences:** Dashboard shows real-time data during the day. Agents plan with current information at midnight. Deploy failures auto-escalate without waiting for nightly loop. First-revenue detection triggers approval gates immediately.

### ADR-007: Import existing projects with pattern extraction
**Date:** 2026-03-18
**Status:** Accepted
**Context:** Carlos has existing projects (Flolio, potentially acquired projects) that should come under Hive management.
**Decision:** Import flow: scan repo → generate report → approval gate → onboard (add CLAUDE.md, link Vercel, register infra) → extract patterns to shared playbook. Never overwrite existing code.
**Alternatives considered:**
- Only manage new companies: misses the value of existing projects and their learnings
- Deep refactoring on import: too aggressive, risks breaking working code
- Shallow import (just metrics tracking): misses the learning opportunity
**Consequences:** Every import makes the playbook richer. Patterns from mature projects benefit all new companies. Existing codebases are respected — Hive adds alongside, never replaces.

### ADR-008: Hive improves itself, not just sub-companies
**Date:** 2026-03-18
**Status:** Accepted
**Context:** The orchestrator was designed to improve sub-companies (playbook, prompt evolution) but had no mechanism to improve its own codebase.
**Decision:** Hive maintains MISTAKES.md, BACKLOG.md, DECISIONS.md, and MEMORY.md. The orchestrator's weekly Retro Analyst reviews these. Improvements to Hive itself go through the same directive → branch → PR → approval flow as company improvements.
**Alternatives considered:**
- Only improve via manual Claude Code sessions: no continuity between sessions
- Fully autonomous self-modification: too risky without review gates
**Consequences:** Hive accumulates institutional knowledge across sessions. New Claude Code sessions read these files and don't repeat past mistakes. The backlog is a living roadmap that the orchestrator can self-assign from.

### ADR-009: Multi-provider model routing
**Date:** 2026-03-18
**Status:** Accepted
**Context:** Running all agents through Claude Code CLI (Max 5x subscription) burns ~225 messages per 5hr window. With 2+ companies and 7 agents each, plus Idea Scout, Venture Brain, Healer, and Prompt Evolver, the nightly budget is exhausted before all companies can process.
**Decision:** Route agent tasks by tier. Brain agents (CEO, Idea Scout, Research Analyst, Venture Brain, Healer, Prompt Evolver) use Claude CLI (needs tool use, complex reasoning, web search). Worker agents (Growth, Outreach) use Gemini free tier (content/email generation, no tool use). Ops uses Groq free tier (fastest inference for metric analysis). Engineer always uses Claude (needs cwd for code editing). Auto-fallback: Gemini fails → Groq → Claude.
**Alternatives considered:**
- All Claude: works but burns quota in 1-2 companies, can't scale to 5
- All Gemini: can't do tool use (no git, no deploy, no web search)
- Ollama local: latency too high for nightly batch, no web access
**Consequences:** Claude quota reserved for ~6 brain tasks per company cycle (CEO plan, CEO review, Research, Engineer, Healer, Evolver) plus portfolio-level tasks. Growth, Outreach, and Ops run on free tiers at ~7,000+ requests/day capacity. If Gemini/Groq keys aren't configured, everything falls back to Claude (works for 1-2 companies, breaks at 3+).

### ADR-010: Multi-repo with shared intelligence (not monorepo)
**Date:** 2026-03-19
**Status:** Accepted
**Context:** With 3 companies (Hive, VerdeDesk, Flolio) and more coming, we needed to decide: one repo for everything, or separate repos per company with Hive as coordinator? Research showed monorepos benefit AI agents for single-product cross-stack work, but Hive's companies are independent products with separate customers, deploys, and lifecycles. Polsia (closest comparable, 1,100+ companies, $1M ARR) uses separate repos per company with provisioned infrastructure.
**Decision:** Keep multi-repo. Each company gets its own GitHub repo, Vercel project, and CI/CD pipeline. Hive orchestrator coordinates via the shared Neon database. Cross-company learning happens through: (1) playbook injection at provisioning, (2) cross-company error correlation in the Healer, (3) Venture Brain cross-pollination directives.
**Alternatives considered:**
- Monorepo: better boilerplate sharing, but makes company kills messy, tangles CI/CD, and gives the Engineer agent confusing cross-company context via cwd
- Hybrid (Hive monorepo + company repos): no clear benefit — Hive is already the coordination layer
**Consequences:** Company isolation is clean (delete repo = delete company). Imports require no git history migration. The playbook table becomes the critical knowledge store — if it degrades, cross-company learning stops. Each new company starts with accumulated portfolio knowledge via CLAUDE.md injection.

### ADR-011: Event-Driven Execution with Zero Crons
**Date:** 2026-03-19
**Status:** Accepted (supersedes ADR-001 Mac-based intelligence, supersedes ADR-004 sequential nightly loop)
**Context:** The Mac-based nightly loop via launchd had an 18+ hour delay between events and agent response. The Mac had to be on. Cron-based worker scheduling was fragile and wasted runs when no work existed.
**Decision:** Fully event-driven architecture. Brain agents (CEO, Scout, Engineer, Evolver) run on GitHub Actions using `anthropics/claude-code-base-action` with a Max 5x OAuth token from `claude setup-token`. Worker agents (Ops, Growth, Outreach) run on Vercel serverless via `/api/agents/dispatch`. Agent chains: every workflow's final step dispatches the next agent via `repository_dispatch`. One sentinel workflow runs every 4h on GitHub Actions, queries Neon for 7 data conditions, and dispatches agents whose conditions are met. Vercel has zero crons — it only receives webhooks and serves the dashboard.
**Alternatives considered:**
- Keep Mac launchd: works but requires Mac to be on, 18h reaction delay
- Full Vercel crons: 60s timeout too short for Claude reasoning
- GitHub Actions crons for everything: burns minutes even when no work exists
**Consequences:** Mac not required — close the lid, Hive keeps running. ~915 min/mo GitHub Actions usage (46% of 2,000 free tier for private repos). Self-regulating: no work = no dispatch = no cost. Total cost stays at $100/mo (Max 5x subscription only).

### ADR-012: Agent Consolidation from 10 to 7
**Date:** 2026-03-19
**Status:** Accepted
**Context:** The original architecture had 10+ agent names (CEO, Idea Scout, Research Analyst, Venture Brain, Kill Switch, Retro Analyst, Engineer, Growth, Outreach, Ops, Health Monitor, Auto Healer, Provisioner, Prompt Evolver). Many overlapped in scope or were ghost names referenced in code but never dispatched. Each agent name burned a separate Claude call.
**Decision:** Consolidate to 7 agents with clear scope boundaries:
- CEO absorbs Venture Brain, Kill Switch, Retro Analyst (all strategic)
- Scout absorbs Idea Scout, Research Analyst (all discovery)
- Engineer absorbs Provisioner (all code/infra)
- Ops absorbs Health Monitor, Auto Healer, Healer (all operations)
- Growth stays (content)
- Outreach stays (email)
- Evolver replaces Prompt Evolver (shorter name, same role)
Migration 003 renames all existing records in agent_actions and agent_prompts.
**Alternatives considered:**
- Keep all 10: more granular but overlapping scopes cause confusion and wasted calls
- Consolidate to 5: too aggressive, Growth and Outreach are distinct enough to warrant separation
**Consequences:** Fewer Claude calls per cycle. Simpler chain dispatch logic. Agent CHECK constraint in schema reduced from 16 to 7 values. The "one agent, one verb" rule makes scope boundaries testable.

### ADR-013: Per-agent model selection
**Date:** 2026-03-19
**Status:** Accepted
**Context:** All GitHub Actions brain agents were running on Sonnet (claude-code-base-action v0.0.63 default). The action version had a bug where the model parameter was ignored (GitHub issue #255). Worker agents used Gemini 2.5 Flash-Lite, the lowest quality free tier option. Quality of CEO plans and Scout research directly impacts all downstream work.
**Decision:** Explicit model selection per agent based on work type. Brain agents: CEO/Scout/Evolver on Opus (strategic, infrequent), Engineer on Sonnet (execution, speed matters). Workers: Growth/Outreach upgraded to Gemini 2.5 Flash (content quality), Ops stays on Groq Llama 3.3 70B (speed). Fallback chain: Flash → Flash-Lite → Groq. Action upgraded from claude-code-base-action v0.0.63 to claude-code-action v1 with native model input.
**Alternatives considered:**
- All agents on Opus: burns Max 5x quota too fast, Engineer doesn't benefit from extra reasoning
- All agents on Sonnet: CEO and Scout produce mediocre plans/research that cascade into mediocre cycles
- Gemini 2.5 Pro for workers: only 100 RPD free tier, too restrictive even for low volume
**Consequences:** Better plan quality from CEO, better research from Scout, better prompts from Evolver. Slightly slower runs for those 3 agents (Opus latency). Growth/Outreach content quality improves. Engineer stays fast. Free tier quota impact: Flash at 250 RPD is sufficient for 5+ companies at a few calls/day each.

### ADR-015: CEO lifecycle modes instead of a separate product specifier agent
**Status note:** Superseded by ADR-024 (validation-gated build system replaces cycle-count modes)
**Date:** 2026-03-19
**Status:** Accepted
**Context:** After a company is approved, the CEO had no metrics to work with but its prompt was optimized for metrics-driven management. The first 2-3 cycles produced vague plans. Meanwhile, Scout's competitive analysis and market research contained exactly the data needed to spec features — but nobody translated research into feature specs.
**Decision:** Give the CEO three lifecycle modes: Build (cycles 0-2), Launch (cycles 3-5), Optimize (cycles 6+). Mode is detected from cycle count and revenue data, not configured manually. Build mode reads Scout research and outputs user stories with acceptance criteria, citing which research report informed each decision. No new agent — the CEO handles all modes (consistent with ADR-012 agent consolidation).
**Alternatives considered:**
- New "Product Manager" agent: adds an 8th agent, burns extra Claude calls, overlaps with CEO scope
- Static feature list in the Scout proposal: too rigid, doesn't adapt as research updates
- Engineer self-specs: Engineer is an executor, not a strategist — conflating roles
**Consequences:** First cycles produce specific, research-backed feature specs instead of vague plans. Engineer gets clear acceptance criteria from cycle 1. Growth gets content tasks alongside engineering from the start. The transition from build→launch→optimize happens automatically based on data, not manual intervention.

### ADR-014: Growth intelligence layer — data-driven content decisions
**Date:** 2026-03-19
**Status:** Accepted
**Context:** Growth agent created content without knowing what was working. No keyword ranking data, no visibility into AI answer engines, no feedback loop. Content was created from keyword research alone with no performance data.
**Decision:** Build a growth intelligence layer with three free data sources: (1) Google Search Console API for keyword positions, impressions, CTR — identifies striking distance keywords and low CTR pages. (2) DIY LLM citation tracker using Gemini free tier — checks if the company appears in AI answers for its top keywords, tracks competitors. (3) IndexNow protocol for instant re-indexing on content publish. All data stored in `visibility_metrics` table. Growth agent never runs without fresh visibility data injected into its prompt. Boilerplate updated with llms.txt, structured data, sitemap, and AI-friendly robots.txt.
**Alternatives considered:**
- Paid SEO tools (Ahrefs, SEMrush): $100+/mo per tool, overkill for early-stage companies
- Google Analytics only: no keyword-level data (GA4 hides search queries)
- Skip LLM tracking entirely: miss the growing AI answer engine channel
**Consequences:** Growth decisions are data-driven. Content targets proven opportunities (striking distance, low CTR) instead of guessing. LLM visibility tracked from day one. All free APIs — €0 additional cost. GSC requires service account setup per company property. LLM citation checks add ~25s to Growth dispatch (10 keywords × 2s rate limit + overhead).

### ADR-016: Waitlist-first launch with Growth-owned email lifecycle
**Date:** 2026-03-19
**Status:** Accepted
**Context:** New companies launched directly to checkout with no audience. First cycles had zero traffic and zero chance of conversion. Meanwhile, the Growth agent had no email infrastructure — transactional emails existed but no lifecycle sequences (welcome drips, waitlist updates, win-back).
**Decision:** Every new company starts in waitlist mode (LAUNCH_MODE=waitlist). Landing page collects emails with referral mechanics (unique codes, position tracking, source attribution). Growth agent owns ALL email sequences via the `email_sequences` table — structured data with subject, body, delay, A/B variants, and open/click/bounce counters fed by Resend webhooks. CEO monitors waitlist growth in build mode and transitions to early_access when demand is validated (50+ signups). Provisioner seeds default email sequences (waitlist_welcome, onboarding_d1/d3/d7) at company creation. Hive metrics table extended with waitlist_signups, waitlist_total, email_opens, email_clicks, email_bounces.
**Alternatives considered:**
- Skip waitlist, launch directly: no audience, no demand signal, cold start problem
- External waitlist tool (Waitlist.me, LaunchDarkly): adds dependency, costs money, data not in our DB
- Marketing agent owns email: Growth already does content and SEO — email is part of the same funnel, not a separate concern
**Consequences:** Companies launch with built-in audience building. Growth has a feedback loop on email quality (open/click rates). CEO can make data-driven launch timing decisions based on waitlist size. Referral mechanics create organic growth before the product even ships. Email sequences are A/B testable from day one. Resend free tier (100/day) is sufficient for early waitlists.

### ADR-018: Company Capability Inventory for infrastructure-aware agent behavior
**Date:** 2026-03-19
**Status:** Accepted
**Context:** Hive agents assumed every company was scaffolded from the latest boilerplate. This broke for three scenarios: (1) boilerplate drift — companies provisioned before new features were added, (2) imported companies that weren't built by Hive, (3) partial boilerplate where Engineer customised and removed things. Agents would reference tables that didn't exist, Evolver would propose fixes for infrastructure that was absent, and Growth would try to write email sequences to non-existent tables.
**Decision:** Add a `capabilities` JSONB column to the companies table storing a structured inventory of what infrastructure, integrations, and features actually exist. Populated on provisioning (full inventory), on import (minimal, needs assessment), and updated by Ops during health checks. Every agent checks capabilities before acting on optional infrastructure. A compatibility matrix prevents proposing features that don't make sense for a given company type/stage (e.g., waitlist for a company with existing customers, referral mechanics for B2B SaaS). A new `/api/companies/[id]/assess` endpoint inspects the company's database schema, Vercel env vars, and repo files to build the inventory automatically.
**Key design choices:**
- Missing keys treated as `{ exists: false }` — no agent errors on unknown capabilities
- Agents skip unsupported features gracefully, reporting `missing_capabilities` in output
- Assessment is idempotent and safe to re-run
- `company_type` column enables compatibility matrix decisions
- `imported` flag distinguishes Hive-provisioned vs brought-in companies
- Ops flags stale inventories (>14 days) for re-assessment
**Alternatives considered:**
- Hardcode assumptions per company: doesn't scale, breaks on boilerplate updates
- Feature flags in env vars: scattered, no visibility, no compatibility logic
- Skip the problem: agents crash on missing tables, poor experience for imported companies
**Consequences:** Agents never reference infrastructure that doesn't exist. Imported companies are first-class citizens. Boilerplate drift is handled gracefully — old companies get new features only when assessed and approved. The capability inventory becomes the single source of truth for what a company can do.

### ADR-017: Evolver as Reflector-Curator with structured gap detection
**Date:** 2026-03-19
**Status:** Accepted
**Context:** The Evolver agent was a vague "prompt improver" that ran weekly and only looked at agent success rates to propose prompt changes. This missed the bigger picture: outcome gaps (metrics declining), capability gaps (infrastructure missing), and knowledge gaps (playbook holes). The old approach was too narrow — better prompts don't fix missing API keys or empty playbooks.
**Decision:** Rewrite Evolver as a three-layer gap detection system. Layer 1 (outcome): agent success rates + cycle score trends. Layer 2 (capability): escalation clusters, repeated failures, missing infrastructure from capability inventories. Layer 3 (knowledge): playbook coverage gaps, unreferenced entries, missing domains. Proposals are structured (gap_type, severity, diagnosis, proposed_fix) and stored in `evolver_proposals` table. They appear in the dashboard Inbox with approve/reject/defer. Prompt evolution is now a subset — one proposal type among many. Triggers: weekly schedule + event-driven (error rate >30%, escalation clusters ≥3, stuck companies >14 days) with 24h debounce. Playbook reference tracking added (last_referenced_at, reference_count) to measure knowledge utilization.
**Key design choices:**
- Proposals are never auto-implemented — all go through Inbox approval
- Max 5 proposals per run (quality over quantity)
- Deduplication: check existing pending/deferred proposals before creating new ones
- Cross-company flag for proposals that benefit multiple companies
- Approved proposals injected into agent context in next cycle
- Proposals auto-marked as implemented after the affected company's next cycle
- **Update 2026-03-20:** Approval now has side effects per type: `prompt_update` → immediate activation + `implemented_at` set; `setup_action` → creates `pending_manual` todo + dispatches `ceo_review`; `knowledge_gap` → dispatches `ceo_review`. Stale approved proposals (>48h without implementation) surface as dashboard todos.
**Alternatives considered:**
- Keep prompt-only evolution: too narrow, misses infrastructure and knowledge gaps
- Auto-implement fixes: too risky, Carlos should review structural changes
- Separate agents for each gap type: over-engineered, one agent with three layers is simpler
**Consequences:** Evolver becomes the system's self-awareness layer. It detects problems across all three dimensions and proposes specific, evidence-backed fixes. Playbook utilization becomes measurable. The Inbox becomes the single review surface for all improvement proposals.

### ADR-019: Remove orchestrator.ts Mac fallback
**Date:** 2026-03-20
**Status:** Accepted (completes ADR-011 cloud migration)
**Context:** After ADR-011 moved all orchestration to GitHub Actions, `orchestrator.ts` (2000+ lines) and `com.hive.orchestrator.plist` remained as "fallback." In practice they were never used post-migration, drifted from the actual workflows, and caused context loss — a Claude Code session incorrectly assumed the orchestrator still ran on Mac via launchd because the file existed.
**Decision:** Delete `orchestrator.ts`, `com.hive.orchestrator.plist`, and the `ts-node` dev dependency. Remove `orchestrate` npm scripts. Update all documentation references. The git history preserves the full file for reference if ever needed.
**Alternatives considered:**
- Keep as reference: actively harmful — its presence implies it's used, causing context confusion
- Extract useful patterns to a doc: the patterns (retry logic, structured handoffs, agent dispatch) are already implemented in GitHub Actions workflows and documented in ARCHITECTURE.md
**Consequences:** Single source of truth for orchestration is now `.github/workflows/`. No risk of future sessions confusing the fallback with the actual system. One fewer 2000-line file to maintain. `ts-node` dependency removed.

### ADR-020: Sentinel + Digest on Vercel cron, direct worker dispatch
**Date:** 2026-03-21
**Status:** Accepted (extends ADR-011 event-driven architecture)
**Context:** GitHub Actions free tier gives 2,000 min/month for private repos. Sentinel (every 4h = 6 runs/day), Digest (daily = 1 run/day), and worker-agents.yml (proxy to Vercel = ~3-5 runs/day) were burning ~10-12 Actions runs daily on pure Node.js work that doesn't need Claude. Meanwhile, brain agent turns were set generously (Scout 50, Engineer 50), often exhausting quota on ambiguous tasks.
**Decision:** Three changes: (1) Move Sentinel and Digest to Vercel cron (`/api/cron/sentinel`, `/api/cron/digest`) — both are pure Node.js, no Claude dependency. (2) Eliminate worker-agents.yml proxy — CEO and Scout chain dispatch call Vercel `/api/agents/dispatch` directly via curl for Growth/Outreach/Ops. (3) Reduce max-turns on brain agents: Scout 50→35, Engineer provision 25→15, Engineer build 50→35. Legacy GitHub Actions workflows kept as manual-only fallback.
**Alternatives considered:**
- Keep everything on GitHub Actions: works but burns 10+ unnecessary runs/day, approaching quota limit at scale
- Move brain agents to Vercel too: 60s timeout too short for Claude reasoning
- Remove legacy workflows entirely: lose manual trigger capability for debugging
**Consequences:** ~10-12 fewer Actions runs per day. Sentinel on Vercel can dispatch workers directly (no Actions proxy). Vercel cron is free on Hobby tier. Brain agent runs are shorter (fewer turns = less quota burn). Trade-off: Vercel Hobby has 60s function timeout — Sentinel grew to 39 checks and hit this limit, resolved by ADR-030 (company-health extraction).

### ADR-021: Public company repos + build dispatch for unlimited Actions minutes
**Date:** 2026-03-21
**Status:** Accepted (extends ADR-020)
**Context:** After ADR-020, Hive's private repo still ran Engineer build jobs (30min timeout, 35 turns) for each company. At 3 companies with 2 builds/day each, that's ~180min/day from a 2,000 min/month budget (270%). Build jobs are the #1 consumer of Actions minutes.
**Decision:** Three changes: (1) Company repos are created as PUBLIC — GitHub gives unlimited Actions minutes for public repos. No secrets in code (they live in Vercel env vars + GitHub Actions secrets). (2) Each company repo gets `hive-build.yml` — a workflow accepting `workflow_dispatch` with task payload. Hive Engineer dispatches build tasks to the company repo instead of running them on Hive. (3) Hive Engineer `build` job is now a lightweight 5-min dispatcher; `build-hive` fallback handles Hive-internal work when no company repo exists.
**Alternatives considered:**
- Keep company repos private, use GitHub Actions Cache: doesn't reduce minutes, just speeds up runs
- Move Engineer to Vercel: 60s timeout too short for builds
- Use self-hosted runners: free but requires infra maintenance
- Make Hive public too: exposes orchestration logic and API patterns
**Consequences:** Build minutes effectively unlimited. Hive private repo only uses Actions for CEO (25 turns), Scout (35 turns), Evolver (periodic), and Engineer provision (15 turns) — well within 2,000 min/month. Company code is public but contains no proprietary secrets. Provisioning now sets up GitHub Actions secrets on company repos and pushes the build workflow template.

### ADR-022: OIDC API gateway — zero-secret company repos
**Date:** 2026-03-21
**Status:** Accepted (extends ADR-021)
**Context:** After ADR-021, company repos still needed `DATABASE_URL` as a GitHub Actions secret for their workflows (hive-build, hive-growth, hive-fix) to load context and log results. This created three problems: (1) secrets management burden — every company repo needed DATABASE_URL configured, (2) direct DB access from untrusted repos — company workflows could run arbitrary SQL on the shared Neon database, (3) key rotation required updating every company repo.
**Decision:** Replace all direct DB access from company workflows with OIDC-authenticated Hive API calls. Five new endpoints: `/api/agents/token` (OIDC → credential exchange), `/api/agents/context` (load agent-specific context), `/api/agents/log` (log actions), `/api/agents/tasks/:id` (update task status), `/api/agents/playbook` (write playbook entries). Company workflows use GitHub's native OIDC provider — request a JWT proving repo identity, exchange it at the Hive API for the specific token they need (Claude, GitHub PAT, Gemini, etc.). Shared OIDC validation in `src/lib/oidc.ts` validates issuer, audience, and repository owner across all endpoints.
**Key design choices:**
- Allowed workflows are whitelisted by filename (hive-build.yml, hive-fix.yml, etc.)
- Repository owner must match `carloshmiranda` (prevents unauthorized repos from requesting tokens)
- Token types are mapped to settings keys (claude → claude_code_oauth_token, github_pat → github_token, etc.)
- Context endpoint returns agent-specific data bundles (build context ≠ growth context ≠ fix context)
- Log endpoint resolves company_slug → company_id server-side (company workflows don't need to know IDs)
- Playbook endpoint includes deduplication check
- **Critical learning:** GitHub Actions strips masked secrets from cross-job outputs. Each job must fetch its own tokens via OIDC — never pass secrets between jobs via `needs.X.outputs`.
**Alternatives considered:**
- Keep DATABASE_URL on company repos with read-only role: still requires secret management, SQL injection risk
- Neon Data API (HTTP/JSON): still requires API key secret on each repo, less control over authorization
- GitHub repository environments with secrets: reduces blast radius but doesn't eliminate secret management
**Consequences:** Company repos need ZERO secrets. All auth happens at runtime via OIDC (a free GitHub feature). Token rotation only requires updating Hive settings — company repos auto-get new tokens. The API gateway provides authorization (only allowed workflows from the right owner), rate limiting potential, and audit trail. Trade-off: company workflows are now coupled to Hive API availability — if Vercel is down, company builds can't load context.

### ADR-024: Validation-gated build system with per-business-type phases
**Date:** 2026-03-22
**Status:** Accepted (supersedes ADR-015)
**Context:** CEO agent used cycle-count-based modes (build 0-2, launch 3-5, optimize 6+) to decide what to plan. This caused problems: the Engineer built auth systems and product features before validating demand (Senhorio had login links in waitlist mode). Cycle count is a poor proxy for readiness — a company with 10 cycles but no traffic shouldn't be building features.
**Decision:** Replace cycle-count modes with a composite validation score (0-100) computed from real metrics per business type. Each type has distinct phase progressions: SaaS (validate→test_intent→build_mvp→build_aggressively→scale), Blog (seed_content→seo_growth→monetize→scale), Affiliate (build_directory→drive_traffic→optimize_conversions→scale). Each phase has explicit gating rules (what's allowed) and forbidden lists (what's blocked). Score computed server-side in `/api/agents/context` and injected into CEO context. CEO is the only agent that needs phase logic — it gates what tasks it plans, so downstream agents (Engineer, Growth) only see phase-appropriate work.
**Key design choices:**
- Kill criteria are organic-patient: 60/120/180 day windows instead of weekly. Any revenue = infinite patience.
- Fake-door pricing validation: SaaS companies must get pricing page clicks before building product code.
- Boilerplate collects validation metrics from day 1: pageviews, pricing CTA clicks, affiliate clicks.
- `normalizeBusinessType()` maps legacy company_type values to the new taxonomy.
**Alternatives considered:**
- Per-agent phase logic: each agent checks the phase independently. Rejected — CEO is the gateway, simpler to have one checkpoint.
- Strict automated gating: block deploys that violate phase. Rejected — too rigid, CEO should have judgment with guardrails.
- LLM-computed scores: have Claude assess readiness. Rejected — deterministic scoring from metrics is more reliable and auditable.
**Consequences:** CEO plans are now constrained by real data. Companies can't over-build before validating demand. Different business models get appropriate treatment. Trade-off: companies with broken metrics collection will score 0 and stay in early phases — but the boilerplate now collects metrics from day 1, so this only affects pre-existing companies.

### ADR-023: Priority-scored cycle dispatch with budget-aware throttling
**Date:** 2026-03-21
**Status:** Accepted (extends ADR-011)
**Context:** Sentinel dispatched cycle_start to companies using a flat query (first N companies with no cycle in 24h). With Claude Max 5x's ~225 messages/5h budget, this wastes quota on low-priority companies while starving high-priority ones. A company with 8 pending tasks and an open Carlos directive should be cycled before one with 1 task and 10 completed cycles.
**Decision:** Replace flat query with composite priority score ranking. Score formula: `(pending_tasks × 2) + (days_since_cycle × 3, capped at 14) + lifecycle_bonus + directive_override - (completed_cycles × 0.5)`. Bonuses: new MVPs with <3 cycles (+18), struggling companies with CEO score <5 (+5), open Carlos directive (+15). Companies are dispatched in score order. Budget-aware throttling checks `agent_actions` for Claude turns consumed in the last 5 hours: >70% → max 1 dispatch, >90% → skip cycles entirely (only escalations processed).
**Data signals used:** company_tasks (pending count), cycles (recency, total, CEO score), directives (Carlos override), metrics (revenue for future optimization), agent_actions (budget tracking).
**Alternatives considered:**
- Round-robin (fair but ignores urgency): doesn't prioritize where value is highest
- Manual priority setting (Carlos ranks companies): doesn't scale, adds friction
- Time-based only (oldest first): ignores task backlog and lifecycle stage
**Consequences:** Companies with more pending work, open directives, or struggling scores get dispatched first. Budget is protected — high usage automatically reduces dispatch volume. The priority_score is logged in dispatches for observability. Trade-off: the scoring query is more complex (CTE with 7 subqueries), but runs only hourly in Sentinel so performance impact is negligible.

---

### ADR-026: Centralized business type registry with auto-research for unknown types
**Date:** 2026-03-22
**Status:** accepted
**Context:** Business type definitions were scattered across 5+ files (validation.ts, boilerplate-manifest.json, assess/route.ts, capabilities.ts, prompts/ceo.md). Adding a new business type required touching all 5 and hoping you didn't miss one. When Scout proposes a company with a novel business model, the system had no way to automatically research and seed the right lifecycle phases, scoring, infrastructure, and kill criteria.
**Decision:** Created `src/lib/business-types.ts` as the single source of truth. Each type definition includes: canonical ID, legacy mappings, lifecycle phases, scoring model, relevant capabilities, and kill criteria. All consumers (validation.ts, capabilities.ts, assess/route.ts) derive from it. Added `/api/agents/research-type` endpoint that detects unknown types and returns a structured research prompt. Engineer workflow Step 0 now calls this before provisioning — if the type is unknown, Claude researches best practices via web search, generates a complete definition, commits it to business-types.ts, then continues provisioning.
**Alternatives considered:**
- Manual type addition (Carlos adds types): doesn't scale, blocks autonomous operation
- LLM generates types at runtime without persisting: inconsistent across cycles, no institutional memory
- Static JSON registry (not TypeScript): loses type safety, can't export helper functions
**Consequences:** Adding a new business type now requires adding one entry to the BUSINESS_TYPES array. Unknown types trigger automatic research during provisioning — the system learns new business models autonomously. The manifest's company_types arrays are partially redundant but kept for backwards compatibility. The research-type endpoint uses web search, so quality depends on available information about the business model.

### ADR-027: Autonomous self-improvement with safe/risky classification
**Date:** 2026-03-24
**Status:** Accepted
**Context:** Hive had a backlog of improvements but no mechanism to implement them autonomously. Manual Claude Code sessions were the only way to improve Hive itself. Meanwhile, Sentinel already detected improvement opportunities (Check 37: recurring errors, zero metrics, timeouts, stuck tasks) but could only create proposals — not act on them.
**Decision:** Close the loop: Sentinel Check 37 creates improvement proposals → approved proposals dispatch Engineer with `company: "_hive"` → Engineer implements in Hive's own repo. Changes are classified as safe or risky: safe changes (no schema, workflow, auth, or middleware modifications) push directly to main. Risky changes create PRs for Carlos to review. Telegram notification sent after every self-improvement build.
**Key design choices:**
- Safe vs risky classification based on file paths touched (schema.sql, .github/workflows, middleware.ts, auth.ts = risky)
- Auto-approved proposals with `safe_to_auto_implement: true` skip the approval gate
- Hive Engineer uses `build-hive` job (not company build dispatch) — works in Hive's own repo
- Telegram notification includes PR link (risky) or push confirmation (safe)
**Alternatives considered:**
- Always create PRs: too slow for trivial fixes, creates approval fatigue
- Always push to main: too risky for schema/workflow changes that could break the system
- Separate self-improvement agent: over-engineered — Engineer already handles code changes
**Consequences:** Hive can fix its own bugs and implement improvements without manual sessions. Carlos reviews risky changes via PR (or Telegram Merge/Close buttons). Safe changes land immediately. The backlog shrinks autonomously. Trade-off: a bad safe classification could push a breaking change — but the classification is conservative (only config/docs/minor code changes are safe).

### ADR-029: Continuous event-driven dispatch (replace Sentinel polling)
**Date:** 2026-03-24
**Status:** Accepted
**Context:** Sentinel runs every 4h as a cron job, dispatching company cycles and backlog items. This meant work sat idle for up to 4h between completions. With backlog chain dispatch already working (Engineer → backlog/dispatch), the same pattern can extend to company cycles. Carlos asked: "Why do we need to wait on Sentinel 4h cycle to move work if there is work to be done?"
**Decision:** Build completion callbacks that chain work items automatically. Two new endpoints: (1) `/api/dispatch/health-gate` — checks Claude budget (225/5h), concurrent brain agents, system failure rate, Hive backlog priority. Returns dispatch/wait/stop recommendation. (2) `/api/dispatch/cycle-complete` — completion callback called by CEO workflow after cycle_complete/ceo_review. Flow: health gate → hive-first check (P0/P1 backlog takes priority) → score all companies → dispatch highest-priority one. Engineer's backlog chain falls through to company cycles when backlog is empty.
**Key design choices:**
- Health gate as a separate endpoint — reusable by any dispatch trigger (Sentinel, chain, manual)
- Hive-first priority — critical backlog items always beat company cycles
- 6h minimum spacing — prevents re-dispatching the same company too quickly
- Company scoring reuses Sentinel's formula (pending tasks, staleness, lifecycle stage, CEO score)
- Sentinel remains as safety net — catches anything that fell through chain dispatch (e.g., after failures)
- Completion callbacks are fire-and-forget (`|| true`) — workflow success not dependent on chain working
**Alternatives considered:**
- WebSocket-based dispatch: too complex for serverless
- Reduce Sentinel interval to 1h: still polling, wastes cron budget
- GitHub Actions workflow chaining: limited to same repo, complex dependency graph
**Consequences:** Work moves immediately after completion instead of waiting up to 4h. Budget utilization improves. Sentinel's role changes from primary dispatcher to safety net. Trade-off: more API calls between workflows and Vercel (each completion triggers health gate + scoring), but these are fast SQL queries within Vercel's free tier.

### ADR-028: Telegram as real-time notification and approval channel
**Date:** 2026-03-24
**Status:** Accepted
**Context:** Carlos had no visibility into Hive's autonomous operations between checking the dashboard. Approval gates accumulated for hours/days before being reviewed. The dashboard was the only interface for approve/reject decisions.
**Decision:** Integrate Telegram Bot API for real-time push notifications and interactive approvals. Three components: (1) `src/lib/telegram.ts` — send messages, messages with inline keyboard buttons, edit messages. (2) `/api/notify` — POST endpoint for agents/workflows to send notifications (auth: CRON_SECRET or OIDC). (3) `/api/webhooks/telegram` — handles callback queries (button presses) for approve/reject/merge/close actions. Approval gates auto-send Telegram messages with Approve/Reject buttons. PRs send Merge/Close buttons. Auto-merged PRs get informational-only messages.
**Key design choices:**
- Webhook-based (not polling) — Telegram pushes updates to our endpoint
- Authorized chat ID verification — only respond to the configured chat
- Fire-and-forget notifications — don't block on Telegram API failures
- Message editing after action — original message updated to show result (no duplicate messages)
- Settings-based configuration — `telegram_bot_token` and `telegram_chat_id` in Hive settings table
**Alternatives considered:**
- WhatsApp Business API: requires Facebook Business account, more complex setup
- Slack: heavier integration, not a personal tool
- Email notifications: already have digest, but not real-time and no interactive buttons
- Dashboard-only: works but requires actively checking, no push notifications
**Consequences:** Carlos gets real-time visibility into all Hive operations. Approvals can be handled from phone in seconds. PRs can be merged without opening GitHub. Trade-off: Telegram dependency — if Telegram API is down, notifications silently fail (fire-and-forget design). Setup requires manual bot creation via @BotFather.

### ADR-027: Cost-only PR escalation model
**Date:** 2026-03-25
**Status:** accepted
**Context:** PR risk scoring had a dead zone at score 4-6 (`manual_review`) with no handler — PRs sat in limbo forever. Carlos's principle: "Carlos should only be involved in decisions that might impact our operational cost."
**Decision:** Remove `manual_review` decision entirely. All PRs auto-merge if CI passes and no safety gates fail. Only cost-impacting changes escalate to Carlos: new paid service dependencies, GitHub Actions workflow additions (burns private minutes), model routing upgrades to more expensive LLMs, Vercel Pro plan triggers, schema changes with data loss risk. Safety gates (secrets in diff, destructive SQL without rollback, merge conflicts, CI failures, huge diffs) still block merge.
**Alternatives considered:**
- Time-based cooldown (score 4→1h, 5→2h, 6→4h delay before merge): adds complexity, doesn't solve the real problem (cost visibility)
- AI reviewer agent (LLM reviews medium-risk PRs): burns tokens for quality checks that CI already covers
- Dashboard review queue: still requires Carlos to actively check — defeats autonomy goal
**Consequences:** Fully autonomous PR merging for quality-risk changes. Carlos only sees PRs with cost implications. Risk: a high-score PR that introduces bugs will auto-merge — but CI is the safety net, and Healer can self-fix post-merge. Trade-off is intentional: autonomy > perfectionism.

### ADR-030: Sentinel monolith split — company-health extraction
**Date:** 2026-03-25
**Status:** accepted
**Context:** Sentinel grew to 3426 lines with 39 checks. Vercel serverless has a 60s timeout. HTTP-heavy checks (fetching company stats endpoints, GitHub API for tests/PRs, Vercel API for stale records) after line ~1900 likely never executed — they'd timeout before reaching them. Critical checks like PR auto-merge (check 38) and broken deploy repair (check 30) were silently dead.
**Decision:** Extract 6 HTTP-heavy checks (31, 32, 33, 36, 38, 30) into a new `/api/cron/company-health` endpoint (~500 lines). Sentinel fires it as a non-blocking `fetch()` with 5s timeout (fire-and-forget). Each endpoint gets its own 60s execution window. Company-health logs results to `agent_actions` and sends its own Telegram notifications.
**Alternatives considered:**
- Increase Vercel timeout: Requires Pro plan upgrade, still a bandaid — checks would keep growing
- Sequential cron calls: Vercel cron can't chain calls, would need external scheduler
- Split into 3+ endpoints: More granular but adds routing complexity for marginal benefit
- Priority-order checks: Move critical checks earlier — helps short-term but doesn't solve growth
**Consequences:** Sentinel reduced from 3426 to 2933 lines. All 39 checks now execute within timeout. Company-health runs independently — if it fails, Sentinel still completes. Trade-off: dispatch dedup doesn't share state between the two endpoints (company-health does its own GitHub API calls for dispatching fixes). Acceptable since they dispatch to different targets.

### ADR-031: Sentinel scheduling strategy — Vercel Crons + lazy checks
**Date:** 2026-03-25
**Status:** accepted (phases 1+3 implemented, phase 2 pending), proposed (phase 4)
**Context:** Sentinel runs hourly via a GitHub Actions cron that curls Vercel endpoints — an unnecessary middleman. ADR-029 introduced continuous event-driven dispatch (chain callbacks), making Sentinel's dispatch role redundant for the happy path. But Sentinel still runs 33 DB-only checks, many of which don't need hourly polling: approval expiry checks time windows of 2-14 days, stale content uses 7-day windows, research staleness is 14 days. Meanwhile, some checks (stuck cycles, stale running actions) DO need frequent attention.

**Decision:** Four-phase migration from cron-heavy to event-driven:

**Phase 1 — Vercel native crons (immediate):** Replace `hive-crons.yml` GitHub Actions proxy with `vercel.json` cron entries. Sentinel, Metrics, Digest already exist as Vercel endpoints. This eliminates the GitHub Actions middleman — zero new dependencies, zero cost (Vercel Crons are free, Pro plan allows per-minute precision, 100 jobs max).

**Phase 2 — Sentinel split + lazy checks:** Split Sentinel into 3 focused endpoints by urgency:
- `/api/cron/sentinel-urgent` (every 2h): stuck cycles/actions, unverified provisions, stuck approved
- `/api/cron/sentinel-dispatch` (every 4h): company cycle dispatch (safety net), budget check, chain gaps, failed retries
- `/api/cron/sentinel-janitor` (daily 2am): stale content/leads/research, evolve trigger, healer trigger, company assessment
Move ~12 checks to event-driven (no cron):
- Approval expiry → check-on-read (WHERE clause in approval queries)
- Schema drift → post-deploy webhook trigger
- Dispatch loop detection → inline in dispatchToActions()
- Anomaly detection → compute in metrics cron or on dashboard load
- Agent regression → compute in digest or on dashboard load
- Missing spec/tasks → check during CEO cycle start
- Recurring escalation detection → trigger on escalation creation
- Auto-dismiss escalations → check-on-read when list loaded

**Phase 3 — Upstash QStash for guaranteed delivery (DONE 2026-03-26):** Implemented in two sub-phases: (A) QStash schedules replacing Vercel crons for sentinel/metrics/digest — dual-mode auth via `verifyCronAuth()` accepts both QStash signatures and CRON_SECRET. (B) `qstashPublish()` helper replacing fire-and-forget fetch calls in cycle-complete, sentinel, and backlog/dispatch — 3 retries, hourly deduplication IDs, graceful fallback to direct fetch when QSTASH_TOKEN not set. Only fire-and-forget calls replaced; synchronous calls (health-gate, backlog response) kept as direct fetch. Free tier: 1,000 msgs/day, 10 schedules.

**Phase 4 — Vercel Queues (when GA):** Evaluate native Vercel Queues to replace QStash and chain dispatch HTTP calls with managed, durable event streaming.

**Alternatives rejected:**
- Neon pg_cron/pg_net: pg_net not available on Neon — can only run SQL, can't trigger HTTP endpoints
- Inngest / Trigger.dev: Full orchestration platforms — overkill when Hive already has its own orchestration layer (GitHub Actions + Sentinel + chain dispatch). High migration cost, adds critical dependency.
- Keep GitHub Actions cron: Works but wastes private repo minutes on a curl proxy. Vercel Crons are strictly better.

**Consequences:** Phase 1 eliminates ~24 GitHub Actions runs/day. Phase 2 reduces total cron invocations from 24/day to ~10/day and moves half of Sentinel's checks to event-driven. Phase 3 makes chain dispatch durable (currently fire-and-forget HTTP). The system becomes progressively more event-driven without big-bang rewrites.

### ADR-032: LLM-assisted task decomposition with Actions-first routing
**Date:** 2026-03-26
**Status:** accepted
**Context:** Auto-decompose was producing junk sub-tasks — dumb step-chunking that grouped approach steps into 1-2 step chunks with hardcoded `complexity: "S"`, generic acceptance criteria, and narrative descriptions. 63 sub-tasks were created that were useless. Meanwhile, L-complexity tasks exhausted max_turns (30+) when dispatched as-is.
**Decision:** Two-tier decomposition: (1) L-complexity tasks dispatch to `hive-decompose.yml` on GitHub Actions where Claude CLI (Max subscription) reads the codebase and produces 2-4 independent, testable sub-tasks. (2) Serverless fallback via `decomposeTask()` in backlog-planner.ts uses OpenRouter (Claude Sonnet 4 free tier) for when Actions dispatch fails or for failure-triggered decomposition. Both produce structured sub-tasks with single-responsibility, concrete acceptance criteria, specific affected files, and S/M complexity.
**Key design choices:**
- Actions-first: Claude Max gives better reasoning than free-tier models for task breakdown
- Serverless fallback: ensures decomposition always works, even if Actions is unavailable
- Parent marked `planning` during Actions decomposition (not blocked or dispatched)
- Decompose workflow triggers backlog/dispatch on completion to pick up new sub-tasks
- Decomposer routing: OpenRouter `anthropic/claude-sonnet-4:free` → Claude API → Gemini → Groq
**Alternatives considered:**
- Only serverless decomposition: free-tier models produce lower quality breakdowns
- Only Actions decomposition: adds latency and burns Actions minutes for every L task
- Keep dumb chunking with better heuristics: fundamental limit — heuristics can't understand codebase context
**Consequences:** Task decomposition quality matches what a senior engineer would produce. L-complexity tasks no longer exhaust max_turns. Actions minutes used only for genuinely complex decomposition (~5min per task, max 8 turns). Serverless path handles simpler cases at zero cost.
