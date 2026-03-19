-- Migration 008: Evolver proposals table + playbook reference tracking

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
  notes           TEXT
);

CREATE INDEX IF NOT EXISTS idx_evolver_proposals_status ON evolver_proposals(status);
CREATE INDEX IF NOT EXISTS idx_evolver_proposals_gap_type ON evolver_proposals(gap_type);

-- Add playbook usage tracking
ALTER TABLE playbook ADD COLUMN IF NOT EXISTS last_referenced_at TIMESTAMPTZ;
ALTER TABLE playbook ADD COLUMN IF NOT EXISTS reference_count INTEGER DEFAULT 0;
