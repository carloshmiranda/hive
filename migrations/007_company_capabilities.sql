-- Migration 007: Company capability inventory
-- Tracks what infrastructure, integrations, and features each company actually has

-- Structured capability inventory
ALTER TABLE companies ADD COLUMN IF NOT EXISTS capabilities JSONB DEFAULT '{}';

-- Company type for compatibility matrix decisions
ALTER TABLE companies ADD COLUMN IF NOT EXISTS company_type TEXT DEFAULT 'b2c_saas';

-- Distinguish provisioned vs imported companies
ALTER TABLE companies ADD COLUMN IF NOT EXISTS imported BOOLEAN DEFAULT false;

-- Track when capabilities were last verified
ALTER TABLE companies ADD COLUMN IF NOT EXISTS last_assessed_at TIMESTAMPTZ;
