-- ============================================================================
-- HIVE — Venture Orchestrator Schema
-- Run against Neon Postgres. This is the single source of truth.
-- ============================================================================

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
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  killed_at     TIMESTAMPTZ,
  kill_reason   TEXT
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
                  'ceo', 'scout', 'engineer', 'ops', 'growth', 'outreach', 'evolver'
                )),
  action_type   TEXT NOT NULL,   -- e.g. 'deploy_code', 'send_email', 'write_post'
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                  'pending', 'running', 'success', 'failed', 'skipped', 'escalated'
                )),
  input         JSONB,           -- what was fed to the agent
  output        JSONB,           -- what it produced
  error         TEXT,            -- if failed
  retry_count   INTEGER DEFAULT 0,
  reflection    TEXT,            -- self-reflection on failure (Reflexion pattern)
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  tokens_used   INTEGER          -- track consumption
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
                  'first_revenue'        -- first paying customer detected
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
  superseded_by TEXT REFERENCES playbook(id) -- if a newer insight replaces this
);

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
                  'content_gaps'          -- identified content opportunities
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
