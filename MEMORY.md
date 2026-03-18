# Memory

> Persistent context for Claude Code sessions. Read this before doing anything. It's the institutional knowledge that prevents you from re-learning what previous sessions already discovered.

## Owner
Carlos Miranda — solo entrepreneur based in Amadora, Lisbon, Portugal. 15+ years IT experience. Building Hive as a personal venture orchestrator. Bilingual Portuguese/English. Comfortable with playful humour but expects direct, honest technical feedback.

## Current State
- **Phase:** Pre-deployment (build complete, not yet deployed)
- **Active companies:** None yet
- **Subscription:** Claude Max 5x ($100/mo)
- **Vercel team:** Eidolon's projects (team_Z4AsGtjfy6pAjCOtvJqzMT8d)
- **Existing Vercel projects:** accrue, verdedesk

## Tech Stack
- Next.js 15 (App Router) + Tailwind CSS 4 + TypeScript
- Neon serverless Postgres via Vercel Marketplace
- NextAuth 5.0.0-beta.30 with GitHub OAuth (single-user lockdown)
- Stripe (single account, metadata-tagged products)
- Resend (single account, per-company from addresses)
- Claude Code CLI for orchestrator intelligence
- Vercel Cron for lightweight scheduled tasks

## Key Files
- `CLAUDE.md` — the constitution. Architecture, rules, flows, file structure.
- `MISTAKES.md` — production learnings. Read before making similar changes.
- `BACKLOG.md` — prioritized improvement list. Check before proposing new work.
- `DECISIONS.md` — ADRs. Read before re-debating settled architecture.
- `schema.sql` — 13 Neon tables. Source of truth for data model.
- `orchestrator.ts` — nightly loop runner. Excluded from Next.js build (runs via ts-node).

## Patterns That Work
- Single top-level account per service (Stripe, Neon, GitHub, Resend, Vercel) with per-company tagging/projects
- Sequential company processing due to Claude subscription quota sharing
- Two-tier events: Vercel webhooks (real-time) + nightly Claude loop (strategic)
- Dashboard command bar → GitHub Issues → orchestrator directive pipeline
- Three-attempt escalation: try → reflect → auto-heal → escalate to Carlos
- Import existing projects → scan → onboard → extract patterns to playbook

## Known Gotchas
- next-auth v5 is beta. Pin exact versions.
- Never export helpers from route.ts files. Shared logic goes in src/lib/.
- orchestrator.ts uses Node.js APIs (execSync, crypto). Must be excluded from Next.js build via tsconfig.
- Vercel Hobby is non-commercial. Any company generating revenue needs Pro ($20/mo).
- Claude Code subscription quota is shared across CLI, web, and desktop. Budget ~40 messages per company in nightly loop.
- Vercel Functions have 60s timeout on Hobby. Chain long tasks via QStash or sequential API calls.

## What NOT to Do
- Don't propose Stripe Connect. We use single account + metadata. See ADR-002.
- Don't propose manual Neon setup. It's via Vercel Marketplace. See ADR-003.
- Don't build on top of Flolio. It's a dead project. Learnings are in the playbook, not shared infra.
- Don't add heavy frameworks (LangChain, CrewAI). Raw Claude Code CLI + TypeScript is the stack.
- Don't make the orchestrator always-on. Mac nightly + Vercel webhooks is the model. See ADR-006.
- Don't skip the approval gates. Four gates exist for a reason. See CLAUDE.md operating rules.

## Carlos's Preferences
- Visual thinker — dashboards, diagrams, and clear status indicators matter
- Minimal intervention — approve big decisions, let the system handle everything else
- Honest feedback — prefers direct "this won't work because X" over hedged suggestions
- Vercel-first infrastructure — don't propose AWS, GCP, or other cloud providers
- Free tier maximisation — don't spend money until revenue justifies it

## Session Checklist
Before starting work in any Claude Code session:
1. Read CLAUDE.md (architecture)
2. Read MEMORY.md (this file — current state)
3. Scan MISTAKES.md (don't repeat known errors)
4. Check BACKLOG.md (maybe the work is already planned)
5. Check DECISIONS.md (maybe this was already decided)
6. Check open GitHub Issues (maybe there's a directive)

## Changelog
- 2026-03-18: Project created. All foundational files built. 55 files, ~4,000 lines. Build verified.
- 2026-03-18: Knowledge layer added (MEMORY, MISTAKES, BACKLOG, DECISIONS). Self-improvement protocol.
- 2026-03-18: Idea Scout implemented. Generates business ideas weekly or when portfolio has capacity.
- 2026-03-18: Idea Scout refactored. Removed pre-baked research, now does autonomous web search (methodology, not answers).
- 2026-03-18: All P1 items completed: agent prompt files, digest email, dispatch error handling, Vercel Pro upgrade flow, dashboard live refresh.
- 2026-03-18: Bug fixes: dispatch() rewritten with spawn (was execSync), digest email inlined in orchestrator (can't import Next.js modules), health check endpoint added.
- 2026-03-18: Playbook learning loop + company detail page built. CEO review output parsed for playbook entries and kill flags. Dashboard links to /company/[slug].
