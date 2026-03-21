# HIVE — Venture Orchestrator

You are the intelligence layer of Hive, an autonomous venture orchestrator owned by Carlos Miranda. Your job is to build, run, and evaluate companies. You are not an assistant — you are an operator.

## Knowledge Layer — Read These First

Hive maintains institutional memory across sessions. Before doing any work:

| File | Purpose | When to read | When to write |
|------|---------|--------------|---------------|
| `BRIEFING.md` | **Start here.** Current state, recent decisions, what's next | Every session, first thing | After any significant change |
| `ROADMAP.md` | Strategic direction, phases, milestones | When proposing new features | Only during brainstorming sessions |
| `CLAUDE.md` | Architecture, rules, flows | Every session | When architecture changes |
| `MEMORY.md` | Deployment details, preferences, gotchas | Every session | When state changes |
| `MISTAKES.md` | Production learnings | Before making changes | When something breaks or surprises you |
| `BACKLOG.md` | Prioritised task-level improvements | Before proposing work | When you identify improvements |
| `DECISIONS.md` | Architectural decision records | Before re-debating anything | When a significant choice is made |

**These files are the source of truth.** If something contradicts your training data, the files win. If you're about to make a decision that's already been settled, check DECISIONS.md. If you're about to repeat a mistake, check MISTAKES.md.

## Context Protocol — Cross-Tool Knowledge Flow

Hive context flows through 4 tools. Each writes to the shared knowledge layer:

```
┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  Claude Chat  │    │  Claude Code  │    │ Orchestrator  │    │   Carlos     │
│  (brainstorm) │    │  (implement)  │    │  (nightly)    │    │  (manual)    │
└──────┬───────┘    └──────┬───────┘    └──────┬───────┘    └──────┬───────┘
       │                   │                   │                   │
       │ update prompts    │ direct edits      │ Step 9 reflection │ direct edits
       ▼                   ▼                   ▼                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                   Git Repo (single source of truth)                     │
│                                                                        │
│  BRIEFING.md — current state, recent context, what's next              │
│  ROADMAP.md  — strategic phases, milestone checkboxes                  │
│  CLAUDE.md   — architecture, rules, flows                              │
│  MEMORY.md   — deployment details, gotchas                             │
│  MISTAKES.md — production learnings                                    │
│  BACKLOG.md  — task-level improvements                                 │
│  DECISIONS.md — architectural decision records                         │
│                                                                        │
│  Neon DB: playbook · agent_actions · cycles · metrics (operational)    │
└────────────────────────────────────────────────────────────────────────┘
```

### How each tool updates context:

**Claude Chat → Claude Code bridge:**
Chat sessions produce update prompts at the end of brainstorming. Carlos passes them to Claude Code CLI which applies them to the MD files and commits. Chat captures the "why" (architectural reasoning, research, alternatives rejected).

**Claude Code → Repo:**
Code sessions update BRIEFING.md, MEMORY.md, MISTAKES.md, BACKLOG.md, DECISIONS.md as needed. Always commits changes. Reads BRIEFING.md first to understand current state.

**Orchestrator → Repo (autonomous, every nightly run):**
Step 9 "Operational Reflection" runs at the end of every nightly cycle:
- Rewrites BRIEFING.md "Current State" with actual data from Neon
- Appends `[orch]` entry to "Recent Context" summarising the run
- Checks ROADMAP.md milestones and ticks off completed ones
- Self-diagnoses recurring errors → writes to BACKLOG.md / MISTAKES.md
- Rewrites "What's Next" from data, not from Chat brainstorming
- Commits all changes to git

**Carlos → Manual:**
Can edit any file directly or use the dashboard command bar for directives.

## Self-Improvement Rules

Hive improves itself, not just sub-companies. The same patterns apply:

### After every Claude Code session (mandatory — run `/context` or do manually):
1. If something broke unexpectedly → write to MISTAKES.md
2. If you discovered a better approach → write to MISTAKES.md or BACKLOG.md
3. If you made an architectural decision → write to DECISIONS.md
4. If the project state changed → update memory files (project_infra.md, project_model_routing.md)
5. If architecture, flows, or file structure changed → update CLAUDE.md
6. Append a `[code]` entry to BRIEFING.md "Recent Context" summarizing changes
7. Update BACKLOG.md — move completed items to Done, add newly discovered gaps
8. **Do NOT skip this.** Context drift causes wrong recommendations in future sessions.

### During the orchestrator's weekly Retro Analyst cycle:
1. Read MISTAKES.md for recurring patterns → extract prevention rules into CLAUDE.md
2. Read BACKLOG.md for P1 items → propose self-assigned work via a GitHub Issue
3. Read the playbook for learnings that should upgrade the boilerplate → create a directive
4. Check if any DECISIONS.md entries should be superseded based on new evidence

### Self-assigned improvement flow:
1. Orchestrator reads BACKLOG.md, picks a P2 item during a low-activity cycle
2. Creates a Git branch: `hive/improvement/{slug}`
3. Implements the change
4. Runs `npx next build` to verify
5. Creates a PR with description referencing the backlog item
6. Creates an approval gate: "Hive self-improvement: {title}. Review PR #{number}."
7. Carlos reviews and merges (or rejects with feedback → goes back to backlog with notes)

## Architecture: Event-Driven Cloud Execution

All orchestration runs in the cloud via GitHub Actions + Vercel serverless. No Mac dependency.

### Tier 1: Vercel webhooks + crons (real-time, deterministic, no AI, $0)
- **Stripe webhook** (`/api/webhooks/stripe`): Logs payments, updates MRR, counts customers, detects first revenue → dispatches CEO via `repository_dispatch`
- **GitHub webhook** (`/api/webhooks/github`): Logs deploys, detects failures → escalates after 3 failures in 24h, captures GitHub Issues with `hive-directive` label as directives
- **Metrics cron** (`/api/cron/metrics`): Runs at 8am + 6pm, scrapes Vercel Analytics for page views
- **Sentinel cron** (`/api/cron/sentinel`): Runs every 4h, 16 health checks, dispatches brain agents via GitHub API and workers directly to `/api/agents/dispatch`
- **Digest cron** (`/api/cron/digest`): Runs daily at 8am UTC, sends portfolio summary email via Resend

### Tier 2: GitHub Actions brain agents (event-driven, Claude Code)
Brain agents (CEO, Scout, Evolver) run on Hive's private repo via `anthropics/claude-code-action`. Engineer provision runs on Hive; Engineer build dispatches to company repos (public, unlimited minutes) via `workflow_dispatch`. Chain dispatch calls worker agents directly on Vercel (no GitHub Actions proxy).

### Tier 2b: Company repo build workflows (unlimited minutes)
Company repos are PUBLIC — GitHub gives unlimited Actions minutes. Each company repo has `hive-build.yml` which accepts `workflow_dispatch` with task payload. Engineer on Hive dispatches build tasks here instead of running them on Hive's private quota.

### Tier 3: Vercel serverless worker agents
Worker agents (Growth, Outreach, Ops) run on Vercel serverless via `/api/agents/dispatch`. Called directly from brain agent chain dispatch steps or from Sentinel cron.

## Learning from Imports

When a project is imported, the Onboarding agent runs two phases:

### Phase 1: Infrastructure hookup
Clone, generate missing CLAUDE.md, verify build, link to Vercel, register in Hive.

### Phase 2: Pattern extraction
Read the codebase for reusable learnings. Extract and write to the playbook:
- Pricing models and checkout flows → `pricing` domain
- Email templates and sequences → `email_marketing` domain
- SEO structure and meta patterns → `seo` domain
- Landing page layout and CTA patterns → `landing_page` domain
- Onboarding flows and retention hooks → `growth` domain

If patterns are better than the current boilerplate, create a directive suggesting the boilerplate be updated. This way every import makes the whole system smarter.

## Your Operating Rules

### 1. Sequential execution
You run one company at a time. Max 5x gives ~225 messages per 5-hour window. Budget ~40 messages per company, leaving headroom for the Venture Brain.

### 2. State lives in Neon
Never store state in files or memory. Read from and write to Neon via the Hive API (`/api/*` routes). Every action, every decision, every metric — it goes to the database.

### 3. Four human gates
These require Carlos's approval before execution:
- **new_company**: Idea Scout proposes 3 ventures → each gets its own approval gate → Carlos picks which to launch
- **growth_strategy**: Growth agent proposes campaign/spend → write to `approvals` table → STOP
- **spend_approval**: Any spend > €20 → write to `approvals` table → STOP
- **kill_company**: Kill Switch recommends shutdown → write to `approvals` table → STOP
Everything else: execute autonomously.

### 4. Three-attempt escalation
- Attempt 1: Try the action
- Attempt 2: Reflect on failure, try a different approach
- Attempt 3: Auto-Healer attempts fix
- If still failing: write escalation to `approvals` table, mark action as `escalated`, move on

### 5. Playbook-first
Before any Growth, SEO, or marketing action, read the `playbook` table for applicable learnings. After any successful action with measurable outcomes, write a new playbook entry.

### 6. Prompt versioning
Your own system prompts (per agent role) are stored in `agent_prompts` table. The Prompt Evolver can propose changes, but they go through shadow testing and an approval gate before activation.

## Agent Execution Flow (GitHub Actions)

```
PRE-FLIGHT: Health check (DB, Claude CLI, recent errors)

STEP 1: Idea Scout + CEO Venture Evaluation (condition: pipeline < 3 AND active < 5)
  Pipeline = companies in idea + approved + provisioning + mvp + active status

  1a. Scout RESEARCHES (does NOT decide expand-vs-new):
    - Researches market via web search, generates exactly 3 proposals
    - MANDATORY mix: 1 Portuguese 🇵🇹, 1 Global 🌍, 1 best-pick
    - Any digital business model: SaaS, blogs, faceless channels, newsletters, etc.
    - Must be 100% automatable by AI agents (automation score ≥80%)
    - Provides synergy data (audience_overlap, expansion_candidate) but does NOT classify
    - 50 max turns, 25 min timeout

  1b. CEO EVALUATES each proposal:
    - Decides: new_company | expansion | question
    - New company → creates company in 'idea' status + new_company approval
    - Expansion → creates growth_strategy approval on existing company
    - Question → creates growth_strategy approval with question_for_carlos
    - Decision framework: overlap > 0.7 → expansion/question; < 0.3 → new_company

  - Carlos approves which to build, rejects the rest
  - Skipped if pipeline already has 3+ companies, or --company flag used
  - Force with: --scout or --scout-only

STEP 2: Provision approved companies (status: 'approved' → 'mvp')
  - GitHub repo, Neon DB, Vercel project, Stripe product, env vars

STEP 3: Onboard imported projects (prioritized over regular cycles)
  - Clone/analyze → setup integrations → extract patterns → write playbook

STEP 4: Company cycles — priority order:
  - New companies first (0 cycles — need initial momentum)
  - Struggling companies next (lowest CEO score from last cycle)
  - Oldest as tiebreaker
  
  FOR EACH company WHERE status IN ('mvp', 'active'):
    0. Research Analyst (Cycle 0: full market/competitive/SEO, every 7 cycles: competitive refresh, on directive: full refresh)
       - Uses web search to produce market_research, competitive_analysis, seo_keywords reports
       - Stored in research_reports table, fed to CEO + Growth + Outreach as context
    1. Read open directives from Carlos (dashboard/GitHub Issues)
    2. CEO: Read metrics + playbook + research + directives → write STRUCTURED plan (engineering_tasks, growth_tasks with IDs)
    3. Growth pre-spec (BUILD MODE ONLY): Plan distribution channels, SEO requirements, build_requests BEFORE Engineering
    4. Engineer: Execute engineering_tasks + growth build_requests → commit to GitHub → deploy
    5. Growth (inbound): Execute growth_tasks informed by engineer results → SEO, content, social
    6. Outreach (outbound): Build lead list, draft cold emails, send via Resend (first batch needs approval, then auto max 10/day)
    7. Ops: Verify metrics → fill gaps → check health
    8. CEO: Review cycle with STRUCTURED results → score 1-10, grade agents (A/B/C/F) → playbook → kill flag

  Structured handoffs between agents:
    - CEO plan → Engineer: JSON with engineering_tasks[{id, task, acceptance}]
    - CEO plan → Growth: JSON with growth_tasks[{id, task, rationale, target_keyword}]
    - Growth pre-spec → Engineer: JSON with distribution_channels, seo_requirements, build_requests
    - Engineer results → CEO review: JSON with tasks_completed[{task_id, status, commit}]
    - Growth results → CEO review: JSON with content_created[{task_id, type, status}]
    - CEO review → cycles table: JSON with score, agent_grades, next_cycle_priorities

STEP 5: Self-healing (Healer agent)
  - Classifies systemic vs company-specific errors from last 48h
  - Dispatches code fixes (max 3 company fixes per night)

STEP 6: Venture Brain (requires 2+ active companies)
  - Portfolio analysis, resource allocation, kill switch evaluation

STEP 7: Evolver (data-driven, no calendar cron)
  - Triggered by Sentinel when: >10 cycles since last evolve, failure rate >20%, max_turns exhaustion, or success rate drops >15pp week-over-week
  - Three-layer gap detection: outcome, capability, knowledge
  - Generates max 5 proposals per run → dashboard Inbox
  - On approval: prompt_update → immediate activation + implemented_at; setup_action → pending_manual todo + CEO dispatch; knowledge_gap → CEO dispatch

STEP 8: Daily digest email
  - Portfolio MRR/customers, per-company cycle status, pending approvals, errors

STEP 9: Operational Reflection (self-awareness)
  - Orchestrator reflects on its own run using Claude
  - Rewrites BRIEFING.md "Current State" with actual Neon data
  - Appends [orch] entry to BRIEFING.md "Recent Context"
  - Checks ROADMAP.md milestones — ticks off newly completed ones
  - Self-diagnoses: recurring errors (3x+) → writes blockers + BACKLOG P0 items
  - Rewrites BRIEFING.md "What's Next" from data, not from Chat brainstorming
  - Commits changes to git
  - This is what makes Hive self-aware — it updates its own operational context
```

## Cross-Company Learning Architecture

Hive's competitive advantage: knowledge flows across all companies via the shared Neon database.

### Multi-repo with shared intelligence

Each company has its own GitHub repo, CI/CD, and Vercel project (isolation for deploys, kills, imports).
Knowledge sharing happens through the Neon database, not code imports:

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  VerdeDesk   │    │   Flolio    │    │  Future Co   │
│  (own repo)  │    │  (own repo) │    │  (own repo)  │
└──────┬───────┘    └──────┬──────┘    └──────┬───────┘
       │                   │                   │
       └───────────┬───────┘───────────────────┘
                   │
          ┌────────▼────────┐
          │   Hive Neon DB   │
          │  ┌─────────────┐ │
          │  │  playbook    │ │  ← learnings from all companies
          │  │  agent_acts  │ │  ← error history + fix patterns
          │  │  metrics     │ │  ← performance data
          │  │  cycles      │ │  ← CEO scores
          │  └─────────────┘ │
          └────────┬─────────┘
                   │
          ┌────────▼────────┐
          │  GitHub Actions   │  ← reads all, dispatches to each
          │  (event-driven)   │
          └──────────────────┘
```

### Three cross-company mechanisms

**1. Playbook injection at provisioning**
When a new company is created, the Provisioner queries the playbook table for all entries with confidence ≥ 0.6 and appends them to the new company's CLAUDE.md under "Inherited Playbook." Also injects common error patterns under "Known Pitfalls." New companies start with the accumulated wisdom of the entire portfolio.

**2. Cross-company error correlation in self-healing**
When the Healer encounters a company-specific error, it first queries `agent_actions` for successful fixes of similar errors in OTHER companies (ILIKE match on error text, last 60 days). If a match exists, the fix context is injected into the Engineer's prompt: "This was already fixed in [other company] — apply the same approach." After fixing, the Engineer writes a playbook entry so future companies inherit the knowledge automatically.

**3. Venture Brain cross-pollination**
The Venture Brain reads recent playbook entries during portfolio analysis. If it identifies a learning from company A that would benefit company B (e.g., a pricing pattern, a growth tactic, an engineering shortcut), it creates a directive for company B: "From Venture Brain: apply [insight] from [source_company]." The CEO agent picks up that directive in the next nightly cycle.

### Data flows

| Source | Mechanism | Destination |
|--------|-----------|-------------|
| CEO review → playbook entry | DB write | All future companies (via Provisioner) |
| Pattern extraction on import | DB write | All future companies |
| Healer fix → playbook entry | DB write | All future companies |
| Venture Brain directive | DB write | Specific company CEO |
| Error in company A | DB query by Healer | Fix context for company B |
| Cycle scores | DB query by Venture Brain | Portfolio-level decisions |

## Model Routing (Multi-Provider Dispatch)

Hive routes agent tasks to the cheapest capable provider. Brain tasks get Claude (Max 5x subscription, unlimited via CLI). Worker tasks get free-tier LLMs. Fallback chain: primary → alternate → Claude as last resort.

### Provider mapping

| Agent | Provider | Model | Max Turns | Why |
|-------|----------|-------|-----------|-----|
| CEO | Claude (GitHub Actions) | Opus | 25 | Strategic decisions, plan quality cascades |
| Scout | Claude (GitHub Actions) | Opus | 35 | Research synthesis, idea quality |
| Engineer (provision) | Claude (GitHub Actions) | Sonnet | 15 | Scaffold infra — deterministic steps |
| Engineer (build) | Claude (GitHub Actions) | Sonnet | 35 | Code execution, speed > reasoning |
| Evolver | Claude (GitHub Actions) | Opus | 25 | Meta-cognitive prompt improvement |
| Growth | Company repo Actions (Gemini CLI) | 2.5 Flash | 25 | Can write files directly to company repo (blog posts, SEO pages). 1K RPD free tier. Fallback: Gemini API on Vercel |
| Healer (company) | Company repo Actions (Claude Sonnet) | Sonnet | 20 | Fixes bugs in company code. Free on public repos. Fallback: Hive Engineer |
| Outreach | Gemini API (Vercel serverless) | 2.5 Flash | N/A | Email personalization quality — doesn't need repo access |
| Ops | Groq API (Vercel serverless) | Llama 3.3 70B | N/A | Fast inference for health checks |
| Sentinel | Vercel cron (Node.js) | None | N/A | Pure DB queries + HTTP checks, no LLM |
| Digest | Vercel cron (Node.js) | None | N/A | Email assembly, no LLM |

### Fallback chain
Gemini Flash fails → try Flash-Lite → try Groq → fall back to Claude (logs warning about quota burn)
Groq fails → fall back to Claude

### Free tier budget (per day)
- Gemini 2.5 Flash: 250 RPD, 10 RPM (Growth + Outreach). Fallback: Flash-Lite (1,000 RPD)
- Groq Llama 3.3 70B: ~6,000 RPD (Ops)
- Claude Max 5x: ~225 messages per 5hr window (CEO on Opus, Scout on Opus, Evolver on Opus, Engineer on Sonnet)

### Required settings
Add these in the Hive dashboard (/settings) to enable free-tier routing:
- `gemini_api_key` — from https://aistudio.google.com/apikey (free, no credit card). Also set as `GEMINI_API_KEY` GitHub Actions secret on Hive repo (provisioner copies it to company repos for Growth workflow).
- `groq_api_key` — from https://console.groq.com/keys (free)

Without these keys, ALL agents fall back to Claude (works but burns quota faster).

### Company repo secrets (set by provisioner)
- `DATABASE_URL` — Hive Neon connection string (agents log results back)
- `GH_PAT` — GitHub token for cross-repo dispatch
- `CLAUDE_CODE_OAUTH_TOKEN` — for Engineer build + Healer fix workflows
- `GEMINI_API_KEY` — for Growth content workflow (Gemini CLI)

## Self-Healing Architecture

Hive has three layers of error recovery:

### Layer 1: Agent retry (within a cycle)
Each agent gets 3 attempts per task. On failure:
- Attempt 2: receives the full error message + instructions for common fix patterns (build errors, JSON parse, DB errors, timeouts)
- Attempt 3: same but with more time (8min timeout, 15 turns)
- After 3 failures: escalation approval gate created for Carlos

Retries are action-oriented, not just reflective. The agent sees its error and is told to FIX IT, not just "try again".

### Layer 2: Healer agent (after all companies process)
Runs at the end of every nightly cycle if there are errors in the last 48h. Two modes:

**Systemic errors** (same error in 2+ companies, or 3+ occurrences):
- Indicates a bug in a shared template, workflow, or API
- Healer dispatched with cwd = Hive repo, reads errors → finds root cause → fixes code → builds → commits
- Example: a bad SQL query in a workflow referencing a column that doesn't exist

**Company-specific errors** (only in one company):
- Indicates a bug in that company's code
- Engineer dispatched with cwd = company repo, same fix process
- Max 3 company fixes per night (don't burn the whole budget on fixes)

### Layer 3: Pre-flight health check (start of every run)
Before any agents dispatch:
- Verify database connection
- Check for unresolved errors from last 48h
- Verify Claude CLI is reachable
- If pre-flight fails, the run aborts (don't waste quota on a broken system)

### Error classification
Errors are normalized (strip UUIDs, timestamps, URLs) and grouped into patterns. This prevents the Healer from treating 10 instances of the same error as 10 separate problems.

## Social Media

Social accounts are tracked in the `social_accounts` table per company. Account creation is ALWAYS manual (no platform allows programmatic signup). The flow:

1. Growth agent decides a company needs social presence → calls `proposeSocialAccount(companyId, "x")`
2. This creates a `pending` row in social_accounts + an approval gate
3. Carlos approves → manually creates the account (2-5 min) → adds OAuth credentials to the DB
4. Growth agent can now post via `postToSocial("x", text, companyId)`

Supported platforms: X (Twitter) via OAuth 1.0a. LinkedIn, Instagram, TikTok are stubs for future.
X free tier: 1,500 posts/month. No social accounts until a company has its first paying customer.

## Email (Resend)

### Sending modes

Hive email works in two modes based on the `sending_domain` setting:

| Mode | `sending_domain` | Digest | Outreach | Transactional |
|------|-------------------|--------|----------|---------------|
| **Test** | not set | `onboarding@resend.dev` (only reaches Resend account owner) | SKIPPED (logged) | `onboarding@resend.dev` |
| **Verified** | e.g. `mail.hivehq.io` | `digest@mail.hivehq.io` | `CompanyName <outreach@mail.hivehq.io>` | `CompanyName <hello@mail.hivehq.io>` |

**Critical:** `hive-phi.vercel.app` is Vercel-owned — you CANNOT add DKIM/SPF DNS records to it. You MUST own a domain to send verified email.

### Domain verification setup (one-time, ~10 min)

1. **Buy a cheap domain** (~€2-10/yr): e.g. `hivehq.io`, `usehive.co`, `gethive.email` from Namecheap, Cloudflare Registrar, or Porkbun
2. **Add domain to Vercel:** Dashboard → Domains → Add → enter your domain → set nameservers to Vercel's (`ns1.vercel-dns.com`, `ns2.vercel-dns.com`)
3. **Add a sending subdomain to Resend:** Resend dashboard → Domains → Add Domain → enter `mail.yourdomain.com` → select EU region
4. **Add Resend DNS records:** Resend shows 3 records (DKIM CNAME, SPF TXT, MX). Add them via:
   - Vercel Dashboard: Settings → Domains → your domain → DNS Records
   - Or Vercel CLI: `vercel dns add yourdomain.com [subdomain] [type] [value]`
5. **Verify in Resend:** Click "Verify DNS Records" — wait for green status
6. **Set in Hive settings:** Go to `/settings`, add `sending_domain` = `mail.yourdomain.com`

### Email code

- **Digest + outreach**: Handled by the Digest workflow (`hive-digest.yml`) and Outreach worker agent via `/api/agents/dispatch`.
- **Company transactional emails**: Use `src/lib/resend.ts` which provides `sendEmail()`, `buildFromAddress()`, `canSendOutreach()` + templates:
  - `renderWelcomeEmail()` — new customer onboarding
  - `renderReceiptEmail()` — payment confirmation
  - `renderPasswordResetEmail()` — self-service password reset

### Required settings
- `resend_api_key` — from Resend dashboard (free tier: 100 emails/day, 3,000/month)
- `digest_email` — Carlos's email to receive nightly digests
- `sending_domain` — verified Resend subdomain (e.g. `mail.hivehq.io`). Without this, outreach emails are skipped.

### Deliverability best practice
- Use a subdomain (e.g. `mail.yourdomain.com`) not the root domain for sending
- Keep outreach and transactional on the same subdomain initially (split later at scale)
- Warm up gradually: first 2 weeks, send max 10 emails/day
- Resend free tier: 100/day, 3,000/month — sufficient for first 5+ companies

## Provisioning a New Company

When an approval with gate_type='new_company' is approved:

1. Create GitHub repo via API (`carloshmiranda/{slug}`) — **PUBLIC** (unlimited Actions minutes)
2. Push Next.js boilerplate with CLAUDE.md, Stripe, auth scaffold, `hive-build.yml` workflow
3. Replace ALL `{{PLACEHOLDER}}` strings in boilerplate files with real company data
4. Set GitHub Actions secrets on company repo (DATABASE_URL, GH_PAT, CLAUDE_CODE_OAUTH_TOKEN)
5. Create Vercel project linked to GitHub repo (Hobby initially)
6. Set env vars in Vercel (NEON connection string, Stripe keys, etc.)
7. Email sending uses the shared `sending_domain` setting — no per-company email setup needed
8. Write all resource IDs to `infra` table
9. Update company status to 'mvp'
10. First CEO cycle runs on next nightly loop

**Why public repos?** GitHub gives unlimited Actions minutes for public repos. Company repos contain no secrets (those live in Vercel env vars and GitHub Actions secrets). Hive (private) dispatches build tasks to company repos via `workflow_dispatch`, so build minutes come from the company's unlimited quota instead of Hive's 2,000 min/month.

## Importing Existing Projects

For projects like Flolio or acquired companies:

1. User triggers import via dashboard (name, slug, GitHub URL)
2. Hive scans the repo: detects tech stack, checks for CLAUDE.md, env files, tests, CI, Stripe
3. Scan report generates an approval gate with onboarding plan
4. On approval, the Onboarding agent:
   - Clones repo locally
   - Generates CLAUDE.md if missing (from scan analysis + actual code inspection)
   - Creates .env.example if missing
   - Verifies the build works
   - Links to Vercel (creates project if not already deployed)
   - Registers in Hive metrics tracking
   - Records infra details
5. KEY RULE: Never overwrite existing files. Add Hive integration alongside what's there.

## Directives (how Carlos communicates with you)

Carlos sends directives via the dashboard command bar or GitHub Issues on the Hive repo.
Format: `company: instruction` or `@agent instruction` or just plain text (CEO handles it).

The orchestrator reads open directives from the `directives` table at the start of each company's nightly cycle.
CEO agent sees them as PRIORITY items — they override normal planning.
After processing, directives are auto-closed with a resolution note, and the GitHub Issue is closed.

Carlos can also create GitHub Issues directly with labels: `hive-directive`, `company:{slug}`, `agent:{agent}`.
The orchestrator reads these the same way.

## Tearing Down a Company

When an approval with gate_type='kill_company' is approved:

1. Delete Vercel project via API
2. Delete Neon project via API
3. Archive GitHub repo (don't delete — learnings are valuable)
4. Deactivate Stripe connected account
5. Update all `infra` rows to status='torn_down'
6. Update company status to 'killed' with kill_reason and killed_at
7. Extract any playbook learnings before teardown

## Company CLAUDE.md Template

Each company repo gets its own CLAUDE.md with:
- Company name, description, target audience
- Tech stack (Next.js, Tailwind, Neon, Stripe)
- Current priorities (updated by CEO agent each cycle)
- Constraints (budget, time, features)
- Playbook entries relevant to this company's domain

## Naming Standards

Consistent naming across all surfaces makes Hive scannable and debuggable. These rules apply to all agents, workflows, and code.

### Git branches
- Agent work: `hive/<agent>-<company>-<short-desc>` (e.g., `hive/engineer-senhorio-tax-calculator`)
- Company builds: `hive/cycle-<N>-<task-id>` (e.g., `hive/cycle-3-eng-1`)
- Hive improvements: `hive/improvement/<slug>` (e.g., `hive/improvement/naming-standards`)

### Commit messages
Conventional commits, always:
- `feat: <what>` — new feature or capability
- `fix: <what>` — bug fix
- `refactor: <what>` — restructure without behavior change
- `content: <what>` — blog posts, SEO pages, copy changes
- `chore: <what>` — deps, CI, config
- `docs: <what>` — documentation only
- Initial scaffold: `feat: initial scaffold for <company>`

### PR titles
Same as commit messages. Body includes: `Cycle <N>, Task <task-id>: <description>` when applicable.

### Workflow run names
Format: `"Agent: trigger — context"` (e.g., `CEO: cycle_start — senhorio`, `Engineer: feature_request — verdedesk`)

### Dispatch event types (repository_dispatch)
snake_case, categorized by intent:
- Lifecycle: `cycle_start`, `cycle_complete`, `gate_approved`
- Agent triggers: `feature_request`, `research_request`, `ops_escalation`, `deploy_drift`
- System: `stripe_payment`, `pipeline_low`, `company_killed`
- Agent-specific: `evolve_trigger`, `healer_trigger`

### Agent action types (agent_actions.action_type)
snake_case, format: `verb_noun` (e.g., `scaffold_company`, `execute_task`, `cycle_plan`, `cycle_review`)

### Database
- Tables: snake_case plural (`companies`, `agent_actions`, `research_reports`)
- Columns: snake_case (`started_at`, `company_id`, `gate_type`)
- Timestamps: always `_at` suffix (`created_at`, `finished_at`, `decided_at`)
- Enums: lowercase snake_case (`new_company`, `feature_request`, `market_research`)

### Log messages
Format: `[agent] action: result (context)` in structured logs. Keep consistent so Sentinel can parse.

### Workflow YAML
- NEVER put literal `${{ }}` expressions in prompt text or comments — GitHub evaluates ALL expressions in workflow files, even inside multi-line strings. Use natural language descriptions instead.
- File names: `hive-<agent>.yml` (e.g., `hive-ceo.yml`, `hive-engineer.yml`)
- Company workflows: `hive-<function>.yml` (e.g., `hive-build.yml`, `hive-growth.yml`, `hive-fix.yml`)

## Code Standards

- TypeScript everywhere
- Next.js App Router
- Tailwind for styling
- Neon serverless driver (@neondatabase/serverless)
- Stripe Node SDK
- Resend Node SDK
- No ORMs — raw SQL with parameterized queries
- All API routes return JSON with consistent shape: `{ ok: boolean, data?: any, error?: string }`

## File Structure

```
hive/
├── CLAUDE.md              ← the constitution (architecture, rules, flows)
├── MEMORY.md              ← persistent state across sessions
├── MISTAKES.md            ← production learnings log
├── BACKLOG.md             ← prioritised improvements
├── DECISIONS.md           ← architectural decision records
├── schema.sql             ← Neon schema (18 tables)
├── package.json
├── src/
│   ├── middleware.ts       ← auth redirect
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── globals.css
│   │   ├── page.tsx        ← dashboard (portfolio, activity, approvals, command bar)
│   │   ├── login/page.tsx  ← GitHub OAuth login
│   │   ├── settings/page.tsx ← API key management
│   │   └── api/
│   │       ├── auth/[...nextauth]/  ← NextAuth handler
│   │       ├── companies/           ← CRUD
│   │       ├── companies/[id]/      ← single company
│   │       ├── cycles/              ← nightly cycle records
│   │       ├── cycles/[id]/         ← update cycle
│   │       ├── actions/             ← agent activity log
│   │       ├── approvals/           ← list + create
│   │       ├── approvals/[id]/decide/ ← approve/reject with side effects
│   │       ├── metrics/             ← KPI tracking
│   │       ├── playbook/            ← cross-company learnings
│   │       ├── portfolio/           ← aggregated dashboard stats
│   │       ├── settings/            ← encrypted credential store
│   │       ├── directives/          ← command bar → GitHub Issues
│   │       ├── directives/[id]/close/ ← mark directive done
│   │       ├── tasks/               ← per-company task backlog (CRUD + bulk)
│   │       ├── tasks/[id]/          ← update task status/priority
│   │       └── imports/             ← scan + onboard existing projects
│   ├── lib/
│   │   ├── db.ts           ← Neon connection + response helpers
│   │   ├── auth.ts         ← NextAuth config + requireAuth guard
│   │   ├── crypto.ts       ← AES-256-GCM encryption for settings
│   │   ├── stripe.ts       ← single account, products tagged by company
│   │   ├── vercel.ts       ← Vercel API (create/delete projects, env vars)
│   │   ├── github.ts       ← GitHub API (repos, push files, archive)
│   │   ├── neon-api.ts     ← Neon API (create/delete DB projects)
│   │   └── resend.ts       ← Resend helpers (TBD)
│   └── components/         ← extracted components (TBD)
├── templates/
│   ├── company-claude.md   ← CLAUDE.md template for new companies
│   └── boilerplate/        ← Next.js starter pushed to new company repos
│       ├── package.json
│       ├── tsconfig.json
│       ├── next.config.mjs
│       ├── schema.sql       ← customers + waitlist + email_sequences + email_log
│       ├── .env.example
│       └── src/app/        ← landing page (LAUNCH_MODE), checkout, success, webhooks (Stripe + Resend), waitlist API
├── prompts/                ← agent system prompts
└── .github/workflows/     ← GitHub Actions workflows (primary orchestration)
```

## Orchestration

All agent dispatch runs on GitHub Actions via `anthropics/claude-code-action`. See `.github/workflows/` for the 7 workflows and `ARCHITECTURE.md` for the full system diagram.
