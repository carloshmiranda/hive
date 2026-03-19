-- Migration 006: Add waitlist metrics columns to metrics table
-- These are populated by Ops agent when it checks company health

ALTER TABLE metrics ADD COLUMN IF NOT EXISTS waitlist_signups INTEGER DEFAULT 0;
ALTER TABLE metrics ADD COLUMN IF NOT EXISTS waitlist_total INTEGER DEFAULT 0;
ALTER TABLE metrics ADD COLUMN IF NOT EXISTS email_opens INTEGER DEFAULT 0;
ALTER TABLE metrics ADD COLUMN IF NOT EXISTS email_clicks INTEGER DEFAULT 0;
ALTER TABLE metrics ADD COLUMN IF NOT EXISTS email_bounces INTEGER DEFAULT 0;
