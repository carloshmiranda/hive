-- Migration 004: Visibility metrics for SEO and LLM tracking
-- Time-series data: one row per keyword per date per source per company

CREATE TABLE IF NOT EXISTS visibility_metrics (
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

-- Add new report types to research_reports
ALTER TABLE research_reports DROP CONSTRAINT IF EXISTS research_reports_report_type_check;
ALTER TABLE research_reports ADD CONSTRAINT research_reports_report_type_check
  CHECK (report_type IN (
    'market_research', 'competitive_analysis', 'lead_list', 'seo_keywords', 'outreach_log',
    'visibility_snapshot', 'llm_visibility', 'content_performance', 'content_gaps'
  ));
