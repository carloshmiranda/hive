# Hive Platform Roadmap

> Strategic roadmap for Hive as a platform. Not task-level (that's BACKLOG.md). This tracks phases, milestones, and the long-term vision.
>
> Updated during brainstorming sessions. The orchestrator reads this to understand strategic direction but doesn't modify it — only Carlos and Chat/Code sessions update this file.

## Vision

Hive is a **fully AI-centric autonomous venture orchestrator**. It spawns businesses, builds them, grows them, and kills failures — all autonomously. Carlos approves 4 gates (new company, growth strategy, spend >€20, kill) and nothing else. The businesses themselves are fully autonomous.

**Key principle: free tiers first.** MVP companies use only free infrastructure (Vercel Hobby, Neon free, Gemini free, Groq free, public repos for free Actions). Better infra (Vercel Pro, dedicated DBs, paid APIs) only after revenue proves the business works.

**Target state:** A portfolio of 10+ self-running micro-businesses generating €10K+ MRR total, managed entirely by AI agents, requiring <15 min/day of Carlos's attention.

## Current Phase: 🟡 Phase 1 — First Revenue

### Milestone: Companies iterating autonomously ✅
- [x] Build Hive dashboard + orchestrator
- [x] Deploy to Vercel
- [x] Multi-provider routing (Claude for brain, Gemini/Groq for workers)
- [x] Cross-company learning architecture (playbook, error correlation)
- [x] Run Idea Scout → 3 proposals (9 proposals generated)
- [x] First nightly cycles complete (VerdeDesk 18+, Senhorio 4, Flolio 4)
- [x] Companies deployed to production (3 live on Vercel)
- [x] Company-side workflows running on free public repos
- [x] Task tracking system (company_tasks table + dashboard + agent integration)

### Milestone: Dispatch chain working end-to-end
- [x] CEO → Engineer dispatch (repository_dispatch)
- [x] Engineer → company repo dispatch (workflow_dispatch) — fixed 422 payload bug
- [x] Company repo hive-build.yml completes a real feature build
- [ ] Company repo hive-growth.yml creates real content
- [ ] Growth dispatches to company repo with Vercel fallback
- [ ] Full chain verified: CEO plan → Engineer build → Growth content → Ops verify

### Milestone: First revenue
- [ ] Email sending domain verified (Resend)
- [x] Stripe products created per company (auto-provision)
- [ ] Outreach pipeline sending real emails
- [ ] Any Hive company receives first Stripe payment
- [ ] MVP → active transition triggers (first_revenue approval)
- [ ] Validated that the autonomous loop generates revenue

## Phase 2 — Portfolio at Scale (target: 5-10 companies)

### Milestone: Free-tier-first company infra
- [ ] Per-company Neon databases (free tier: 10 projects)
- [ ] Automatic Vercel Hobby → Pro upgrade on first revenue
- [ ] Companies use Gemini/Groq for all worker tasks (zero Claude burn)
- [ ] Cost tracking visible in dashboard + digest
- [ ] Budget alerts when approaching free tier limits

### Milestone: Zero-intervention operation
- [ ] PR auto-merge for company repos (hive/* branches after build passes)
- [ ] Scout proposal auto-expiry (7 days without review → rejected)
- [ ] Secret scanning before repos go public
- [ ] Failed task auto-retry verified working (Sentinel check 13c)
- [ ] Stuck cycle auto-cleanup verified (Sentinel 2h guard)
- [ ] Batch approve/reject in dashboard inbox

### Milestone: Revenue scaling
- [ ] Combined MRR reaches €500/mo
- [ ] At least 2 companies with paying customers
- [ ] Combined MRR reaches €2,000/mo
- [ ] First company killed based on data (Venture Brain recommendation)
- [ ] Capital reallocation: shift resources from failing to growing companies

### Milestone: Data-driven growth intelligence ✅
- [x] GSC API integrated, keyword positions tracked
- [x] IndexNow fires on every content publish
- [x] LLM citation tracker running every 3 cycles
- [x] Content performance feedback loop (stale content auto-refreshed)
- [x] Growth agent never creates content without visibility data

## Phase 3 — Intelligence & Self-Improvement

### Milestone: Self-improving Hive
- [ ] Orchestrator proposes and implements improvements to its own codebase (from BACKLOG.md)
- [ ] Evolver measurably improves an agent's success rate (before/after comparison)
- [ ] Hive writes a MISTAKES.md entry and Healer auto-applies the fix
- [ ] Playbook entries auto-applied to struggling companies (no manual directive needed)
- [ ] Performance-driven model routing (success rate → model selection)

### Milestone: Advanced portfolio intelligence
- [ ] Portfolio-level charts (MRR trends, company comparison, funnel metrics)
- [ ] Venture Brain makes a correct kill recommendation
- [ ] Cross-company pattern matching ("company A solved this, apply to company B")
- [ ] Cycle score correlation analysis (what agent behaviors lead to higher scores)
- [ ] Company health score (composite: revenue trend + traffic + error rate + cycle scores)

### Milestone: Full business autonomy
- [ ] Companies handle their own customer support (FAQ bot, email replies)
- [ ] Companies run their own A/B tests and optimize conversion
- [ ] Companies detect and respond to competitor moves
- [ ] Churn prediction and win-back sequences
- [ ] LTV/CAC tracking per company

## Phase 4 — Scale & Platform

### Milestone: Cloud-native orchestration
- [ ] Claude Agent SDK replaces GitHub Actions turn limits
- [ ] VPS or Lambda as intelligence runtime (GitHub Actions as fallback)
- [ ] Parallel company processing (not sequential)
- [ ] 20+ companies manageable without quota exhaustion

### Milestone: Full autonomy
- [ ] Telegram/WhatsApp approval bot (approve from phone)
- [ ] Multi-framework boilerplate (Next.js, Astro, SvelteKit — CEO picks based on use case)
- [ ] Hive generates, tests, and deploys improvements to itself
- [ ] 10+ companies, <15 min/day human involvement
- [ ] Combined portfolio MRR €10K+
- [ ] Self-funded: portfolio revenue covers all infrastructure costs

### Milestone: Business model diversity
- [ ] SaaS companies (subscription revenue)
- [ ] Content/affiliate sites (ad/affiliate revenue)
- [ ] Faceless YouTube/social channels (ad revenue)
- [ ] Newsletter businesses (sponsorship revenue)
- [ ] API/tool businesses (usage-based revenue)

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
