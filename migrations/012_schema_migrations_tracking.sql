-- Migration 012: Schema migrations tracking table
-- Records which migration files have been applied so the auto-migration
-- workflow (hive-migrate.yml) can skip already-applied files.

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
