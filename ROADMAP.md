# Hive Platform Roadmap

> Strategic outcomes for Hive. Each outcome links to `hive_backlog` items via `theme`.
> Progress is computed from theme completion rates — no manual checkboxes.
>
> Updated by: Carlos + Chat/Code sessions (strategic direction), Step 9 (progress numbers).

## Vision

Hive is a **fully AI-centric autonomous venture orchestrator**. It spawns businesses, builds them, grows them, and kills failures — all autonomously. Carlos approves 4 gates (new company, growth strategy, spend >€20, kill) and nothing else.

**Key principle: free tiers first.** MVP companies use only free infrastructure. Better infra only after revenue proves the business works.

**Target state:** A portfolio of 10+ self-running micro-businesses generating €10K+ MRR total, managed entirely by AI agents, requiring <15 min/day of Carlos's attention.

---

## Phase 1 — First Revenue

### `dispatch_chain` — Reliable end-to-end work execution
**Success criteria:** CEO plan → Engineer build → Growth content → Ops verify completes without manual intervention in 90%+ of cycles.

Key outcomes:
- Chain dispatch fires reliably after every agent step
- Error context propagates through the full callback chain
- Task completion status flows back to CEO for review scoring
- Growth dispatches to company repo with Vercel fallback

### `first_revenue` — Any Hive company earns money
**Success criteria:** At least one company receives a Stripe payment. Outreach pipeline sends real emails. Metrics pipeline captures real data.

Key outcomes:
- Email sending domain verified (Resend)
- Outreach pipeline sends and tracks real emails
- Metrics pipeline captures page views, pricing clicks, affiliate clicks
- Validation scoring reflects actual company state

---

## Phase 2 — Portfolio at Scale (5-10 companies)

### `zero_intervention` — System runs without babysitting
**Success criteria:** Carlos spends <15 min/day. No manual retries, no stuck cycles, no silent failures lasting >6 hours.

Key outcomes:
- PR auto-merge for company repos (hive/* branches after build passes)
- Failed tasks auto-retry with circuit breakers that don't block critical work
- Stale cycles auto-cleanup, stuck dispatches auto-reset
- Dashboard shows actionable alerts, not noise
- Telegram notifications are clear and linked to source

### `self_healing` — Hive fixes its own bugs
**Success criteria:** 80%+ of recurring errors are auto-fixed by Healer within 48h without manual intervention.

Key outcomes:
- Error patterns detected and correlated across companies
- Healer dispatches targeted fixes to company repos
- Fix patterns written to playbook for future prevention

---

## Phase 3 — Intelligence & Self-Improvement

### `self_improving` — Hive gets smarter over time
**Success criteria:** Agent success rates measurably improve quarter-over-quarter. Playbook entries drive real behavioral changes.

Key outcomes:
- Evolver detects gaps and proposes prompt improvements
- Playbook entries auto-applied to struggling companies
- Backlog items auto-decomposed when too complex
- Context optimization prevents max_turns exhaustion
- Model routing adapts based on task success rates

### `code_quality` — Companies ship reliable code
**Success criteria:** Zero security vulnerabilities in deployed code. All company repos have CI, linting, and basic test coverage.

Key outcomes:
- Pre-push workflow YAML validation
- Inline code review within Engineer workflow
- Security scanning on ongoing deploys
- Prompt injection defense for agent inputs

### `portfolio_intelligence` — Data-driven portfolio decisions
**Success criteria:** Venture Brain correctly identifies underperformers and recommends kills based on data, not gut.

Key outcomes:
- Portfolio-level charts (MRR trends, company comparison)
- Cross-company pattern matching for knowledge transfer
- Kill decisions backed by multi-signal consensus

---

## Phase 4 — Scale & Platform

### `full_autonomy` — 10+ companies, <15 min/day
**Success criteria:** Portfolio of 10+ companies generating €10K+ MRR total. Infrastructure costs covered by revenue.

Key outcomes:
- Claude Agent SDK replaces GitHub Actions turn limits
- Companies handle their own customer support
- Multi-framework boilerplate (Next.js, Astro, SvelteKit)
- Telegram/WhatsApp approval bot
- Business model diversity (SaaS, blogs, affiliates, newsletters)

---

## Key Decisions Log

Decisions that shaped the platform direction (detail in DECISIONS.md):

| # | Date | Decision | Why |
|---|------|----------|-----|
| ADR-001 | 2026-03-18 | Mac-based intelligence + cloud serving | Claude Max 5x subscription, no API costs |
| ADR-002 | 2026-03-18 | Single Stripe account, metadata-tagged | Simpler than Connect, no KYC per company |
| ADR-004 | 2026-03-18 | Sequential nightly processing | Shared Claude quota, can't parallelise |
| ADR-009 | 2026-03-18 | Multi-provider model routing | Save Claude quota for brain tasks |
| ADR-010 | 2026-03-19 | Multi-repo with shared intelligence | Clean isolation, Polsia-validated pattern |
| ADR-013 | 2026-03-19 | Per-agent model selection | Opus for strategic, Sonnet for code, Flash for content |
| ADR-021 | 2026-03-21 | Public company repos | Free GitHub Actions minutes, company-side workflows |
| — | 2026-03-21 | Free tier first, upgrade on revenue | MVP companies cost €0, paid infra only after proving revenue |
