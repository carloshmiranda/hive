# Hive Architecture

> Visual guide to how Hive works. Reference document for detailed flows, procedures, and diagrams.
> For rules and standards, see CLAUDE.md. For current state, see BRIEFING.md.

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
│  │  ┌──────────────┐                                                │    │
│  │  │  Decomposer  │  (Claude Max, 8 turns)                        │    │
│  │  └──────────────┘                                                │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │              Vercel (Dashboard + APIs + Workers)                 │    │
│  │                                                                  │    │
│  │  Dashboard │ Webhooks │ QStash schedules │ Context API          │    │
│  │  /api/agents/token (OIDC) │ /api/agents/context                 │    │
│  │                                                                  │    │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │    │
│  │  │   Growth     │  │  Outreach    │  │    Ops       │          │    │
│  │  │  OpenRouter  │  │  OpenRouter  │  │  OpenRouter  │          │    │
│  │  │  (free tier) │  │  (free tier) │  │  (free tier) │          │    │
│  │  └──────────────┘  └──────────────┘  └──────────────┘          │    │
│  │                                                                  │    │
│  │  Sentinel (3 tiers via QStash) │ Digest (QStash daily)          │    │
│  └─────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────┘
         │                    │                       │
         │ repository_        │ OIDC token            │ direct DB
         │ dispatch           │ exchange              │ queries
         ▼                    ▼                       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                       COMPANY REPOS (public, free Actions)               │
│                                                                          │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐  │
│  │  verdedesk    │ │  senhorio    │ │    flolio     │ │   ciberpme   │  │
│  │               │ │              │ │              │ │              │  │
│  │ hive-build.yml│ │hive-build.yml│ │hive-build.yml│ │hive-build.yml│  │
│  │ (Sonnet, OIDC)│ │(Sonnet,OIDC) │ │(Sonnet,OIDC) │ │(Sonnet,OIDC) │  │
│  │               │ │              │ │              │ │              │  │
│  │ Next.js app   │ │ Next.js app  │ │ Next.js app  │ │ Next.js app  │  │
│  │ (Vercel Pro)  │ │ (Vercel Pro) │ │ (Vercel Pro) │ │ (Vercel Pro) │  │
│  └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                         NEON POSTGRES                                     │
│                    (single shared database, eu-central-1)                │
│                                                                          │
│  companies │ cycles │ approvals │ agent_actions │ metrics │ settings     │
│  playbook │ research_reports │ company_tasks │ infra │ directives        │
│  social_accounts │ evolver_proposals │ agent_prompts │ context_log       │
│  hive_backlog │ error_patterns │ routing_weights │ email_log             │
│  email_sequences │ customers                                             │
│                                     (21 tables — see schema.sql)         │
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
  Stripe webhook     Sentinel (QStash)           Manual dispatch
  (payment event)    (3 urgency tiers)           (dashboard/CLI)
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
 │(company │ │(Vercel  │ │ (Vercel  │      │  (Hive repo) │
 │  repo)  │ │ worker) │ │ worker)  │      │              │
 └────┬────┘ └────┬────┘ └──────────┘      └──────────────┘
      │           │
      │ PR opened │ content created
      │           │
      ▼           ▼
 ┌────────────────────┐
 │     CEO Review     │  Scores cycle, grades agents, extracts learnings
 │    (Hive repo)     │
 └─────────┬──────────┘
           │ chain dispatch
           ▼
 ┌────────────────────┐
 │ cycle-complete →   │  Health gate → score companies → dispatch next
 │ backlog/dispatch   │
 └────────────────────┘
```

### Continuous Dispatch (Chain Callbacks)

Work chains automatically without waiting for Sentinel:
- **CEO cycle_complete** → `/api/dispatch/cycle-complete` → health gate → score companies → dispatch next
- **Engineer backlog done** → `/api/backlog/dispatch` → if empty, falls through to cycle-complete
- **Health gate** (`/api/dispatch/health-gate`): checks Claude budget, concurrent agents, failure rate, Hive backlog priority
- **Hive-first**: P0/P1 backlog items always dispatched before company cycles
- **Sentinel remains as safety net** — catches work missed by chain dispatch

### Decentralized Dispatch (company-scoped work)

Brain agents (CEO, Scout, Evolver, Healer) run on the **Hive private repo**.
Company-scoped work (build, fix) runs on **company public repos** (free Actions).
Worker agents (Growth, Outreach, Ops) run on **Vercel serverless** via `/api/agents/dispatch`.

---

## Context API (ADR-035)

All agents fetch pre-computed context from a single endpoint instead of running inline SQL:

```
Agent workflow step                     Hive Vercel API
──────────────────                      ────────────────
curl "$HIVE_URL/api/agents/context      Computes context for agent:
  ?agent=ceo&company_slug=senhorio"     - Company data + metrics
  -H "Authorization: Bearer $SECRET"    - Recent cycles + tasks
                                        - Playbook entries
Returns JSON blob with everything       - Research reports
the agent needs for its prompt          - Validation score + phase
                                        Cached 5min per agent+company
```

### Agent modes

| Mode | Query | Scope |
|------|-------|-------|
| `?agent=ceo&company_slug=X` | Single company cycle planning | Company metrics, tasks, directives, validation |
| `?agent=build&company_slug=X` | Engineer build context | Company stack, open tasks, recent errors |
| `?agent=fix&company_slug=X` | Healer fix context | Company errors, similar fixes from other companies |
| `?agent=growth&company_slug=X` | Growth worker context | Company SEO, content strategy, playbook |
| `?agent=scout` | Portfolio-level scouting | All companies, killed list, market coverage |
| `?agent=evolver` | Portfolio-level evolution | Agent stats, stalled companies, repeated errors |

---

## OIDC Token Exchange (Zero Secrets on Public Repos)

Company repos are public. Auth tokens are NOT stored as repo secrets.
Workflows use GitHub OIDC to prove identity and fetch tokens at runtime.

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

Company repo secrets: ZERO (all fetched via OIDC at runtime)
All auth tokens: stored once in Hive's encrypted settings table
```

### Allowed Workflows
Only these workflow files can request tokens:
- `hive-build.yml` → requests `claude` + `github_pat`
- `hive-fix.yml` → requests `claude` + `github_pat`

---

## Sentinel: Health Monitor (QStash, 3 Urgency Tiers — ADR-031)

Sentinel is split into 3 endpoints scheduled via QStash (not Vercel crons). Shared helpers in `src/lib/sentinel-helpers.ts`.

**Sentinel-urgent** (`/api/cron/sentinel-urgent`, every 2h):
```
├── Stuck cycles, orphaned companies, deploy drift
├── Phantom PRs, unverified provisions
├── Dispatch verification (check 43)
├── Stale cycle safety net (check 44)
└── Stuck PRs with green CI (check 45)
```

**Sentinel-dispatch** (`/api/cron/sentinel-dispatch`, every 4h):
```
├── Priority-scored company cycle dispatch (safety net)
├── Hive backlog item dispatch (P0/P1 first)
├── Chain gap detection, budget checks
├── Failed task re-dispatch
├── Worker agent dispatch (Growth/Outreach/Ops)
└── Fires company-health (non-blocking delegate)
```

**Sentinel-janitor** (`/api/cron/sentinel-janitor`, daily 2am):
```
├── Playbook maintenance: decay, prune, consolidate
├── Error pattern auto-learning
├── Agent performance regression detection
├── Self-improvement proposals
├── Auto-decompose blocked L-complexity items
├── Schema drift detection (vs schema-map.ts)
├── BACKLOG.md regeneration from DB
└── Anomaly detection (2σ rolling average)
```

**Company-health** (`/api/cron/company-health`, fired by sentinel-dispatch):
```
├── Check 31: Stats endpoint health        → Create fix tasks
├── Check 32: Language consistency          → Create fix tasks
├── Check 33: Stale record reconciliation  → Auto-fix DB records
├── Check 36: Test coverage health          → Create test tasks
├── Check 38: PR review + auto-merge       → Merge or escalate
├── Check 30: Broken deploys + repair      → Infra repair → code fix
├── Check 43: Dispatch verification        → Flag missed dispatches
├── Check 44: Stale cycle safety net       → Re-dispatch stalled companies
└── Check 45: Stuck PRs with green CI      → Auto-merge or escalate
```

### QStash Schedules (5 total, consolidated — ADR-031)

| Schedule | Endpoint | Frequency |
|----------|----------|-----------|
| sentinel-urgent | `/api/cron/sentinel-urgent` | `0 */2 * * *` (every 2h) |
| sentinel-dispatch | `/api/cron/sentinel-dispatch` | `0 */4 * * *` (every 4h) |
| sentinel-janitor | `/api/cron/sentinel-janitor` | `0 2 * * *` (daily 2am) |
| metrics | `/api/cron/metrics` | `0 8,18 * * *` (twice daily) |
| digest | `/api/cron/digest` | `0 8 * * *` (daily 8am) |

Auth: `verifyCronAuth()` accepts QStash signatures OR CRON_SECRET. Free tier: 1,000 msgs/day, 10 schedules. Using 5/10 schedules, ~82 msgs/day.

---

## Agent Execution Flow

```
PRE-FLIGHT: Health check (DB, Claude CLI, recent errors)

STEP 1: Idea Scout + CEO Venture Evaluation (condition: pipeline < 3 AND active < 5)
  1a. Scout RESEARCHES via web search, generates 3 proposals
      - Mix: 1 Portuguese, 1 Global, 1 best-pick
      - Uses context API (?agent=scout) for portfolio awareness
  1b. CEO EVALUATES each: new_company | expansion | question
  - Carlos approves which to build via dashboard

STEP 2: Provision approved companies (status: 'approved' → 'mvp')
  - GitHub repo (PUBLIC), Vercel project, Stripe product, env vars
  - ZERO secrets on company repos (OIDC token exchange)

STEP 3: Onboard imported projects (prioritized over regular cycles)

STEP 4: Company cycles — dispatched by Sentinel priority score:
  FOR EACH company WHERE status IN ('mvp', 'active'):
    1. CEO: fetch context API → write STRUCTURED plan gated by validation phase
    2. Engineer: execute engineering_tasks → commit → deploy (on company repo)
    3. Growth: execute growth_tasks → SEO, content (Vercel serverless)
    4. Outreach: build leads, draft emails (Vercel serverless)
    5. Ops: verify metrics, check health (Vercel serverless)
    6. CEO: review cycle → score 1-10, grade agents → playbook

  Structured handoffs (JSON):
    CEO plan → Engineer: engineering_tasks[{id, task, acceptance}]
    CEO plan → Growth: growth_tasks[{id, task, rationale, target_keyword}]
    Engineer → CEO review: tasks_completed[{task_id, status, commit}]

STEP 5: Self-healing (Healer agent)
  - Systemic errors → fix in Hive repo
  - Company errors → dispatch fix to company repo (max 3/night)

STEP 6: Evolver (data-driven, triggered by Sentinel)
  - Three-layer gap detection: outcome, capability, knowledge
  - Uses context API (?agent=evolver) for portfolio stats
  - Max 5 proposals per run → dashboard Inbox

STEP 7: Daily digest email (portfolio summary via Resend)
```

---

## Validation-Gated Build System (ADR-024)

Companies progress through phases based on a validation score (0-100) computed from real metrics, not cycle count. Computed in `src/lib/validation.ts`, injected via context API.

### How it works
1. `normalizeBusinessType()` maps `company_type` to canonical type (saas, blog, affiliate_site, etc.)
2. `computeValidationScore()` scores 0-100 based on type-specific metrics
3. Score determines phase → defines what CEO can plan (gating_rules + forbidden actions)
4. Kill signals are organic-patient: 60/120/180 day windows. Any revenue = infinite patience.

### Phase examples
- **SaaS validate (0-24):** Landing page, waitlist, SEO. FORBIDDEN: auth, dashboards, CRUD.
- **SaaS test_intent (25-49):** Fake-door pricing. FORBIDDEN: building the product.
- **SaaS build_mvp (50-74):** Core value flow only. Max 2 eng tasks/cycle.
- **Blog seed_content (0-24):** Publish articles, SEO scaffolding. FORBIDDEN: monetization.

### Data collection (from day 1 via boilerplate)
- `page_views` table + middleware → pageview tracking (all types)
- `pricing_clicks` table + `/api/pricing-intent` → fake-door CTA clicks (SaaS)
- `affiliate_clicks` table + `/api/affiliate-click` → outbound click tracking (affiliate)
- Hive's metrics cron fetches all three via company `/api/stats`

---

## Company Lifecycle

```
┌─────────┐    ┌──────────┐    ┌──────────────┐    ┌───────┐    ┌────────┐
│  idea   │───►│ approved │───►│ provisioning │───►│  mvp  │───►│ active │
│         │    │          │    │              │    │       │    │        │
│ Scout   │    │ Carlos   │    │ Engineer     │    │ Build │    │Revenue │
│proposes │    │approves  │    │scaffolds     │    │cycles │    │> $0    │
└─────────┘    └──────────┘    └──────────────┘    └───────┘    └────────┘
                                                        │            │
                                                        │     ┌──────┴──────┐
                                                        │     │ Validation  │
                                                        │     │ score gates │
                                                        │     │ what CEO    │
                                                        │     │ can plan    │
                                                        │     └─────────────┘
                                                        │
                                                        ▼
                                               ┌─────────────────┐
                                               │    killed        │
                                               │  (kill signals:  │
                                               │  60/120/180 day  │
                                               │  windows by type)│
                                               └─────────────────┘
```

---

## Model Routing (ADR-034: OpenRouter-Only for Workers)

Two tiers: brain agents on Claude Max (GitHub Actions CLI), worker agents on OpenRouter free models (Vercel serverless).

### Brain Agents (Hive private repo, Claude via Max subscription)

| Agent | Workflow | Model | Max Turns | Triggers |
|-------|----------|-------|-----------|----------|
| CEO | `hive-ceo.yml` | Opus | 40 | `cycle_start`, `cycle_complete`, `gate_approved`, `stripe_payment`, `ceo_review` |
| Scout | `hive-scout.yml` | Opus | 35 | `pipeline_low`, `company_killed`, `research_request` |
| Engineer | `hive-engineer.yml` | Sonnet (→Opus on 3rd attempt) | 15 prov / 35 build | `feature_request`, `new_company`, `ops_escalation` |
| Evolver | `hive-evolver.yml` | Opus | 20 | `evolve_trigger` (data-driven via Sentinel) |
| Healer | `hive-healer.yml` | Sonnet | 20 | `healer_trigger` (circuit breaker: 3 failures/48h → skip) |
| Decomposer | `hive-decompose.yml` | Claude (Max) | 8 | `decompose_task` |

### Worker Agents (Vercel serverless, OpenRouter free models)

| Agent | Endpoint | Primary Model | Fallback Chain |
|-------|----------|---------------|----------------|
| Growth | `/api/agents/dispatch` | Hermes 3 405B:free | → Llama 70B:free → Mistral 24B:free |
| Outreach | `/api/agents/dispatch` | Llama 70B:free | → Hermes 405B:free → Mistral 24B:free |
| Ops | `/api/agents/dispatch` | Mistral 24B:free | → Llama 70B:free → Hermes 405B:free |
| Planner | `/api/agents/dispatch` | Qwen3 Coder:free | → Claude Sonnet 4:free → Hermes 405B:free |

### Company Repo Workflows (public repos, free Actions)

| Workflow | Model | Token Source | Purpose |
|----------|-------|-------------|---------|
| `hive-build.yml` | Claude Sonnet (via OIDC) | `/api/agents/token` | Build features, fix bugs |

### Dynamic Model Escalation (ADR-035)
Engineer workflow has a "Resolve model" step checking attempt count:
- Attempt 1-2: Sonnet, standard turns
- Attempt 3+: Opus + 50 max turns (for harder problems)

### Fallback & Circuit Breaker
- Worker agents: model-to-model within OpenRouter only. Per-model EMA error rate tracking (CLOSED/HALF_OPEN/OPEN).
- No cross-provider fallback — Claude Max is CLI-only, not in the serverless chain.
- `openrouter_api_key` stored in settings DB (single key for all workers).

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
│  │                     │──► CEO, Engineer, Growth read        │
│  └────────────────────┘                                      │
└──────────────────────────────────────────────────────────────┘
```

### Three cross-company mechanisms

1. **Playbook injection at provisioning** — New companies start with all playbook entries (confidence >= 0.6) and known error patterns.
2. **Cross-company error correlation** — Healer queries agent_actions for fixes of similar errors in OTHER companies before dispatching repairs.
3. **Venture Brain cross-pollination** — Reads recent playbook entries, creates directives when learnings from company A benefit company B.

---

## Self-Healing Architecture

### Layer 1: Agent retry (within a cycle)
- Attempt 2: full error message + fix instructions
- Attempt 3: more time (8min timeout, 15 turns)
- After 3 failures: escalation approval gate

### Layer 2: Healer agent (post-cycle)
- **Systemic errors** (2+ companies or 3+ occurrences): fix in Hive repo
- **Company errors** (isolated): dispatch fix to company repo (max 3/night)
- Circuit breaker: 3 failures in 48h → skip company

### Layer 3: Pre-flight health check
Verify DB, Claude CLI, recent errors before any dispatch. Abort on failure.

### Error classification
Errors normalized (strip UUIDs, timestamps, URLs) and grouped into patterns via `error_patterns` table.

---

## Inter-Agent Communication

| From | To | Mechanism |
|------|----|-----------|
| Sentinel → Brain agents | `repository_dispatch` via GitHub API |
| Sentinel → Workers | QStash publish to `/api/agents/dispatch` |
| CEO → Engineer | `repository_dispatch` (feature_request) |
| CEO → Scout | `repository_dispatch` (research_request) |
| CEO → Growth/Outreach | Direct Vercel call or QStash |
| Engineer → company repo | `workflow_dispatch` to company's hive-build.yml |
| Scout → CEO | `repository_dispatch` (cycle_start) |
| Engineer → CEO | `repository_dispatch` from company hive-build.yml |
| Chain dispatch | cycle-complete → health-gate → next cycle | HTTP calls between Vercel endpoints |

---

## MCP Tooling & External Integrations

Hive uses **13+ MCP (Model Context Protocol) tools** for agent orchestration, metrics querying, cross-company learning, and per-company MCP servers. MCP tools enable agents to interact with external services and databases through standardized interfaces.

### Current MCP Surface Area

- **Agent orchestration controls**: Dispatch triggers, health gates, approval workflows
- **Metrics querying**: Company stats, validation scores, portfolio analytics
- **Cross-company learning**: Playbook entries, error patterns, successful strategies
- **Per-company MCP servers**: Company-specific tools for content, SEO, customer data

### MCP Expansion Guidelines

When expanding Hive's MCP tooling surface area, reference the **mcp-builder skill** for:
- **API design best practices**: Tool naming conventions, response formatting, error handling
- **TypeScript MCP SDK patterns**: Project structure, schema validation, testing approaches
- **Testing and deployment**: Quality checklist, MCP Inspector validation, evaluation creation

The mcp-builder skill provides comprehensive guidance for creating high-quality MCP servers that enable agents to accomplish real-world tasks effectively.

---

## Provisioning a New Company

When `gate_type='new_company'` is approved:

1. Create GitHub repo (`carloshmiranda/{slug}`) — **PUBLIC** (unlimited Actions minutes)
2. Push Next.js boilerplate with CLAUDE.md, Stripe, auth scaffold, `hive-build.yml`
3. Replace ALL `{{PLACEHOLDER}}` strings with real company data
4. ZERO secrets on company repos (all via OIDC token exchange — ADR-022)
5. Create Vercel project linked to GitHub repo
6. Set env vars in Vercel (Neon connection, Stripe keys, etc.)
7. Write resource IDs to `infra` table
8. Update company status to 'mvp'

**Why public repos?** Unlimited Actions minutes. No secrets in code — all tokens fetched via OIDC at runtime.

---

## Importing Existing Projects

1. User triggers import via dashboard (name, slug, GitHub URL)
2. Hive scans repo: tech stack, CLAUDE.md, env files, tests, CI, Stripe
3. Scan report → approval gate with onboarding plan
4. On approval: clone → generate CLAUDE.md → verify build → link Vercel → register in Hive
5. Pattern extraction: pricing, email, SEO, landing pages, growth → playbook
6. **KEY RULE:** Never overwrite existing files.

---

## Tearing Down a Company

When `gate_type='kill_company'` is approved:

1. Delete Vercel project, archive GitHub repo (don't delete — learnings valuable)
2. Deactivate Stripe, update infra to 'torn_down', set status 'killed'
3. Extract playbook learnings before teardown

---

## Email (Resend)

| Mode | `sending_domain` | Digest | Outreach | Transactional |
|------|-------------------|--------|----------|---------------|
| **Test** | not set | `onboarding@resend.dev` (owner only) | SKIPPED | `onboarding@resend.dev` |
| **Verified** | e.g. `mail.hivehq.io` | `digest@mail.hivehq.io` | `Company <outreach@...>` | `Company <hello@...>` |

Setup: buy domain → add to Vercel → add sending subdomain to Resend → verify DNS (DKIM, SPF, MX) → set `sending_domain` in Hive settings.

Code: `src/lib/resend.ts` — `sendEmail()`, `buildFromAddress()`, `canSendOutreach()` + templates (welcome, receipt, password reset).

---

## Social Media

Tracked in `social_accounts` table. Account creation is ALWAYS manual. Flow:
1. Growth proposes → approval gate
2. Carlos creates account manually → adds credentials
3. Growth posts via `postToSocial()`

X free tier: 1,500 posts/month. No accounts until first paying customer.

---

## Security Model

```
HIVE PRIVATE REPO
  Secrets (GitHub Actions):
    DATABASE_URL, CLAUDE_CODE_OAUTH_TOKEN, GH_PAT, CRON_SECRET,
    VERCEL_TOKEN, NEON_API_KEY

  Settings table (encrypted AES-256-GCM in Neon):
    claude_code_oauth_token, openrouter_api_key,
    github_token, stripe_secret_key, resend_api_key,
    telegram_bot_token, telegram_chat_id, ...

COMPANY PUBLIC REPOS
  Secrets: ZERO (all via OIDC token exchange at runtime)
  Protection: only workflow_dispatch trigger, only repo owner can trigger,
  OIDC validates issuer + audience + owner + workflow allowlist
```

---

## Observability & Caching

- **Sentry**: @sentry/nextjs — server/edge/client. Free tier: 5K errors/mo, 7-day retention.
- **Upstash Redis**: cache-aside for settings (10min TTL), playbook (1h), company list (5m). Free tier: 500K cmds/mo, 256 MB.
- **QStash**: Guaranteed delivery for agent dispatch. Deduplication via hourly-bucket IDs.
- **Telegram**: Bot notifications for agent results, approval buttons, PR merge buttons.

---

## Cost Model (Monthly)

| Resource | Tier | Limit | Current Usage |
|----------|------|-------|---------------|
| Claude | Max 5x ($100/mo) | ~225 msgs/5hr | CEO, Scout, Engineer, Evolver, company builds |
| OpenRouter | Free (:free models) | Rate-limited | Growth, Outreach, Ops, Planner |
| GitHub Actions | Free (public repos) | Unlimited | Company builds, fixes |
| GitHub Actions | 2,000 min/mo (private) | ~33 hrs | Brain agents on Hive repo |
| Vercel | Pro ($20/mo) | Generous | Hive dashboard + serverless |
| Neon | Free tier | 0.5 GB, 100 CU-hrs | All data |
| Upstash Redis | Free tier | 500K cmds/mo, 256 MB | Cache layer |
| Upstash QStash | Free tier | 1,000 msgs/day, 10 schedules | Cron + dispatch |
| Resend | Free tier | 100 emails/day | Digest + outreach |
| Sentry | Free tier | 5K errors/mo | Error tracking |

**Philosophy:** Free tiers until revenue proves the business.

---

## File Structure

```
hive/
├── CLAUDE.md              ← constitution (rules, standards, operating principles)
├── ARCHITECTURE.md        ← this file (detailed flows, diagrams, procedures)
├── BRIEFING.md            ← current state (read first every session)
├── BACKLOG.md             ← prioritised improvements (P0-P3)
├── DECISIONS.md           ← architectural decision records (ADRs)
├── MISTAKES.md            ← production learnings (50+ entries)
├── ROADMAP.md             ← strategic phases and milestones
├── schema.sql             ← Neon schema (21 tables)
├── src/
│   ├── middleware.ts       ← auth redirect
│   ├── app/
│   │   ├── page.tsx        ← dashboard (portfolio, tasks, approvals)
│   │   ├── settings/       ← API key management
│   │   └── api/
│   │       ├── agents/token/    ← OIDC token exchange
│   │       ├── agents/dispatch/ ← worker agent dispatch
│   │       ├── agents/context/  ← pre-computed agent context (ADR-035)
│   │       ├── cron/sentinel-*  ← 3 sentinel tier endpoints
│   │       ├── cron/company-health/ ← HTTP-heavy checks
│   │       ├── cron/metrics/    ← analytics scraping
│   │       ├── cron/digest/     ← daily email
│   │       ├── dispatch/health-gate/  ← chain dispatch gating
│   │       ├── dispatch/cycle-complete/ ← chain callback
│   │       ├── backlog/dispatch/ ← Hive backlog dispatch
│   │       ├── webhooks/stripe/ ← payment events
│   │       ├── webhooks/github/ ← deploy events
│   │       ├── webhooks/telegram/ ← button callbacks
│   │       ├── notify/          ← Telegram notifications
│   │       ├── companies/       ← CRUD
│   │       ├── cycles/          ← cycle records
│   │       ├── approvals/       ← approval gates
│   │       ├── playbook/        ← cross-company learnings
│   │       ├── portfolio/       ← aggregated stats
│   │       ├── settings/        ← encrypted credential store
│   │       ├── directives/      ← command bar → GitHub Issues
│   │       ├── tasks/           ← per-company task backlog
│   │       ├── metrics/         ← KPI tracking
│   │       ├── actions/         ← agent activity log
│   │       ├── roadmap/         ← theme progress
│   │       └── imports/         ← scan + onboard projects
│   ├── lib/
│   │   ├── db.ts               ← Neon connection + response helpers
│   │   ├── auth.ts             ← NextAuth config + requireAuth guard
│   │   ├── crypto.ts           ← AES-256-GCM encryption
│   │   ├── llm.ts              ← OpenRouter LLM routing + circuit breaker
│   │   ├── validation.ts       ← Validation score engine
│   │   ├── sentinel-helpers.ts ← Shared Sentinel utilities
│   │   ├── redis-cache.ts      ← Upstash Redis cache layer
│   │   ├── qstash.ts           ← QStash guaranteed delivery
│   │   ├── settings.ts         ← cachedSetting() with Redis
│   │   ├── stripe.ts           ← Stripe (single account, metadata-tagged)
│   │   ├── vercel.ts           ← Vercel API
│   │   ├── github.ts           ← GitHub API
│   │   ├── neon-api.ts         ← Neon management API
│   │   └── resend.ts           ← Resend email helpers
│   └── components/
├── prompts/                ← agent system prompts
├── templates/
│   ├── company-claude.md   ← CLAUDE.md template for new companies
│   └── boilerplate/        ← Next.js starter for company repos
└── .github/workflows/      ← 9 workflow files (brain agents + CI)
    ├── hive-ceo.yml        ← Opus 40 turns
    ├── hive-scout.yml      ← Opus 35 turns
    ├── hive-engineer.yml   ← Sonnet (→Opus on 3rd attempt)
    ├── hive-evolver.yml    ← Opus 20 turns
    ├── hive-healer.yml     ← Sonnet 20 turns
    ├── hive-decompose.yml  ← Claude Max 8 turns
    ├── hive-crons.yml      ← Manual-trigger fallback
    ├── hive-digest.yml     ← Manual-trigger fallback
    └── ci.yml              ← Build + schema-map check
```
