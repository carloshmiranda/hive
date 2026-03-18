-- Company database schema — run against the company's own Neon project
-- This is the minimum viable schema. The Engineer agent will extend it.

CREATE TABLE IF NOT EXISTS customers (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  email           TEXT UNIQUE NOT NULL,
  stripe_customer_id TEXT,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'churned', 'paused')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(email);
CREATE INDEX IF NOT EXISTS idx_customers_stripe ON customers(stripe_customer_id);
