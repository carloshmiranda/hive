-- Migration 005: Dismissed todos tracking
-- Tracks which dynamic dashboard todos Carlos has dismissed
-- Dismissals expire after 30 days so recurring issues resurface

CREATE TABLE IF NOT EXISTS dismissed_todos (
  todo_id     TEXT PRIMARY KEY,
  dismissed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
