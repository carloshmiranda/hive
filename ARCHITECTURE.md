# Hive Architecture

> Visual guide to how Hive works. Open this to understand the system at a glance.

## System Overview

Hive is an autonomous venture orchestrator. It builds, runs, and evaluates digital companies using AI agents coordinated through GitHub Actions, Vercel serverless, and a shared Neon Postgres database.

```
                              ┌─────────────────────┐
                              │      CARLOS          │
                              │   (dashboard, CLI)   │
                              └──────────┬──────────┘
                                         │ approve/reject/directive
                                         ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                          HIVE ORCHESTRATOR                               │
│                     (private repo: carloshmiranda/hive)                  │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                 GitHub Actions (Brain Agents)                    │    │
│  │                                                                  │    │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐ ┌────────┐ │    │
│  │  │   CEO    │ │  Scout   │ │ Engineer │ │Evolver │ │ Healer │ │    │
│  │  │  Opus    │ │  Opus    │ │ Sonnet   │ │ Opus   │ │Sonnet  │ │    │
│  │  └──────────┘ └──────────┘ └──────────┘ └────────┘ └────────┘ │    │
│  │                                                                  │    │
│  │  ┌──────────────┐  ┌──────────────┐                             │    │
│  │  │   Sentinel   │  │    Digest    │   (no AI, Node.js only)     │    │
│  │  │  (cron, 4h)  │  │ (cron, 8am) │                              │    │
│  │  └──────────────┘  └──────────────┘                             │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │              Vercel (Dashboard + APIs + Workers)                 │    │
│  │                                                                  │    │
│  │  Dashboard │ Webhooks │ Crons │ /api/agents/token (OIDC)        │    │
│  │                                                                  │    │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │    │
│  │  │   Growth     │  │  Outreach    │  │    Ops       │          │    │
│  │  │ Gemini Flash │  │ Gemini Flash │  │ Groq Llama   │          │    │
│  │  └──────────────┘  └──────────────┘  └──────────────┘          │    │
│  └─────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────┘
         │                    │                       │
         │ repository_        │ OIDC token            │ direct DB
         │ dispatch           │ exchange              │ queries
         ▼                    ▼                       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                       COMPANY REPOS (public, free Actions)               │
│                                                                          │
│  ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐        │
│  │    verdedesk      │ │    senhorio       │ │     flolio       │        │
│  │                   │ │                   │ │                  │        │
│  │  hive-build.yml   │ │  hive-build.yml   │ │  hive-build.yml  │        │
│  │  hive-growth.yml  │ │  hive-growth.yml  │ │  hive-growth.yml │        │
│  │  hive-fix.yml     │ │  hive-fix.yml     │ │  hive-fix.yml    │        │
│  │                   │ │                   │ │                  │        │
│  │  Next.js app      │ │  Next.js app      │ │  Next.js app     │        │
│  │  (deployed on     │ │  (deployed on     │ │  (deployed on    │        │
│  │   Vercel Hobby)   │ │   Vercel Hobby)   │ │   Vercel Hobby)  │        │
│  └──────────────────┘ └──────────────────┘ └──────────────────┘        │
└──────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                         NEON POSTGRES                                     │
│                    (single shared database)                               │
│                                                                          │
│  companies │ cycles │ approvals │ agent_actions │ metrics │ settings     │
│  playbook │ research_reports │ company_tasks │ infra │ directives        │
│  social_accounts │ evolver_proposals │ agent_prompts │ context_log       │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## Dispatch Chain: How Work Flows

```
                    ┌──────────────┐
                    │   TRIGGERS   │
                    └──────┬───────┘
                           │
         ┌─────────────────┼─────────────────────────────┐
         │                 │                              │
         ▼                 ▼                              ▼
  Stripe webhook     Sentinel (4h)              Manual dispatch
  (payment event)    (health checks)            (dashboard/CLI)
         │                 │                              │
         └────────┬────────┘──────────────────────────────┘
                  │
                  ▼
         ┌────────────────┐
         │      CEO       │  Plans the cycle, decides what to build
         │   (Hive repo)  │
         └───────┬────────┘
                 │
      ┌──────────┼──────────────┬──────────────────┐
      │          │              │                   │
      ▼          ▼              ▼                   ▼
 ┌─────────┐ ┌─────────┐ ┌──────────┐      ┌──────────────┐
 │Engineer │ │ Growth  │ │ Outreach │      │    Scout     │
 │(company │ │(company │ │ (Vercel  │      │  (Hive repo) │
 │  repo)  │ │  repo)  │ │ worker)  │      │              │
 └────┬────┘ └────┬────┘ └──────────┘      └──────────────┘
      │           │
      │ PR opened │ content pushed
      │           │
      ▼           ▼
 ┌────────────────────┐
 │     CEO Review     │  Scores cycle, grades agents, extracts learnings
 │    (Hive repo)     │
 └────────────────────┘
```

### Decentralized Dispatch (company-scoped work)

Brain agents (CEO, Scout, Evolver, Healer) run on the **Hive private repo**.
Company-scoped work (build, fix, growth) runs on **company public repos** (free Actions).

```
Hive CEO plans cycle for VerdeDesk
  │
  ├──► dispatches workflow_dispatch to carloshmiranda/verdedesk
  │    └── hive-build.yml runs on verdedesk (free, public repo)
  │        └── Claude builds feature, opens PR
  │
  ├──► dispatches workflow_dispatch to carloshmiranda/verdedesk
  │    └── hive-growth.yml runs on verdedesk (free, public repo)
  │        └── Gemini creates content, pushes to main
  │
  └──► dispatches to Vercel /api/agents/dispatch
       └── Outreach worker runs (Gemini, serverless)
```

**Fallback:** If a company has no `github_repo`, work falls back to the Hive repo workflows.

---

## OIDC Token Exchange (Zero Secrets on Public Repos)

Company repos are public. Auth tokens (Claude, Gemini, GH PAT) are NOT stored as repo secrets.
Instead, workflows use GitHub OIDC to prove their identity and fetch tokens at runtime.

```
Company Repo Workflow                          Hive Vercel API
────────────────────                           ───────────────

1. Request OIDC JWT          ──────────►  GitHub OIDC Provider
   (proves "I am verdedesk                     │
    running hive-build.yml")                   │ signed JWT
                                               │
2. Send JWT to Hive          ◄─────────────────┘
   POST /api/agents/token    ──────────►  3. Validate JWT:
   Authorization: Bearer <JWT>               - issuer = GitHub
   {"token_type": "claude"}                  - audience = hive-phi.vercel.app
                                             - repo_owner = carloshmiranda
                                             - workflow in allowlist
                                             - repo in companies table
                                          4. Decrypt token from
                                             settings table
                             ◄──────────  5. Return token

6. Pass token to
   claude-code-action

Company repo secrets: only DATABASE_URL (for context loading)
All auth tokens: stored once in Hive's encrypted settings table
```

### Allowed Workflows
Only these workflow files can request tokens:
- `hive-build.yml` → requests `claude` + `github_pat`
- `hive-fix.yml` → requests `claude` + `github_pat`
- `hive-growth.yml` → requests `gemini` + `github_pat`

---

## Sentinel: Health Monitor (every 4 hours)

The Sentinel is the only scheduled cron. It checks 20 health conditions and dispatches the right agent.

```
Sentinel runs (GitHub Actions cron)
  │
  ├── Check 1: Pipeline low?              ──► Scout (research new ideas)
  ├── Check 2: Stale content? (7d)        ──► Growth (company repo)
  ├── Check 3: Stale leads? (5d)          ──► Outreach (Vercel worker)
  ├── Check 4: No CEO review? (48h)       ──► CEO
  ├── Check 5: Unverified deploys? (24h)  ──► Ops
  ├── Check 6: Evolve due? (10+ cycles)   ──► Evolver
  ├── Check 7: High failure rate? (>20%)  ──► Evolver
  ├── Check 8: Stale research? (14d)      ──► Scout
  ├── Check 9: Stuck in approved? (1h)    ──► Engineer (company repo)
  ├── Check 10: Rate-limited? (0 turns)   ──► Re-dispatch original
  ├── Check 11: Chain gaps?               ──► Engineer (company repo)
  ├── Check 12: Deploy drift?             ──► Engineer (company repo)
  ├── Check 13: Failed tasks?             ──► Engineer/Growth (company repo)
  ├── Check 14: Orphaned MVPs?            ──► Engineer (provision)
  ├── Check 15: Broken deploys? (HTTP)    ──► Ops
  ├── Check 16: Missing metrics?          ──► Ops
  ├── Check 17: Content performance?      ──► Growth (company repo)
  ├── Check 18: Anomaly detection?        ──► Evolver
  ├── Check 19: Pending proposals?        ──► CEO
  └── Check 20: Boilerplate migration?    ──► Engineer
```

---

## Company Lifecycle

```
┌─────────┐    ┌──────────┐    ┌──────────────┐    ┌───────┐    ┌────────┐
│  idea   │───►│ approved │───►│ provisioning │───►│  mvp  │───►│ active │
│         │    │          │    │              │    │       │    │        │
│ Scout   │    │ Carlos   │    │ Engineer     │    │ Build │    │Revenue │
│proposes │    │approves  │    │scaffolds:    │    │cycles │    │> $0    │
│         │    │          │    │- GitHub repo │    │       │    │        │
│         │    │          │    │- Vercel proj │    │       │    │        │
│         │    │          │    │- Neon DB     │    │       │    │        │
│         │    │          │    │- Stripe prod │    │       │    │        │
└─────────┘    └──────────┘    └──────────────┘    └───────┘    └────────┘
                                                        │
                                               ┌────────┴────────┐
                                               │  BUILD mode     │
                                               │  (cycles 0-2)   │
                                               │  Features +     │
                                               │  waitlist        │
                                               ├─────────────────┤
                                               │  LAUNCH mode    │
                                               │  (cycles 3-5)   │
                                               │  Conversion +   │
                                               │  growth         │
                                               ├─────────────────┤
                                               │  OPTIMIZE mode  │
                                               │  (cycles 6+)    │
                                               │  Metrics-driven │
                                               └─────────────────┘
                                                        │
                                                        ▼
                                               ┌─────────────────┐
                                               │    killed        │
                                               │  (if no traction │
                                               │   after LAUNCH)  │
                                               └─────────────────┘
```

---

## Task Tracking

Tasks flow from CEO plans to agent execution with status tracking.

```
CEO writes cycle plan
  │
  ├── engineering_tasks ──► company_tasks table (category: engineering)
  └── growth_tasks      ──► company_tasks table (category: growth)
         │
         ▼
  ┌──────────┐    ┌─────────────┐    ┌──────────┐    ┌──────┐
  │ proposed │───►│  approved   │───►│in_progress│───►│ done │
  └──────────┘    └─────────────┘    └──────────┘    └──────┘
                        │                  │
                        │            Agent marks         Agent verifies
                        │            before starting     acceptance criteria
                        │                                then marks done
                        ▼
                  ┌───────────┐
                  │ dismissed │  (if no longer relevant)
                  └───────────┘

Dashboard: Tasks tab with company + category filters
Sentinel: Check 13 detects approved-but-not-done tasks, re-dispatches
```

---

## Cross-Company Knowledge Flow

All companies share one database. Knowledge flows automatically.

```
┌─────────────────────────────────────────────────────────────┐
│                    NEON POSTGRES (shared)                     │
│                                                              │
│  ┌────────────┐                                              │
│  │  playbook  │◄── CEO review writes learnings               │
│  │            │◄── Healer writes fix patterns                 │
│  │            │──► Provisioner injects into new company CLAUDEs│
│  └────────────┘                                              │
│                                                              │
│  ┌────────────────┐                                          │
│  │ agent_actions   │◄── Every agent logs what it did          │
│  │                 │──► Healer cross-correlates errors        │
│  │                 │──► "Fixed in CompanyA, apply to CompanyB"│
│  └────────────────┘                                          │
│                                                              │
│  ┌────────────────────┐                                      │
│  │ research_reports    │◄── Scout writes market research      │
│  │                     │──► CEO reads for planning            │
│  │                     │──► Engineer reads for context         │
│  │                     │──► Growth reads for content strategy  │
│  └────────────────────┘                                      │
└──────────────────────────────────────────────────────────────┘
```

---

## Agent Details

### Brain Agents (Hive private repo, Claude via Max subscription)

| Agent | Workflow | Model | Max Turns | Triggers |
|-------|----------|-------|-----------|----------|
| CEO | `hive-ceo.yml` | Opus | 40 | `cycle_start`, `cycle_complete`, `gate_approved`, `stripe_payment`, `ceo_review` |
| Scout | `hive-scout.yml` | Opus | 50 | `research_request`, Sentinel (pipeline low) |
| Engineer | `hive-engineer.yml` | Sonnet | 35 | `feature_request`, `new_company`, `ops_escalation` |
| Evolver | `hive-evolver.yml` | Opus | 30 | Sentinel (weekly, high failure, anomaly) |
| Healer | `hive-healer.yml` | Sonnet | 25 | Sentinel (systemic errors) |

### Worker Agents (Vercel serverless, free-tier LLMs)

| Agent | Endpoint | Model | Triggers |
|-------|----------|-------|----------|
| Growth | `/api/agents/dispatch` | Gemini 2.5 Flash | CEO plan, Sentinel (stale content) |
| Outreach | `/api/agents/dispatch` | Gemini 2.5 Flash | CEO plan, Sentinel (stale leads) |
| Ops | `/api/agents/dispatch` | Groq Llama 3.3 70B | Sentinel (health checks), deploy events |

### Company Repo Agents (public repos, free Actions, Claude/Gemini)

| Workflow | Model | Token Source | Purpose |
|----------|-------|-------------|---------|
| `hive-build.yml` | Claude Sonnet (via OIDC) | `/api/agents/token` | Build features, fix bugs |
| `hive-fix.yml` | Claude Sonnet (via OIDC) | `/api/agents/token` | Emergency fixes |
| `hive-growth.yml` | Gemini Flash (via OIDC) | `/api/agents/token` | SEO content, blog posts |

---

## Security Model

```
┌─────────────────────────────────────────────────────────────────────────┐
│ HIVE PRIVATE REPO                                                       │
│                                                                          │
│ Secrets (GitHub Actions):                                                │
│   DATABASE_URL          — Neon connection string                         │
│   CLAUDE_CODE_OAUTH_TOKEN — Claude Max subscription                     │
│   GH_PAT               — GitHub Personal Access Token                   │
│   CRON_SECRET           — Vercel cron/worker auth                       │
│   VERCEL_TOKEN          — Vercel API                                    │
│   NEON_API_KEY          — Neon management API                           │
│                                                                          │
│ Settings table (encrypted AES-256-GCM in Neon):                         │
│   claude_code_oauth_token, gemini_api_key, groq_api_key,                │
│   github_token, stripe_secret_key, resend_api_key, ...                  │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│ COMPANY PUBLIC REPOS                                                     │
│                                                                          │
│ Secrets: DATABASE_URL only (for context loading queries)                 │
│                                                                          │
│ Auth tokens: fetched at runtime via OIDC token exchange                  │
│   GitHub OIDC JWT proves repo identity → Hive API validates →            │
│   returns token from encrypted settings table                            │
│                                                                          │
│ Protection:                                                              │
│   - Secrets not available to fork PRs (GitHub security)                  │
│   - Only workflow_dispatch trigger (no pull_request_target)              │
│   - Only repo owner can trigger workflow_dispatch                        │
│   - OIDC validates: issuer, audience, repo owner, workflow allowlist     │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Cost Model (Monthly)

| Resource | Tier | Limit | Current Usage |
|----------|------|-------|---------------|
| Claude | Max 5x ($100/mo) | ~225 msgs/5hr | CEO, Scout, Engineer, Evolver, company builds |
| Gemini | Free API | 250 RPD | Growth, Outreach (~10 req/day) |
| Groq | Free API | ~6,000 RPD | Ops (~4 req/day) |
| GitHub Actions | Free (public repos) | Unlimited | Company builds, growth, fixes |
| GitHub Actions | 2,000 min/mo (private) | ~33 hrs | Brain agents on Hive repo |
| Vercel | Hobby (free) | 100 GB bandwidth | Company sites |
| Vercel | Pro ($20/mo) | Generous | Hive dashboard + serverless |
| Neon | Free tier | 0.5 GB, 10 projects | All data |
| Resend | Free tier | 100 emails/day | Digest + outreach |

**Philosophy:** MVP companies use only free tiers. Better infra after revenue proves the business.

---

## Key Files

| File | Purpose |
|------|---------|
| `CLAUDE.md` | Constitution — rules, flows, standards |
| `BRIEFING.md` | Current state — read first every session |
| `ARCHITECTURE.md` | This file — visual system design |
| `BACKLOG.md` | Prioritized improvements (P0-P3) |
| `DECISIONS.md` | Architectural decision records |
| `MISTAKES.md` | Production learnings (30+ entries) |
| `ROADMAP.md` | Strategic phases and milestones |
| `schema.sql` | Database schema (17 tables) |
| `.github/workflows/` | 7 agent workflows + sentinel + digest |
| `prompts/` | Agent system prompts |
| `templates/boilerplate/` | Company repo starter (Next.js + workflows) |
| `src/app/api/agents/token/` | OIDC token exchange endpoint |
| `src/app/api/agents/dispatch/` | Worker agent dispatch endpoint |
| `src/app/api/cron/sentinel/` | Sentinel health checks |
| `src/app/page.tsx` | Dashboard (portfolio, tasks, approvals) |
