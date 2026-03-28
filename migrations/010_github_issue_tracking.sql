-- Migration 010: Add GitHub Issue tracking to hive_backlog and company_tasks
-- Part of work tracking overhaul (Phase 2 of gap assessment)
-- GitHub Issues become the canonical human-facing work tracker;
-- DB retains operational metadata (dispatch_id, timing, metrics)

-- Hive self-improvement backlog: link to issue in carloshmiranda/hive
ALTER TABLE hive_backlog ADD COLUMN IF NOT EXISTS github_issue_number INTEGER;
ALTER TABLE hive_backlog ADD COLUMN IF NOT EXISTS github_issue_url TEXT;

-- Company tasks: link to issue in the company's own repo
ALTER TABLE company_tasks ADD COLUMN IF NOT EXISTS github_issue_number INTEGER;
ALTER TABLE company_tasks ADD COLUMN IF NOT EXISTS github_issue_url TEXT;
ALTER TABLE company_tasks ADD COLUMN IF NOT EXISTS pr_number INTEGER;
ALTER TABLE company_tasks ADD COLUMN IF NOT EXISTS pr_url TEXT;
