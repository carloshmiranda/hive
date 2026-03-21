# Hive Platform Roadmap

> Strategic roadmap for Hive as a platform. Not task-level (that's BACKLOG.md). This tracks phases, milestones, and the long-term vision.
>
> Updated during brainstorming sessions. The orchestrator reads this to understand strategic direction but doesn't modify it — only Carlos and Chat/Code sessions update this file.

## Vision

Hive is an autonomous venture orchestrator that generates business ideas, builds companies, manages them via AI agents, and kills failures — with Carlos approving 4 gates (new company, growth strategy, spend >€20, kill). The long-term goal: a portfolio of 5-10 self-running micro-SaaS companies generating €10K+ MRR total, managed by AI agents, requiring <30 min/day of Carlos's attention.

## Current Phase: 🟡 Phase 1 — First Company

### Milestone: First company running autonomously
- [x] Build Hive dashboard + orchestrator
- [x] Deploy to Vercel
- [x] Multi-provider routing (save Claude quota)
- [x] Cross-company learning architecture
- [x] Configure API keys (Gemini, Groq, Resend)
- [ ] Verify email sending domain
- [x] Run Idea Scout → 3 proposals (9 proposals generated, pending review)
- [ ] Approve first company
- [x] First nightly cycle completes successfully (VerdeDesk 18+ cycles, Senhorio 4 cycles)
- [x] First company deployed to production with landing page (VerdeDesk + Senhorio live on Vercel)

### Milestone: VerdeDesk imported
- [x] Import via dashboard
- [x] Pattern extraction → playbook entries (12 entries extracted)
- [x] First CEO cycle on VerdeDesk (18+ cycles completed)
- [ ] Outreach pipeline active (blocked on email domain)

### Milestone: First revenue
- [ ] Any Hive company receives first Stripe payment
- [ ] Vercel Pro upgrade triggered
- [ ] Validated that the autonomous loop actually generates revenue

## Phase 2 — Portfolio Growth (target: 3-5 active companies)

### Milestone: Scaling the loop
- [ ] 3+ companies running simultaneously without quota issues
- [ ] Cross-company playbook has 20+ high-confidence entries
- [ ] Healer successfully auto-fixes a cross-company error
- [ ] Venture Brain successfully creates a cross-pollination directive

### Milestone: Data-driven organic growth
- [x] GSC API integrated, keyword positions tracked per cycle
- [x] Bing Webmaster Tools integrated
- [x] IndexNow fires on every content publish
- [x] LLM citation tracker running every 3 cycles
- [x] Growth agent never creates content without visibility data
- [x] llms.txt and structured data in all company sites
- [x] Content performance feedback loop (stale content auto-refreshed)

### Milestone: Flolio import
- [x] Import Flolio (growth phase — more complex than fresh MVP)
- [ ] Extract pricing, onboarding, and growth patterns
- [x] Flolio's investment dashboard as a Hive company (4 cycles completed)

### Milestone: Portfolio MRR targets
- [ ] Combined MRR reaches €500/mo
- [ ] Combined MRR reaches €2,000/mo
- [ ] At least 2 companies with paying customers
- [ ] First company killed based on data (not gut feeling)

## Phase 3 — Intelligence Layer

### Milestone: Self-improving Hive
- [ ] Orchestrator proposes improvements to its own codebase (from BACKLOG.md)
- [ ] Prompt Evolver measurably improves an agent's success rate
- [ ] Hive writes a MISTAKES.md entry and the Healer applies the fix next cycle

### Milestone: Advanced portfolio intelligence
- [ ] Portfolio-level charts (MRR trends, company comparison, funnel metrics)
- [ ] Venture Brain makes a correct kill recommendation
- [ ] Capital allocation: shift resources based on performance data

### Milestone: Cloud migration
- [ ] Move from Mac-based Claude CLI to cloud-based Agent SDK
- [ ] Nightly runs happen even when Carlos's Mac is off
- [ ] GitHub Actions or VPS as the intelligence runtime

## Phase 4 — Scale & Autonomy

### Milestone: Full autonomy
- [ ] Telegram/WhatsApp approval bot (approve from phone)
- [ ] Multi-framework boilerplate (not just Next.js)
- [ ] Hive generates, tests, and deploys improvements to itself
- [ ] 5+ companies, <30 min/day human involvement
- [ ] Combined portfolio MRR €10K+

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
