-- ============================================================================
-- Migration 002: Fix schema constraints for orchestrator + worker dispatch
-- Run against LIVE Neon database before deploying the new code
-- 
-- Fixes:
--   1. agent_actions.cycle_id NOT NULL → nullable (portfolio-level actions)
--   2. agent_actions.company_id NOT NULL → nullable (portfolio-level actions)
--   3. agent_actions agent CHECK → add outreach, research_analyst, healer, orchestrator
--   4. approvals gate_type CHECK → add outreach_batch, vercel_pro_upgrade, social_account, first_revenue
--   5. settings table missing from schema.sql → create if not exists
-- ============================================================================

-- 1. Allow NULL cycle_id (Idea Scout, Healer, Provisioner have no cycle)
ALTER TABLE agent_actions ALTER COLUMN cycle_id DROP NOT NULL;

-- 2. Allow NULL company_id (Idea Scout, Healer operate at portfolio level)
ALTER TABLE agent_actions ALTER COLUMN company_id DROP NOT NULL;

-- 3. Expand agent CHECK to include all agents used by orchestrator + dispatch
ALTER TABLE agent_actions DROP CONSTRAINT IF EXISTS agent_actions_agent_check;
ALTER TABLE agent_actions ADD CONSTRAINT agent_actions_agent_check
  CHECK (agent IN (
    'ceo', 'engineer', 'growth', 'ops', 'venture_brain',
    'idea_scout', 'kill_switch', 'retro_analyst', 'prompt_evolver',
    'health_monitor', 'auto_healer', 'provisioner',
    'outreach', 'research_analyst', 'healer', 'orchestrator'
  ));

-- 4. Expand gate_type CHECK to include all gates used by orchestrator + webhooks
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_gate_type_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_gate_type_check
  CHECK (gate_type IN (
    'new_company', 'growth_strategy', 'spend_approval',
    'kill_company', 'prompt_upgrade', 'escalation',
    'outreach_batch', 'vercel_pro_upgrade', 'social_account', 'first_revenue'
  ));

-- 5. Create settings table if not exists (was only created dynamically by API route)
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  is_secret   BOOLEAN DEFAULT false,
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- Verify: run these to confirm the migration worked
-- SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'agent_actions' AND column_name IN ('cycle_id', 'company_id');
-- SELECT constraint_name FROM information_schema.table_constraints WHERE table_name = 'agent_actions' AND constraint_type = 'CHECK';
-- SELECT table_name FROM information_schema.tables WHERE table_name = 'settings';
