# Hive Architecture

> High-level view of how Hive works. For detailed rules and flows, see CLAUDE.md.

## System Overview

Hive is an autonomous venture orchestrator that builds, runs, and evaluates digital companies. It runs entirely in the cloud via GitHub Actions + Vercel serverless, with Neon Postgres as the shared state layer.

```
┌─────────────────────────────────────────────────────────────────────┐
│                         TRIGGERS                                     │
│  Stripe webhooks │ GitHub events │ Sentinel (4h) │ Manual dispatch   │
└────────┬────────────────┬───────────────┬────────────────┬──────────┘
         │                │               │                │
         ▼                ▼               ▼                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    GitHub Actions Workflows                          │
│                                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐    │
│  │   CEO    │  │ Engineer │  │  Scout   │  │    Sentinel      │    │
│  │  (Opus)  │  │ (Sonnet) │  │  (Opus)  │  │  (Node.js, no AI)│    │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────────┬─────────┘    │
│       │              │              │                 │              │
│  ┌────┴─────┐  ┌────┴─────┐                                        │
│  │ Evolver  │  │  Digest  │        ┌──────────────────────┐         │
│  │  (Opus)  │  │ (No AI)  │        │   Worker Dispatch    │         │
│  └──────────┘  └──────────┘        │  (routes to Vercel)  │         │
│                                     └──────────┬───────────┘         │
└──────────────────────────────────────────────────┼───────────────────┘
                                                   │
                                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Vercel Serverless Functions                        │
│                                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │
│  │   Growth     │  │  Outreach    │  │    Ops       │              │
│  │ (Gemini 2.5) │  │ (Gemini 2.5) │  │ (Groq Llama)│              │
│  └──────────────┘  └──────────────┘  └──────────────┘              │
│                                                                      │
│  Dashboard │ Webhooks (Stripe/GitHub) │ Cron (metrics) │ APIs       │
└──────────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         Neon Postgres                                │
│                    (shared state layer)                              │
│                                                                      │
│  companies │ cycles │ approvals │ agent_actions │ metrics           │
│  playbook │ research_reports │ settings │ infra │ directives        │
└─────────────────────────────────────────────────────────────────────┘
```

## Agent Architecture (7 agents)

| Agent | Runtime | Model | Trigger | Role |
|-------|---------|-------|---------|------|
| **CEO** | GitHub Actions | Claude Opus | Payments, cycle completions, gates, PRs, directives | Strategic planning, cycle review, scoring, kill decisions |
| **Scout** | GitHub Actions | Claude Opus | Pipeline low, company killed, research requests | Market research, idea generation, competitive analysis |
| **Engineer** | GitHub Actions | Claude Sonnet | Features, bugs, ops escalation, new companies | Code, deploy, scaffold, infrastructure provisioning |
| **Evolver** | GitHub Actions | Claude Opus | Weekly + failure rate triggers | Gap analysis, prompt improvement, process proposals |
| **Growth** | Vercel serverless | Gemini 2.5 Flash | Scout research delivered, sentinel (stale content) | SEO content, social media, email sequences |
| **Outreach** | Vercel serverless | Gemini 2.5 Flash | Scout leads found, sentinel (stale leads) | Lead lists, cold email, follow-ups |
| **Ops** | Vercel serverless | Groq Llama 3.3 70B | Deploy events, sentinel, health checks | Metrics collection, health monitoring |

### Special case: Growth Pre-Spec
In build mode (cycles 0-2), Growth runs BEFORE Engineer to plan distribution. This step routes to **Claude** (not Gemini) because it's strategic planning, not content creation.

## Event Flow

### Inter-Agent Communication
All agent-to-agent communication uses `repository_dispatch` events. No real-time messaging — structured async handoffs via Neon DB.

```
Sentinel (every 4h) ──→ detects 12 health conditions ──→ dispatches appropriate agent

CEO ──→ Engineer (feature_request, new_company)
CEO ──→ Scout (research_request)
CEO ──→ Growth/Outreach (via worker dispatch)
CEO ──→ Evolver (cycle_complete)

Engineer ──→ CEO (ceo_review, when PR opened)

Scout ──→ Growth (research delivered)
Scout ──→ Outreach (leads found)

Ops ──→ Engineer (ops_escalation, when issues found)
```

### Sentinel Health Conditions (12 checks, every 4h)
1. Pipeline low (< 3 companies) → Scout
2. Stale content (7d without Growth) → Growth
3. Stale leads (5d old lead list) → Outreach
4. No CEO review (48h) → CEO
5. Unverified deploys (24h) → Ops
6. Evolve due (10+ cycles since last) → Evolver
7. High failure rate (>20% in 48h) → Evolver
8. Stale research (14d) → Scout
9. Stuck in approved (1h) → Engineer
10. Max turns exhaustion → Evolver
11. Chain dispatch gaps → Engineer
12. Deploy drift (SHA mismatch) → Engineer

## Company Lifecycle

```
Scout proposes idea
  → CEO evaluates (expand-vs-new decision)
    → Carlos approves/rejects in dashboard
      → Engineer provisions (GitHub repo, Vercel, Neon, Stripe)
        → Company cycles begin:
          1. CEO plans (structured JSON with task IDs)
          2. Growth pre-specs distribution (build mode only)
          3. Engineer builds (informed by CEO plan + Growth pre-spec)
          4. Growth creates content (informed by CEO plan + Engineer results)
          5. Outreach runs lead gen
          6. Ops collects metrics
          7. CEO reviews (grades agents, extracts playbook)
```

### Structured Handoffs Between Agents
Agents pass typed JSON (not raw text) between steps:

| From → To | Handoff Schema |
|-----------|----------------|
| CEO → Engineer | `engineering_tasks[{id, task, acceptance, complexity}]` |
| CEO → Growth | `growth_tasks[{id, task, rationale, target_keyword}]` |
| Growth pre-spec → Engineer | `{distribution_channels, seo_requirements, build_requests}` |
| Engineer → CEO review | `tasks_completed[{task_id, status, commit, files_changed}]` |
| Growth → CEO review | `content_created[{task_id, type, status}]` |
| CEO review → DB | `{score, agent_grades, playbook_entry, next_cycle_priorities}` |
| Scout → CEO eval | `{proposals with expansion_candidate, synergy data}` |

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Dashboard | Next.js (App Router) + Tailwind | Carlos's control panel |
| Auth | NextAuth v5 + GitHub OAuth | Single-user lockdown |
| Database | Neon Postgres (serverless) | Shared state, all agent data |
| Orchestration | GitHub Actions | Agent dispatch + scheduling |
| Brain agents | Claude Code Action (Opus/Sonnet) | Strategic + coding tasks |
| Worker agents | Vercel serverless + Gemini/Groq | Content, email, metrics |
| Payments | Stripe (single account, products tagged by company) | Revenue tracking |
| Email | Resend API | Digest, outreach, transactional |
| Webhooks | Vercel API routes | Stripe, GitHub events |

## Cost Model

| Resource | Tier | Limit | Usage |
|----------|------|-------|-------|
| Claude | Max 5x subscription | ~225 msgs/5hr window | CEO, Scout, Engineer, Evolver |
| Gemini | Free API | 250 RPD | Growth, Outreach (~5-10 req/day) |
| Groq | Free API | ~6,000 RPD | Ops (~2-4 req/day) |
| GitHub Actions | Free (public) / 2,000 min (private) | Per month | ~20-30 min/day |
| Vercel | Pro | Generous limits | Dashboard + serverless agents |
| Neon | Free tier | 0.5 GB | All agent state |
| Resend | Free tier | 100 emails/day | Digest + outreach |

## Key Files

| File | Purpose |
|------|---------|
| `CLAUDE.md` | Constitution — detailed rules, flows, standards |
| `BRIEFING.md` | Current state — read first every session |
| `ARCHITECTURE.md` | This file — high-level system design |
| `BACKLOG.md` | Prioritized improvements |
| `DECISIONS.md` | Architectural decision records |
| `MISTAKES.md` | Production learnings |
| `schema.sql` | Database schema |
| `.github/workflows/*.yml` | GitHub Actions workflows (primary orchestration) |
| `prompts/*.md` | Agent system prompts (CEO, Engineer, Growth, Scout) |
| `.github/workflows/*.yml` | GitHub Actions workflows (primary orchestration) |
| `src/app/page.tsx` | Dashboard |
| `src/app/api/agents/dispatch/route.ts` | Worker agent dispatch endpoint |

## Cross-Company Knowledge Flow

```
Company A cycle results ──→ Playbook entries ──→ Injected into Company B's CLAUDE.md
Company A error fix ──→ Healer cross-correlates ──→ Fix context for Company B
Venture Brain insight ──→ Directive for Company B ──→ CEO picks up next cycle
```

All knowledge flows through Neon — no code imports between company repos.
