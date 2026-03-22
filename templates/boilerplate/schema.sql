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

-- Waitlist: pre-launch signups with referral mechanics
CREATE TABLE IF NOT EXISTS waitlist (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  email           TEXT UNIQUE NOT NULL,
  name            TEXT,
  referral_code   TEXT UNIQUE NOT NULL,          -- this user's unique code
  referred_by     TEXT REFERENCES waitlist(id),   -- who referred them
  referral_count  INTEGER NOT NULL DEFAULT 0,     -- how many people they referred
  position        INTEGER,                        -- queue position (null = not yet assigned)
  source          TEXT DEFAULT 'organic',          -- organic, referral, social, blog, ad
  utm_source      TEXT,
  utm_medium      TEXT,
  utm_campaign    TEXT,
  status          TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'invited', 'converted', 'churned')),
  invited_at      TIMESTAMPTZ,
  converted_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_waitlist_email ON waitlist(email);
CREATE INDEX IF NOT EXISTS idx_waitlist_referral_code ON waitlist(referral_code);
CREATE INDEX IF NOT EXISTS idx_waitlist_status ON waitlist(status);
CREATE INDEX IF NOT EXISTS idx_waitlist_position ON waitlist(position);

-- Email sequences: Growth-managed structured email data
CREATE TABLE IF NOT EXISTS email_sequences (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  sequence        TEXT NOT NULL,                   -- e.g. 'waitlist_welcome', 'onboarding_d1'
  step            INTEGER NOT NULL DEFAULT 1,
  subject         TEXT NOT NULL,
  body_html       TEXT NOT NULL,
  body_text       TEXT,
  delay_hours     INTEGER NOT NULL DEFAULT 0,      -- hours after trigger to send
  variant         TEXT DEFAULT 'a',                 -- a/b testing
  is_active       BOOLEAN DEFAULT true,
  send_count      INTEGER DEFAULT 0,
  open_count      INTEGER DEFAULT 0,
  click_count     INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(sequence, step, variant)
);

-- Email log: tracks every email sent for deliverability and metrics
CREATE TABLE IF NOT EXISTS email_log (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  recipient       TEXT NOT NULL,
  sequence_id     TEXT REFERENCES email_sequences(id),
  subject         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'delivered', 'opened', 'clicked', 'bounced', 'complained')),
  resend_id       TEXT,                            -- Resend message ID for tracking
  opened_at       TIMESTAMPTZ,
  clicked_at      TIMESTAMPTZ,
  bounced_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_log_recipient ON email_log(recipient);
CREATE INDEX IF NOT EXISTS idx_email_log_sequence ON email_log(sequence_id);
CREATE INDEX IF NOT EXISTS idx_email_log_resend_id ON email_log(resend_id);

-- Lightweight pageview counter for Hive metrics collection
CREATE TABLE IF NOT EXISTS page_views (
  date            DATE NOT NULL DEFAULT CURRENT_DATE,
  path            TEXT NOT NULL DEFAULT '/',
  views           INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (date, path)
);
