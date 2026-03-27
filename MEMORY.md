# Memory

> Persistent context for Claude Code sessions. Read this before doing anything. It's the institutional knowledge that prevents you from re-learning what previous sessions already discovered.

## Owner
Carlos Miranda — solo entrepreneur based in Amadora, Lisbon, Portugal. 15+ years IT experience. Building Hive as a personal venture orchestrator. Bilingual Portuguese/English. Comfortable with playful humour but expects direct, honest technical feedback.

## Current State
- **Phase:** Deployed — all P0/P1/P2 complete. Ready for first orchestrator run.
- **Production URL:** https://hive-phi.vercel.app
- **Vercel project ID:** prj_n9JaPbWmRv0SKoHgkdXYOEGQtjRv
- **Latest deploy:** READY (dpl_HgG1x6GKfteZCq8UyEEWVcBeT2Pg)
- **Active companies:** None yet — run `--scout-only` to generate first idea
- **Subscription:** Claude Max 5x ($100/mo)
- **Vercel team:** Eidolon's projects (team_Z4AsGtjfy6pAjCOtvJqzMT8d)
- **Other Vercel projects:** accrue, verdedesk (candidates for import into Hive)

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
- `BACKLOG.md` — auto-generated snapshot of `hive_backlog` DB. Read-only, never edit. Use MCP tools or `/api/agents/backlog`.
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
- orchestrator.ts uses Node.js APIs (spawn, crypto). Must be excluded from Next.js build via tsconfig.
- orchestrator.ts cannot import from src/ (path aliases don't resolve in ts-node). Shares DATA via Neon, never CODE.
- Vercel Hobby is non-commercial. Any company generating revenue needs Pro ($20/mo).
- Claude Code subscription quota is shared across CLI, web, and desktop. Budget ~40 messages per company in nightly loop.
- Without gemini_api_key and groq_api_key in settings, ALL agents fall back to Claude — works for 1-2 companies, burns quota at 3+. Get free keys: aistudio.google.com/apikey and console.groq.com/keys.
- Gemini free tier RPD resets at midnight Pacific Time, not UTC. Factor this into nightly loop timing.
- Vercel Functions have 60s timeout on Hobby. Chain long tasks via QStash or sequential API calls.
- Vercel has a read-only filesystem. Never use `fs.writeFile` for persistent changes — use GitHub Contents API for git files, Vercel Blob for storage.
- BACKLOG.md is auto-generated from DB. Never edit it manually — use MCP tools or `/api/agents/backlog`.

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
4. Check backlog DB via MCP `mcp__hive__hive_backlog` (maybe the work is already planned)
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
- 2026-03-18: All P2 items completed: Prompt Evolver (weekly Wednesday), social media posting (X API v2), Resend transactional templates (welcome, receipt, password reset). Full backlog cleared.
- 2026-03-18: Critical bugs fixed: auth.ts env var names (GITHUB_OAUTH_ID → AUTH_GITHUB_ID), middleware excluding webhooks/cron/health, GitHub webhook HMAC-SHA256 verification added. These were being overwritten by every archive update.
- 2026-03-18: Deployment confirmed live at hive-phi.vercel.app (READY). Vercel project prj_n9JaPbWmRv0SKoHgkdXYOEGQtjRv. 71 files, 20 pages, all P0/P1/P2 complete.
- 2026-03-18: Polsia feature parity: Outreach agent wired into nightly cycle (lead gen + cold email pipeline via Resend), periodic research refresh (competitive analysis every 7 cycles), research reports rendered in company detail page.
- 2026-03-18: Self-healing architecture: pre-flight health check, Healer agent (systemic + company-specific error fixing), action-oriented retries (error context + fix instructions on attempts 2-3), error pattern classification.
- 2026-03-18: Multi-provider dispatch: Brain agents (CEO, Idea Scout, Research, Venture Brain, Healer, Evolver) on Claude CLI. Workers (Growth, Outreach) on Gemini free tier. Ops on Groq free tier. Engineer on Claude (needs cwd). Fallback chain: Gemini → Groq → Claude. Needs gemini_api_key + groq_api_key in settings.
- 2026-03-19: Cross-company learning architecture implemented (ADR-010). Multi-repo confirmed as architecture choice. Three mechanisms: (1) Provisioner injects playbook entries + known pitfalls into new company CLAUDE.md, (2) Healer queries agent_actions for similar fixes from other companies before dispatching repairs, (3) Venture Brain creates cross-pollination directives when learnings from one company apply to another.
- 2026-03-19: Idea Scout rewritten to generate 3 proposals (1 PT, 1 Global, 1 best-pick). Scouting triggers when pipeline < 3 companies. Company processing priority: new first, struggling next, oldest as tiebreaker. Nightly loop reordered: Provision + Imports before company cycles.
- 2026-03-19: Worker agent dispatch system: Vercel serverless endpoint (/api/agents/dispatch) + GitHub Actions scheduler. Growth 3x/day, Ops 4x/day, Outreach daily. Gemini/Groq HTTP calls, 120s maxDuration. €0 additional cost.
- 2026-03-19: Critical schema fixes (migration 002): agent_actions cycle_id/company_id now nullable, agent CHECK expanded (+outreach, research_analyst, healer, orchestrator), approvals gate_type CHECK expanded (+outreach_batch, vercel_pro_upgrade, social_account, first_revenue), settings table added to schema.sql. Without this migration, every orchestrator run would crash on first Idea Scout or Healer action.
- 2026-03-19: Event-driven architecture migration. Agents consolidated from 10 to 7 (migration 003). Mac launchd replaced by GitHub Actions event-driven workflows. Brain agents (CEO, Scout, Engineer, Evolver) run on GitHub runners via `anthropics/claude-code-base-action` + `CLAUDE_CODE_OAUTH_TOKEN`. Worker agents (Ops, Growth, Outreach) dispatched via `repository_dispatch` → Vercel serverless. Agent chains: each workflow's final step dispatches the next via `repository_dispatch`. Sentinel workflow (only scheduled thing) runs every 4h, queries Neon for 7 conditions, dispatches agents with work. Vercel has zero crons. Secrets: `CLAUDE_CODE_OAUTH_TOKEN` (Max 5x OAuth), `GH_PAT` (for repository_dispatch), `DATABASE_URL`, `CRON_SECRET`. Cost: $100/mo (Max 5x only). ~915 min/mo GitHub Actions (46% of 2,000 free).
