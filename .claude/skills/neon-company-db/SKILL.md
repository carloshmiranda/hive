---
name: neon-company-db
description: Invoke when querying or writing to a Hive portfolio company's database, adding new tables, writing SQL queries, or setting up the database connection in a company app. Also use when the user mentions "add a table," "database migration," "SQL query," "company schema," "getDb," "neon connection," "database setup," or "add a column." Each Hive company has its own Neon Postgres project with a provisioned schema.
metadata:
  version: 1.0.0
---

# Neon Postgres for Hive Companies

Each Hive company has its own **Neon Postgres project** provisioned via the Vercel Marketplace integration. The database connection string is in `DATABASE_URL` env var (set by Vercel/Neon integration automatically).

## Architecture Rules

- One Neon project per company (not one project for all companies)
- `DATABASE_URL` is set automatically by Vercel's Neon Marketplace integration
- Use `@neondatabase/serverless` driver — NOT `pg` or `postgres` npm packages
- All queries are parameterized — NEVER string-interpolate user input into SQL
- Schema lives in `schema.sql` in the company repo — source of truth for data model

## Setup

```bash
npm install @neondatabase/serverless
```

```typescript
// src/lib/db.ts
import { neon } from '@neondatabase/serverless';

export function getDb() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set');
  }
  return neon(process.env.DATABASE_URL);
}

export function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

export function err(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}
```

## Pre-Provisioned Tables

Every Hive company schema includes these tables from day one:

### Core Tables

| Table | Purpose |
|-------|---------|
| `waitlist` | Email capture before launch |
| `customers` | Paying customers (Stripe customer records) |
| `page_views` | Page-level analytics |
| `pricing_clicks` | Pricing page / CTA click tracking |
| `affiliate_clicks` | Affiliate link click tracking |
| `email_sequences` | Email drip campaign content |
| `email_log` | Record of all sent emails |
| `metrics` | Daily business metrics snapshot |

### Waitlist Table

```sql
CREATE TABLE waitlist (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  referral_code TEXT UNIQUE,
  referred_by TEXT,
  position SERIAL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

```typescript
// Query patterns
const sql = getDb();

// Insert with conflict handling
const [entry] = await sql`
  INSERT INTO waitlist (email, name, referral_code)
  VALUES (${email}, ${name || null}, ${referralCode})
  ON CONFLICT (email) DO NOTHING
  RETURNING *
`;

// Get position
const [{ count }] = await sql`SELECT count(*) FROM waitlist`;

// Get by referral code
const [referrer] = await sql`
  SELECT * FROM waitlist WHERE referral_code = ${code}
`;
```

### Customers Table

```sql
CREATE TABLE customers (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  plan TEXT DEFAULT 'free',
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'cancelled', 'churned', 'past_due')),
  trial_ends_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

```typescript
// Insert or update on Stripe webhook
await sql`
  INSERT INTO customers (email, stripe_customer_id, stripe_subscription_id, plan, status)
  VALUES (${email}, ${customerId}, ${subscriptionId}, ${plan}, 'active')
  ON CONFLICT (email) DO UPDATE SET
    stripe_customer_id = EXCLUDED.stripe_customer_id,
    stripe_subscription_id = EXCLUDED.stripe_subscription_id,
    plan = EXCLUDED.plan,
    status = 'active',
    updated_at = now()
`;

// Check subscription status
const [customer] = await sql`
  SELECT * FROM customers WHERE email = ${email}
`;
const isPaid = customer?.status === 'active' && customer?.plan !== 'free';
```

### Page Views Table

```sql
CREATE TABLE page_views (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  path TEXT NOT NULL,
  referrer TEXT,
  user_agent TEXT,
  country TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  session_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

```typescript
// Track page view (in middleware or layout)
await sql`
  INSERT INTO page_views (path, referrer, user_agent, country, utm_source, utm_medium, utm_campaign)
  VALUES (
    ${path}, ${referrer || null}, ${userAgent || null}, ${country || null},
    ${utmSource || null}, ${utmMedium || null}, ${utmCampaign || null}
  )
`;

// Analytics query
const views = await sql`
  SELECT
    path,
    count(*) as views,
    count(DISTINCT session_id) as sessions
  FROM page_views
  WHERE created_at >= NOW() - INTERVAL '30 days'
  GROUP BY path
  ORDER BY views DESC
  LIMIT 20
`;
```

### Pricing Clicks Table

```sql
CREATE TABLE pricing_clicks (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tier TEXT NOT NULL,
  source_path TEXT,
  session_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

```typescript
// Track click on pricing CTA
await sql`
  INSERT INTO pricing_clicks (tier, source_path)
  VALUES (${tier}, ${sourcePath})
`;

// Revenue readiness metric
const [{ count }] = await sql`
  SELECT count(*) FROM pricing_clicks
  WHERE created_at >= NOW() - INTERVAL '30 days'
`;
```

### Metrics Table (Daily Snapshot)

```sql
CREATE TABLE metrics (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  mrr NUMERIC(10,2) DEFAULT 0,
  revenue NUMERIC(10,2) DEFAULT 0,
  customers INTEGER DEFAULT 0,
  waitlist_count INTEGER DEFAULT 0,
  page_views INTEGER DEFAULT 0,
  signups INTEGER DEFAULT 0,
  churn INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(date)
);
```

```typescript
// Daily metrics upsert (called by cron)
const waitlistCount = await sql`SELECT count(*) as count FROM waitlist`.then(r => Number(r[0].count));
const customerCount = await sql`SELECT count(*) as count FROM customers WHERE status = 'active'`.then(r => Number(r[0].count));
const viewCount = await sql`SELECT count(*) as count FROM page_views WHERE DATE(created_at) = CURRENT_DATE`.then(r => Number(r[0].count));

await sql`
  INSERT INTO metrics (date, customers, waitlist_count, page_views)
  VALUES (CURRENT_DATE, ${customerCount}, ${waitlistCount}, ${viewCount})
  ON CONFLICT (date) DO UPDATE SET
    customers = EXCLUDED.customers,
    waitlist_count = EXCLUDED.waitlist_count,
    page_views = EXCLUDED.page_views
`;
```

## Adding New Tables

When the company needs additional data, add to `schema.sql` and apply:

```sql
-- Example: user profiles
CREATE TABLE IF NOT EXISTS user_profiles (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
  display_name TEXT,
  avatar_url TEXT,
  preferences JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_profiles_customer_id ON user_profiles(customer_id);
```

Apply via SQL:
```typescript
// One-time migration in /api/migrate/route.ts (protect with admin auth)
await sql`CREATE TABLE IF NOT EXISTS user_profiles ...`;
```

## Query Patterns

### Parameterized Queries (Always Use This)

```typescript
// ✅ CORRECT — parameterized
const [user] = await sql`SELECT * FROM customers WHERE email = ${email}`;

// ❌ WRONG — never do this
const [user] = await sql`SELECT * FROM customers WHERE email = '${email}'`;
```

### Transactions

```typescript
// Neon serverless supports transactions
await sql.transaction(async (txSql) => {
  const [customer] = await txSql`
    INSERT INTO customers (email) VALUES (${email}) RETURNING *
  `;
  await txSql`
    INSERT INTO email_log (recipient, subject, status)
    VALUES (${email}, 'Welcome!', 'pending')
  `;
  return customer;
});
```

### JSON Aggregation

```typescript
// Return related data as nested JSON (avoids N+1)
const customers = await sql`
  SELECT
    c.*,
    (
      SELECT json_agg(el ORDER BY el.created_at DESC)
      FROM email_log el
      WHERE el.recipient = c.email
      LIMIT 5
    ) as recent_emails
  FROM customers c
  WHERE c.status = 'active'
`;
```

### Pagination

```typescript
const PAGE_SIZE = 20;
const offset = (page - 1) * PAGE_SIZE;

const customers = await sql`
  SELECT * FROM customers
  WHERE status = 'active'
  ORDER BY created_at DESC
  LIMIT ${PAGE_SIZE} OFFSET ${offset}
`;
```

## Rules

- Always handle the case where a query returns empty array (destructure `[result]` may be undefined)
- Use `TIMESTAMPTZ` for all timestamps (timezone-aware)
- Use `UUID` with `gen_random_uuid()` for primary keys — never serial integers for exposed IDs
- Add `IF NOT EXISTS` on `CREATE TABLE` to make migrations idempotent
- Use `ON CONFLICT DO UPDATE` (upsert) instead of separate select-then-insert logic
- Keep queries in API route files or dedicated `src/lib/queries.ts` — never in React components
