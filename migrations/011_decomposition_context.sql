-- Migration 011: Add parent-child linking and decomposition context to hive_backlog
-- Replaces fragile text-pattern matching with proper FK + context document pattern.
-- GitHub sub-issues API (GA) used for human-facing hierarchy.

-- Parent-child relationship for decomposed tasks
ALTER TABLE hive_backlog ADD COLUMN IF NOT EXISTS parent_id TEXT REFERENCES hive_backlog(id);

-- Shared context document for decomposed task hierarchies
-- Contains: goal, constraints, decisions, file_manifest, sub_tasks, failure_history
ALTER TABLE hive_backlog ADD COLUMN IF NOT EXISTS decomposition_context JSONB;

-- Index for efficient child lookups
CREATE INDEX IF NOT EXISTS idx_hive_backlog_parent_id ON hive_backlog(parent_id) WHERE parent_id IS NOT NULL;
