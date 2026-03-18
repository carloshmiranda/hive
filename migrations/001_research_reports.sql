-- Migration: Add research_reports table for market research and competitive analysis
-- Run this against your Neon database after deploying

CREATE TABLE IF NOT EXISTS research_reports (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  company_id    TEXT NOT NULL REFERENCES companies(id),
  report_type   TEXT NOT NULL CHECK (report_type IN (
                  'market_research',    -- TAM, trends, demand signals, target audience deep-dive
                  'competitive_analysis', -- competitors mapped with pricing, features, gaps
                  'lead_list',          -- potential customers/targets for outreach
                  'seo_keywords',       -- keyword research for organic growth
                  'outreach_log'        -- cold email sends and responses
                )),
  content       JSONB NOT NULL,         -- structured report content
  summary       TEXT,                   -- one-paragraph human-readable summary
  sources       JSONB,                  -- URLs/sources used in research
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(company_id, report_type)       -- one active report per type per company (upsert pattern)
);

CREATE INDEX idx_research_company ON research_reports(company_id);
