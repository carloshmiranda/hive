-- ============================================================================
-- HIVE — Venture Orchestrator Schema
-- Run against Neon Postgres. This is the single source of truth.
-- ============================================================================

-- Enable pgvector extension for semantic search
CREATE EXTENSION IF NOT EXISTS vector;

-- Companies: each venture Hive manages
CREATE TABLE companies (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name          TEXT NOT NULL,
  slug          TEXT UNIQUE NOT NULL,
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'idea' CHECK (status IN (
                  'idea',        -- proposed by Idea Scout, not yet approved
                  'approved',    -- you approved it, provisioning pending
                  'provisioning',-- infra being created (repo, db, deploy)
                  'mvp',         -- live on vercel.app subdomain, no revenue
                  'active',      -- generating revenue, Vercel Pro
                  'paused',      -- temporarily halted (your decision or auto)
                  'killed'       -- torn down by Kill Switch
                )),
  vercel_project_id   TEXT,       -- set after provisioning
  vercel_url          TEXT,       -- company-slug.vercel.app or custom domain
  github_repo         TEXT,       -- owner/repo
  neon_project_id     TEXT,       -- company's own Neon project
  stripe_account_id   TEXT,       -- Stripe Connect connected account
  domain              TEXT,       -- custom domain (null = vercel subdomain)
  capabilities  JSONB DEFAULT '{}',              -- structured capability inventory
  company_type  TEXT DEFAULT 'b2c_saas',         -- for compatibility matrix
  framework     TEXT DEFAULT 'nextjs',           -- nextjs, astro, sveltekit, static
  market        TEXT DEFAULT 'global',           -- 'portugal' or 'global' — determines content language
  content_language TEXT DEFAULT 'en',            -- 'en' or 'pt' — enforced by agents
  imported      BOOLEAN DEFAULT false,           -- true for non-Hive-provisioned companies
  last_assessed_at TIMESTAMPTZ,                  -- when capabilities were last verified
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  killed_at     TIMESTAMPTZ,
  kill_reason   TEXT,
  resend_audience_id TEXT,       -- Resend Audiences API audience ID for this company's leads
  healer_blocked     BOOLEAN DEFAULT false, -- Circuit breaker flag to suppress Healer dispatch until manually cleared
  brand              JSONB DEFAULT NULL     -- { tagline, tone, colors: {primary, secondary, accent}, personality, voice }
);

-- Agent cycles: one row per nightly orchestrator run per company
CREATE TABLE cycles (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  company_id    TEXT NOT NULL REFERENCES companies(id),
  cycle_number  INTEGER NOT NULL,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'running' CHECK (status IN (
                  'running', 'completed', 'failed', 'partial'
                )),
  ceo_plan      JSONB,          -- what the CEO agent decided to prioritize
  ceo_review    JSONB,          -- CEO's end-of-cycle assessment
  UNIQUE(company_id, cycle_number)
);

-- Agent actions: individual tasks within a cycle
-- cycle_id and company_id are nullable for portfolio-level actions (Idea Scout, Healer, etc.)
CREATE TABLE agent_actions (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  cycle_id      TEXT REFERENCES cycles(id),
  company_id    TEXT REFERENCES companies(id),
  agent         TEXT NOT NULL CHECK (agent IN (
                  'ceo', 'scout', 'engineer', 'ops', 'growth', 'outreach', 'evolver',
                  'healer', 'orchestrator', 'sentinel', 'auto_merge', 'dispatch',
                  'backlog_dispatch', 'webhook', 'system', 'admin'
                )),
  action_type   TEXT NOT NULL,   -- e.g. 'deploy_code', 'send_email', 'write_post'
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                  'pending', 'running', 'success', 'failed', 'skipped', 'escalated',
                  'pending_manual', 'completed', 'flagged'
                )),
  input         JSONB,           -- what was fed to the agent
  output        JSONB,           -- what it produced
  error         TEXT,            -- if failed
  retry_count   INTEGER DEFAULT 0,
  reflection    TEXT,            -- self-reflection on failure (Reflexion pattern)
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  tokens_used   INTEGER,         -- track consumption
  quality_score NUMERIC(4,3)     -- 0.0-1.0 quality score from CEO post-cycle review (migration 014)
);

-- Approval gates: items waiting for your decision
CREATE TABLE approvals (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  company_id    TEXT REFERENCES companies(id), -- null for portfolio-level decisions
  gate_type     TEXT NOT NULL CHECK (gate_type IN (
                  'new_company',         -- Idea Scout proposes a new venture
                  'growth_strategy',     -- Growth agent proposes spend/campaign
                  'spend_approval',      -- any agent wants to spend > threshold
                  'kill_company',        -- Kill Switch recommends shutdown
                  'prompt_upgrade',      -- Prompt Evolver proposes a prompt change
                  'escalation',          -- Health Monitor couldn't auto-fix
                  'outreach_batch',      -- first cold email batch needs approval
                  'vercel_pro_upgrade',  -- company needs Vercel Pro (has revenue)
                  'social_account',      -- Growth wants a social media account created
                  'first_revenue',       -- first paying customer detected
                  'capability_migration', -- boilerplate capability migration proposal
                  'pr_review'            -- PR needs manual review (risk score 4-6)
                )),
  title         TEXT NOT NULL,
  description   TEXT NOT NULL,
  context       JSONB,           -- all data needed to make the decision
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                  'pending', 'approved', 'rejected', 'expired'
                )),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at    TIMESTAMPTZ,
  decision_note TEXT              -- your comment when approving/rejecting
);

-- Metrics: daily KPIs per company (populated by Ops agent)
CREATE TABLE metrics (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  company_id    TEXT NOT NULL REFERENCES companies(id),
  date          DATE NOT NULL,
  revenue       NUMERIC(12,2) DEFAULT 0,      -- from Stripe
  mrr           NUMERIC(12,2) DEFAULT 0,
  customers     INTEGER DEFAULT 0,
  page_views    INTEGER DEFAULT 0,             -- from Vercel Analytics
  signups       INTEGER DEFAULT 0,
  churn_rate    NUMERIC(5,4) DEFAULT 0,
  cac           NUMERIC(10,2) DEFAULT 0,       -- cost of acquisition
  ad_spend      NUMERIC(10,2) DEFAULT 0,
  emails_sent   INTEGER DEFAULT 0,
  social_posts  INTEGER DEFAULT 0,
  social_engagement INTEGER DEFAULT 0,         -- likes + replies + shares
  waitlist_signups  INTEGER DEFAULT 0,          -- new waitlist signups today
  waitlist_total    INTEGER DEFAULT 0,          -- total waitlist size
  email_opens       INTEGER DEFAULT 0,
  email_clicks      INTEGER DEFAULT 0,
  email_bounces     INTEGER DEFAULT 0,
  pricing_page_views  INTEGER DEFAULT 0,  -- fake-door pricing page visits
  pricing_cta_clicks  INTEGER DEFAULT 0,  -- pricing CTA clicks (payment intent signal)
  affiliate_clicks    INTEGER DEFAULT 0,  -- outbound affiliate link clicks
  affiliate_revenue   NUMERIC(10,2) DEFAULT 0,
  UNIQUE(company_id, date)
);

-- Playbook: cross-company learnings (the shared knowledge base)
CREATE TABLE playbook (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  source_company_id TEXT REFERENCES companies(id),
  domain        TEXT NOT NULL,   -- 'email_marketing', 'seo', 'pricing', 'onboarding', etc.
  insight       TEXT NOT NULL,
  evidence      JSONB,           -- metrics that support this insight
  confidence    NUMERIC(3,2) DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  applied_count INTEGER DEFAULT 0, -- how many times other agents used this
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_by TEXT REFERENCES playbook(id), -- if a newer insight replaces this
  content_language TEXT DEFAULT NULL, -- NULL = universal/language-agnostic, 'en'/'pt' for language-specific
  last_referenced_at TIMESTAMPTZ,
  reference_count INTEGER DEFAULT 0,
  relevant_agents TEXT[] DEFAULT '{}',  -- agent roles this entry is relevant to (empty = all agents)
  embedding     vector(1536),    -- semantic embeddings for similarity search
  evolution_type TEXT,           -- 'manual', 'captured', 'evolved' (migration 014)
  source        TEXT             -- 'ceo_review', 'auto_distill', 'operator' (migration 014)
);

-- Backfill: UPDATE playbook p SET content_language = c.content_language FROM companies c WHERE p.source_company_id = c.id AND p.source_company_id IS NOT NULL AND c.content_language IS NOT NULL;
-- Backfill: UPDATE playbook SET relevant_agents = CASE WHEN domain IN ('engineering', 'infrastructure', 'payments', 'auth', 'deployment') THEN '{build,fix}' WHEN domain IN ('growth', 'seo', 'email_marketing', 'content', 'social') THEN '{growth}' ELSE '{}' END WHERE relevant_agents = '{}';

-- Agent prompts: versioned system prompts (for Prompt Evolver)
CREATE TABLE agent_prompts (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  agent         TEXT NOT NULL,
  version       INTEGER NOT NULL,
  prompt_text   TEXT NOT NULL,
  is_active     BOOLEAN DEFAULT false,
  performance_score NUMERIC(5,4), -- aggregated success rate
  sample_size   INTEGER DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  promoted_at   TIMESTAMPTZ,      -- when it became active
  UNIQUE(agent, version)
);

-- Infrastructure registry: tracks what's provisioned per company
CREATE TABLE infra (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  company_id    TEXT NOT NULL REFERENCES companies(id),
  service       TEXT NOT NULL,   -- 'vercel', 'neon', 'github', 'stripe', 'resend', 'domain'
  resource_id   TEXT,            -- external ID from the service
  config        JSONB,           -- connection strings, API endpoints, etc.
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN (
                  'provisioning', 'active', 'failed', 'torn_down'
                )),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  torn_down_at  TIMESTAMPTZ
);

-- Social accounts: tracks connected social media per company
CREATE TABLE social_accounts (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  company_id    TEXT NOT NULL REFERENCES companies(id),
  platform      TEXT NOT NULL CHECK (platform IN (
                  'x', 'linkedin', 'instagram', 'tiktok', 'youtube'
                )),
  account_handle TEXT,
  auth_token    TEXT,             -- encrypted OAuth token
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                  'pending',      -- approval gate: you need to create this
                  'active',       -- authenticated and posting
                  'expired',      -- token expired, needs re-auth
                  'disabled'
                )),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Directives: commands from Carlos via dashboard or GitHub Issues
CREATE TABLE directives (
  id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  company_id          TEXT REFERENCES companies(id),
  agent               TEXT,            -- target agent (null = CEO decides)
  text                TEXT NOT NULL,
  github_issue_number INTEGER,
  github_issue_url    TEXT,
  status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done', 'rejected')),
  resolution          TEXT,            -- what was done about it
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at         TIMESTAMPTZ
);

-- Import registry: tracks existing/acquired projects onboarded into Hive
CREATE TABLE imports (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  company_id      TEXT REFERENCES companies(id),
  source_type     TEXT NOT NULL CHECK (source_type IN (
                    'github_repo',    -- existing repo on your GitHub
                    'external_repo',  -- repo you forked/acquired
                    'vercel_project', -- existing Vercel deployment
                    'manual'          -- manually registered
                  )),
  source_url      TEXT,              -- repo URL or Vercel project URL
  scan_status     TEXT NOT NULL DEFAULT 'pending' CHECK (scan_status IN (
                    'pending', 'scanning', 'scanned', 'failed'
                  )),
  scan_report     JSONB,             -- analysis results from the onboarding scan
  onboard_status  TEXT NOT NULL DEFAULT 'pending' CHECK (onboard_status IN (
                    'pending', 'in_progress', 'complete', 'failed'
                  )),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Settings: encrypted key-value store for API keys and configuration
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  is_secret   BOOLEAN DEFAULT false,
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- Indexes for dashboard performance
CREATE INDEX idx_cycles_company ON cycles(company_id, cycle_number DESC);
CREATE INDEX idx_actions_cycle ON agent_actions(cycle_id);
CREATE INDEX idx_actions_company ON agent_actions(company_id, started_at DESC);
CREATE INDEX idx_approvals_pending ON approvals(status) WHERE status = 'pending';
CREATE INDEX idx_metrics_company_date ON metrics(company_id, date DESC);
CREATE INDEX idx_playbook_domain ON playbook(domain);
CREATE INDEX idx_playbook_agents ON playbook USING GIN(relevant_agents);
CREATE INDEX idx_playbook_embedding ON playbook USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX idx_infra_company ON infra(company_id);
CREATE INDEX idx_directives_open ON directives(status) WHERE status = 'open';
CREATE INDEX idx_imports_company ON imports(company_id);

-- Research reports: market research, competitive analysis, lead lists per company
CREATE TABLE research_reports (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  company_id    TEXT NOT NULL REFERENCES companies(id),
  report_type   TEXT NOT NULL CHECK (report_type IN (
                  'market_research',      -- TAM, trends, demand signals, target audience
                  'competitive_analysis', -- competitors: pricing, features, gaps, positioning
                  'lead_list',            -- potential customers for cold outreach
                  'seo_keywords',         -- keyword research for organic growth
                  'outreach_log',         -- cold email sends, responses, conversion
                  'visibility_snapshot',  -- aggregated GSC/search visibility data
                  'llm_visibility',       -- LLM citation tracking results
                  'content_performance',  -- per-URL content audit metrics
                  'content_gaps',         -- identified content opportunities
                  'product_spec'          -- accumulated product vision, personas, roadmap
                )),
  content       JSONB NOT NULL,
  summary       TEXT,
  sources       JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(company_id, report_type)
);

CREATE INDEX idx_research_company ON research_reports(company_id);

-- Visibility metrics: time-series data for SEO and LLM tracking
CREATE TABLE visibility_metrics (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  company_id    TEXT NOT NULL REFERENCES companies(id),
  date          DATE NOT NULL,
  source        TEXT NOT NULL CHECK (source IN (
                  'gsc',           -- Google Search Console
                  'bwt',           -- Bing Webmaster Tools
                  'llm_gemini',    -- Gemini citation check
                  'vercel'         -- Vercel Analytics referrer data
                )),
  keyword       TEXT,              -- the search query or LLM prompt
  url           TEXT,              -- the page that ranked/was cited
  impressions   INTEGER DEFAULT 0,
  clicks        INTEGER DEFAULT 0,
  position      NUMERIC(6,2),      -- average search position
  ctr           NUMERIC(5,4),      -- click-through rate
  cited         BOOLEAN,           -- LLM: was the company cited?
  mentioned     BOOLEAN,           -- LLM: was the brand mentioned without link?
  competitors   JSONB,             -- LLM: which competitors were mentioned
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(company_id, date, source, keyword, url)
);

CREATE INDEX idx_visibility_company_date ON visibility_metrics(company_id, date DESC);
CREATE INDEX idx_visibility_keyword ON visibility_metrics(company_id, keyword);
CREATE INDEX idx_visibility_source ON visibility_metrics(company_id, source);

-- Dismissed todos: tracks which dashboard todos were dismissed
-- Dismissals expire after 30 days so recurring issues resurface
CREATE TABLE IF NOT EXISTS dismissed_todos (
  todo_id     TEXT PRIMARY KEY,
  dismissed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Evolver proposals: structured gap detection results that appear in the Inbox
CREATE TABLE IF NOT EXISTS evolver_proposals (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  gap_type        TEXT NOT NULL CHECK (gap_type IN ('outcome', 'capability', 'knowledge', 'process')),
  severity        TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  title           TEXT NOT NULL,
  diagnosis       TEXT NOT NULL,
  signal_source   TEXT NOT NULL,
  signal_data     JSONB DEFAULT '{}',
  proposed_fix    JSONB NOT NULL,
  affected_companies TEXT[] DEFAULT '{}',
  cross_company   BOOLEAN DEFAULT false,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'implemented', 'deferred')),
  playbook_entry_id TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at     TIMESTAMPTZ,
  implemented_at  TIMESTAMPTZ,
  decided_at      TIMESTAMPTZ,
  notes           TEXT
);

CREATE INDEX IF NOT EXISTS idx_evolver_proposals_status ON evolver_proposals(status);
CREATE INDEX IF NOT EXISTS idx_evolver_proposals_gap_type ON evolver_proposals(gap_type);

-- Context log: tracks decisions, learnings, and context from all tools
-- Sources: 'chat' (Claude Chat), 'code' (Claude Code), 'orch' (orchestrator), 'carlos' (manual)
CREATE TABLE context_log (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  source        TEXT NOT NULL CHECK (source IN ('chat', 'code', 'orch', 'carlos')),
  category      TEXT NOT NULL CHECK (category IN ('decision', 'learning', 'brainstorm', 'blocker', 'milestone', 'question')),
  summary       TEXT NOT NULL,                     -- one-line summary
  detail        TEXT,                              -- full context, reasoning, alternatives considered
  related_adr   TEXT,                              -- e.g. "ADR-010" if this is a decision
  related_file  TEXT,                              -- e.g. "orchestrator.ts" if this changes a file
  tags          TEXT[] DEFAULT '{}',               -- free-form tags for filtering
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_context_source ON context_log(source);
CREATE INDEX idx_context_category ON context_log(category);
CREATE INDEX idx_context_created ON context_log(created_at DESC);

-- Company tasks: per-company backlog of proposed/approved tasks
-- Generated by CEO agent during planning, Sentinel for gaps, or manually by Carlos
CREATE TABLE IF NOT EXISTS company_tasks (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  company_id    TEXT NOT NULL REFERENCES companies(id),
  category      TEXT NOT NULL CHECK (category IN ('engineering', 'growth', 'research', 'qa', 'ops', 'strategy')),
  title         TEXT NOT NULL,
  description   TEXT NOT NULL,
  priority      INT NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 3),  -- 0=critical, 1=high, 2=medium, 3=low
  status        TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'in_progress', 'done', 'dismissed')),
  source        TEXT NOT NULL DEFAULT 'ceo' CHECK (source IN ('ceo', 'sentinel', 'evolver', 'carlos')),
  prerequisites TEXT[] DEFAULT '{}',                   -- task IDs or descriptions that must complete first
  acceptance    TEXT,                                   -- how to verify this is done
  cycle_id      TEXT REFERENCES cycles(id),             -- which cycle completed this task
  github_issue_number INTEGER,                           -- linked GitHub Issue in company repo
  github_issue_url    TEXT,
  pr_number     INTEGER,                                 -- PR that implements this task
  pr_url        TEXT,
  spec          JSONB,                                    -- structured spec: {acceptance_criteria, files_allowed, files_forbidden, approach, complexity, estimated_turns, specialist}
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_company_tasks_company ON company_tasks(company_id, status);
CREATE INDEX idx_company_tasks_status ON company_tasks(status);

-- Error patterns: cross-session error→fix mapping (ReasoningBank-lite)
-- When an error is fixed, the pattern is stored so next time the same error occurs,
-- the fix is suggested immediately instead of re-deriving it.
CREATE TABLE error_patterns (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  pattern         TEXT NOT NULL,           -- normalized error (stripped of UUIDs, timestamps, paths)
  agent           TEXT NOT NULL,           -- which agent typically hits this
  fix_summary     TEXT NOT NULL,           -- what fixed it (one line)
  fix_detail      TEXT,                    -- detailed fix steps / code changes
  source_action_id TEXT,                   -- agent_action that first resolved this
  occurrences     INT DEFAULT 1,          -- how many times this pattern has been seen
  last_seen_at    TIMESTAMPTZ DEFAULT now(),
  resolved        BOOLEAN DEFAULT false,  -- true if a fix exists
  auto_fixable    BOOLEAN DEFAULT false,  -- true if Hive can fix without human intervention
  created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_error_patterns_pattern ON error_patterns USING gin (to_tsvector('english', pattern));
CREATE INDEX idx_error_patterns_agent ON error_patterns(agent);
CREATE INDEX idx_error_patterns_resolved ON error_patterns(resolved) WHERE resolved = true;

-- Hive self-improvement backlog: structured items for autonomous execution
CREATE TABLE hive_backlog (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  priority      TEXT NOT NULL DEFAULT 'P2' CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),
  title         TEXT NOT NULL,
  description   TEXT NOT NULL,     -- what to do, acceptance criteria
  category      TEXT NOT NULL DEFAULT 'feature' CHECK (category IN (
                  'bugfix', 'feature', 'refactor', 'infra', 'quality', 'research'
                )),
  status        TEXT NOT NULL DEFAULT 'ready' CHECK (status IN (
                  'ready',         -- available for dispatch
                  'approved',      -- Carlos approved (for P2/P3 needing gate)
                  'planning',      -- spec generation in progress
                  'dispatched',    -- sent to Engineer
                  'in_progress',   -- Engineer is working on it
                  'pr_open',       -- PR created, awaiting merge
                  'done',          -- completed (PR merged)
                  'blocked',       -- needs manual intervention
                  'rejected'       -- Carlos rejected
                )),
  source        TEXT DEFAULT 'brainstorm', -- brainstorm, sentinel, evolver, carlos
  company_id    TEXT REFERENCES companies(id), -- optional: company-scoped backlog items
  dispatch_id   TEXT,              -- agent_action id when dispatched
  pr_number     INTEGER,           -- PR created for risky changes
  pr_url        TEXT,
  parent_id     TEXT REFERENCES hive_backlog(id),  -- parent task (for decomposed sub-tasks)
  decomposition_context JSONB,     -- shared context doc for decomposed hierarchies
  github_issue_number INTEGER,     -- linked GitHub Issue in carloshmiranda/hive
  github_issue_url    TEXT,
  theme         TEXT,              -- links to ROADMAP.md milestone (e.g. 'dispatch_chain', 'self_improving')
  spec          JSONB,             -- planning phase output (acceptance criteria, affected files, approach)
  notes         TEXT,              -- resolution notes, blockers, etc.
  -- Work stealing fields
  stealable     BOOLEAN DEFAULT false,     -- true after 2 failures, available for any agent
  claimed_by    TEXT,                      -- agent that claimed this stealable task
  claimed_at    TIMESTAMPTZ,               -- when task was claimed (for 10-min grace period)
  original_agent TEXT,                     -- agent that originally failed on this task
  failure_count INTEGER DEFAULT 0,         -- persistent failure tracking (vs attempt tracking in notes)
  completion_percentage INTEGER DEFAULT 0 CHECK (completion_percentage >= 0 AND completion_percentage <= 100), -- for 75% protection
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now(),
  dispatched_at TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ
);
CREATE INDEX idx_hive_backlog_status ON hive_backlog(status);
CREATE INDEX idx_hive_backlog_priority ON hive_backlog(priority);
CREATE INDEX idx_hive_backlog_parent_id ON hive_backlog(parent_id) WHERE parent_id IS NOT NULL;
-- Work stealing indexes
CREATE INDEX idx_hive_backlog_stealable ON hive_backlog(stealable) WHERE stealable = true;
CREATE INDEX idx_hive_backlog_claimed_at ON hive_backlog(claimed_at) WHERE claimed_at IS NOT NULL;
CREATE INDEX idx_hive_backlog_failure_count ON hive_backlog(failure_count) WHERE failure_count > 0;

-- Routing weights: dynamic model routing based on task success rates
-- Tracks success/failure rates per (task_type, model) to auto-promote failing models
CREATE TABLE routing_weights (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  task_type     TEXT NOT NULL,           -- e.g. 'cycle_plan', 'execute_task', 'scaffold_company'
  model         TEXT NOT NULL,           -- e.g. 'claude-sonnet', 'gemini-flash', 'groq-llama'
  agent         TEXT NOT NULL,           -- which agent performs this task type
  successes     INTEGER DEFAULT 0,       -- count of successful completions
  failures      INTEGER DEFAULT 0,       -- count of failed completions
  success_rate  NUMERIC(5,4) GENERATED ALWAYS AS (
                  CASE WHEN (successes + failures) = 0 THEN 0.5
                       ELSE successes::numeric / (successes + failures)
                  END
                ) STORED,                 -- computed success rate (0.0-1.0)
  last_updated  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(task_type, model, agent)
);

CREATE INDEX idx_routing_weights_task_model ON routing_weights(task_type, model);
CREATE INDEX idx_routing_weights_agent ON routing_weights(agent);
CREATE INDEX idx_routing_weights_success_rate ON routing_weights(success_rate);

-- Context cache: cache agent context responses to reduce duplicate DB queries
-- Unlogged table for performance (data lost on crash, but cache can be rebuilt)
CREATE UNLOGGED TABLE context_cache (
  cache_key     TEXT PRIMARY KEY,           -- format: "company_id:agent_type:cycle_id"
  agent_type    TEXT NOT NULL CHECK (agent_type IN ('build', 'growth', 'fix')),
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  cycle_id      TEXT REFERENCES cycles(id) ON DELETE CASCADE,
  context_data  JSONB NOT NULL,             -- cached context response
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '10 minutes')
);

CREATE INDEX idx_context_cache_expires ON context_cache(expires_at);
CREATE INDEX idx_context_cache_company ON context_cache(company_id);
CREATE INDEX idx_context_cache_cycle ON context_cache(cycle_id);

-- CEO Strategic Decision Journal: track strategic decisions and validate them retroactively
-- Creates institutional memory for strategic quality and decision patterns
CREATE TABLE decision_log (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  company_id        TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  decision_type     TEXT NOT NULL CHECK (decision_type IN (
                      'kill',            -- company kill decision
                      'pivot',           -- business model/strategy pivot
                      'phase_change',    -- lifecycle phase transition
                      'priority_shift'   -- major task priority change
                    )),
  cycle_id          TEXT REFERENCES cycles(id),      -- which cycle triggered this decision
  reasoning         TEXT NOT NULL,                   -- CEO's explanation of why
  expected_outcome  TEXT NOT NULL,                   -- what CEO expects to happen
  actual_outcome    TEXT,                            -- what actually happened (filled retroactively)
  was_correct       BOOLEAN,                         -- retrospective validation (filled by Sentinel)
  decision_data     JSONB,                           -- additional context (old/new values, metrics, etc.)
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  validated_at      TIMESTAMPTZ                      -- when retrospective validation was done
);

CREATE INDEX idx_decision_log_company ON decision_log(company_id);
CREATE INDEX idx_decision_log_type ON decision_log(decision_type);
CREATE INDEX idx_decision_log_validation ON decision_log(was_correct) WHERE was_correct IS NOT NULL;
CREATE INDEX idx_decision_log_pending_validation ON decision_log(created_at) WHERE was_correct IS NULL;

-- ============================================================================
-- QA Testing Tables (webapp-testing skill integration)
-- ============================================================================

-- QA test runs: high-level run metadata
CREATE TABLE qa_runs (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  company_id        TEXT NOT NULL REFERENCES companies(id),
  deployment_url    TEXT NOT NULL,           -- URL that was tested
  workflow_run_id   TEXT,                   -- GitHub Actions run ID (if available)
  commit_sha        TEXT,                   -- Git commit that was tested
  branch            TEXT,                   -- Git branch
  pr_number         INTEGER,                -- Pull request number (if from PR)
  status            TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'error')),
  total_tests       INTEGER NOT NULL DEFAULT 0,
  passed_tests      INTEGER NOT NULL DEFAULT 0,
  failed_tests      INTEGER NOT NULL DEFAULT 0,
  skipped_tests     INTEGER NOT NULL DEFAULT 0,
  duration_ms       INTEGER,               -- Total test run duration
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- QA test results: individual test case results
CREATE TABLE qa_test_results (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  qa_run_id       TEXT NOT NULL REFERENCES qa_runs(id) ON DELETE CASCADE,
  test_suite      TEXT NOT NULL,           -- e.g., 'webapp-qa', 'smoke', 'custom'
  test_name       TEXT NOT NULL,           -- descriptive test name
  status          TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'skipped')),
  duration_ms     INTEGER,                 -- Individual test duration
  error_message   TEXT,                   -- Failure details
  screenshot_path TEXT,                   -- Path to failure screenshot
  console_logs    JSONB,                  -- Captured console logs array
  browser_logs    JSONB,                  -- Browser-specific logs array
  metadata        JSONB                   -- Additional test metadata
);

CREATE INDEX idx_qa_runs_company ON qa_runs(company_id);
CREATE INDEX idx_qa_runs_status ON qa_runs(status);
CREATE INDEX idx_qa_runs_started ON qa_runs(started_at);
CREATE INDEX idx_qa_runs_workflow ON qa_runs(workflow_run_id) WHERE workflow_run_id IS NOT NULL;
CREATE INDEX idx_qa_test_results_run ON qa_test_results(qa_run_id);
CREATE INDEX idx_qa_test_results_status ON qa_test_results(status);

-- Plugin registry: extensible capability system for agent plugins
CREATE TABLE IF NOT EXISTS hive_plugins (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  version     TEXT NOT NULL DEFAULT '1.0.0',
  enabled     BOOLEAN NOT NULL DEFAULT false,
  manifest    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hive_plugins_enabled ON hive_plugins(enabled);
