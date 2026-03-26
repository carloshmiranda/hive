-- ============================================================================
-- Migration 009: Partition agent_actions table for storage optimization
-- Run against LIVE Neon database to enable pg_partman and setup partitioning
--
-- Issue: agent_actions grows at 100+ rows/day (36K+/year), risking 0.5 GB Neon free tier
-- Solution: Monthly partitions on started_at with 6-month retention policy
--
-- Steps:
--   1. Enable pg_partman extension
--   2. Convert agent_actions to partitioned table
--   3. Create initial partition for current month
--   4. Configure auto-partitioning for future months
--   5. Set up retention policy (6 months)
--   6. Create pg_cron job for daily maintenance
-- ============================================================================

-- 1. Enable required extensions
CREATE EXTENSION IF NOT EXISTS pg_partman;
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- 2. Create partitioned version of agent_actions table
-- First, rename existing table
ALTER TABLE agent_actions RENAME TO agent_actions_old;

-- Create partitioned table with same structure
CREATE TABLE agent_actions (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  cycle_id      TEXT REFERENCES cycles(id),
  company_id    TEXT REFERENCES companies(id),
  agent         TEXT NOT NULL CHECK (agent IN (
                  'ceo', 'scout', 'engineer', 'ops', 'growth', 'outreach', 'evolver',
                  'healer', 'orchestrator', 'sentinel', 'auto_merge', 'dispatch',
                  'webhook', 'system', 'admin'
                )),
  action_type   TEXT NOT NULL,
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                  'pending', 'running', 'success', 'failed', 'skipped', 'escalated',
                  'pending_manual', 'completed'
                )),
  input         JSONB,
  output        JSONB,
  error         TEXT,
  retry_count   INTEGER DEFAULT 0,
  reflection    TEXT,
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  tokens_used   INTEGER
) PARTITION BY RANGE (started_at);

-- 3. Copy all existing data to the new partitioned table
INSERT INTO agent_actions SELECT * FROM agent_actions_old;

-- 4. Set up partitioning with pg_partman
-- Create monthly partitions starting from the earliest data
SELECT partman.create_parent(
  p_parent_table => 'public.agent_actions',
  p_control => 'started_at',
  p_type => 'range',
  p_interval => 'monthly',
  p_premake => 2,  -- Create 2 months ahead
  p_start_partition => date_trunc('month', COALESCE(
    (SELECT MIN(started_at) FROM agent_actions_old),
    date_trunc('month', NOW() - INTERVAL '1 month')
  ))::text
);

-- 5. Configure retention policy (keep 6 months)
UPDATE partman.part_config
SET retention = '6 months',
    retention_keep_table = false,  -- Drop old partitions entirely
    retention_keep_index = false
WHERE parent_table = 'public.agent_actions';

-- 6. Recreate indexes on the partitioned table
CREATE INDEX idx_actions_cycle ON agent_actions(cycle_id);
CREATE INDEX idx_actions_company ON agent_actions(company_id, started_at DESC);

-- 7. Schedule daily maintenance with pg_cron
-- Run partition maintenance every day at 2 AM UTC
SELECT cron.schedule(
  'partman-agent-actions-maintenance',
  '0 2 * * *',  -- Daily at 2 AM
  'SELECT partman.run_maintenance(''public.agent_actions'', p_analyze := false);'
);

-- 8. Drop the old table (commented out for safety - uncomment after verification)
-- DROP TABLE agent_actions_old;

-- ============================================================================
-- Verification queries (run these to confirm the migration worked):
-- ============================================================================
-- Check that partman is enabled:
-- SELECT * FROM partman.part_config WHERE parent_table = 'public.agent_actions';

-- Check created partitions:
-- SELECT schemaname, tablename FROM pg_tables WHERE tablename LIKE 'agent_actions_%' ORDER BY tablename;

-- Verify data was copied:
-- SELECT COUNT(*) FROM agent_actions;
-- SELECT COUNT(*) FROM agent_actions_old;

-- Check cron job was created:
-- SELECT * FROM cron.job WHERE jobname = 'partman-agent-actions-maintenance';

-- Test partition pruning (should show partition exclusion):
-- EXPLAIN (COSTS OFF, BUFFERS OFF)
-- SELECT * FROM agent_actions
-- WHERE started_at >= '2024-01-01' AND started_at < '2024-02-01';