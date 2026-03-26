-- ============================================================================
-- Migration 010: Enhanced playbook smart management
-- Adds success rate tracking, similarity merging, variance-based splitting, and pruning
--
-- Features:
--   1. Exponential moving average success rate tracking (lr=0.1)
--   2. Weighted average merging for >0.9 similarity entries
--   3. High variance splitting into domain-specific variants
--   4. Capacity-based pruning using successRate * log(usageCount + 1)
-- ============================================================================

-- Add new columns for smart management
ALTER TABLE playbook ADD COLUMN IF NOT EXISTS success_rate NUMERIC(4,3) DEFAULT NULL CHECK (success_rate BETWEEN 0 AND 1);
ALTER TABLE playbook ADD COLUMN IF NOT EXISTS usage_count INTEGER DEFAULT 0;
ALTER TABLE playbook ADD COLUMN IF NOT EXISTS outcome_history JSONB DEFAULT '[]'::jsonb;
ALTER TABLE playbook ADD COLUMN IF NOT EXISTS last_outcome_at TIMESTAMPTZ;
ALTER TABLE playbook ADD COLUMN IF NOT EXISTS split_from TEXT REFERENCES playbook(id);
ALTER TABLE playbook ADD COLUMN IF NOT EXISTS variance_score NUMERIC(4,3) DEFAULT NULL CHECK (variance_score BETWEEN 0 AND 1);

-- Create index for efficient similarity queries and pruning
CREATE INDEX IF NOT EXISTS idx_playbook_similarity ON playbook(domain, confidence DESC) WHERE superseded_by IS NULL;
CREATE INDEX IF NOT EXISTS idx_playbook_pruning_score ON playbook(
    (COALESCE(success_rate, 0.5) * ln(GREATEST(usage_count + 1, 1)))
) WHERE superseded_by IS NULL;
CREATE INDEX IF NOT EXISTS idx_playbook_variance ON playbook(variance_score DESC) WHERE superseded_by IS NULL AND variance_score IS NOT NULL;

-- Add comments for documentation
COMMENT ON COLUMN playbook.success_rate IS 'Exponential moving average success rate (lr=0.1) based on outcome feedback';
COMMENT ON COLUMN playbook.usage_count IS 'Number of times this entry has been referenced/used by agents';
COMMENT ON COLUMN playbook.outcome_history IS 'Array of recent outcomes {success: boolean, timestamp: string} for variance calculation';
COMMENT ON COLUMN playbook.last_outcome_at IS 'Timestamp of last outcome recorded for this entry';
COMMENT ON COLUMN playbook.split_from IS 'ID of parent entry if this was split due to high variance';
COMMENT ON COLUMN playbook.variance_score IS 'Variance of recent outcomes (0=consistent, 1=highly variable)';