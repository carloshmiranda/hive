-- Migration 003: Agent Consolidation (10 → 7)
-- Renames: idea_scout/research_analyst → scout, venture_brain/kill_switch/retro_analyst → ceo,
--          health_monitor/auto_healer/healer → ops, provisioner → engineer, prompt_evolver → evolver
-- Date: 2026-03-19

-- 1. Update agent_actions CHECK constraint
ALTER TABLE agent_actions DROP CONSTRAINT IF EXISTS agent_actions_agent_check;
ALTER TABLE agent_actions ADD CONSTRAINT agent_actions_agent_check
  CHECK (agent IN ('ceo','scout','engineer','ops','growth','outreach','evolver'));

-- 2. Make cycle_id and company_id nullable (already done in 002, but ensure)
ALTER TABLE agent_actions ALTER COLUMN cycle_id DROP NOT NULL;
ALTER TABLE agent_actions ALTER COLUMN company_id DROP NOT NULL;

-- 3. Update approvals gate_type CHECK
ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_gate_type_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_gate_type_check
  CHECK (gate_type IN ('new_company','growth_strategy','spend_approval','kill_company','prompt_upgrade','escalation','outreach_batch','first_revenue'));

-- 4. Rename agent names in existing data
UPDATE agent_actions SET agent = 'scout' WHERE agent IN ('idea_scout','research_analyst');
UPDATE agent_actions SET agent = 'ops' WHERE agent IN ('health_monitor','auto_healer','healer');
UPDATE agent_actions SET agent = 'ceo' WHERE agent IN ('venture_brain','kill_switch','retro_analyst');
UPDATE agent_actions SET agent = 'engineer' WHERE agent = 'provisioner';
UPDATE agent_actions SET agent = 'evolver' WHERE agent = 'prompt_evolver';

-- 5. Rename in agent_prompts
UPDATE agent_prompts SET agent = 'scout' WHERE agent IN ('idea_scout','research_analyst');
UPDATE agent_prompts SET agent = 'ops' WHERE agent IN ('health_monitor','auto_healer','healer');
UPDATE agent_prompts SET agent = 'ceo' WHERE agent = 'venture_brain';
UPDATE agent_prompts SET agent = 'evolver' WHERE agent = 'prompt_evolver';
