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
**Status:** Accepted
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
