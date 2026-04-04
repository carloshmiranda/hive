---
name: sentry-company
description: Invoke when adding error monitoring, Sentry, crash reporting, performance tracking, or error tracking to a Hive portfolio company's Next.js app. Also use when the user mentions "track errors," "error monitoring," "add Sentry," "sentry setup," "production errors," "performance monitoring," or "crash reports" for a company. Hive uses a single Sentry organization with one project per company.
metadata:
  version: 1.0.0
---

# Sentry for Hive Companies

Hive uses a **single Sentry organization** with one Sentry project per portfolio company. Each company's project is configured via Vercel Marketplace for unified billing and single sign-on.

## Architecture Rules

- One Sentry project per company (named after the company slug)
- Installed via Vercel Marketplace: unified billing, SSO from Vercel dashboard
- Company SENTRY_DSN is set as Vercel env var per project
- Error monitoring on all three runtimes: browser, Node.js server, Edge
- 10% trace sampling in production (100% in dev)
- `NEXT_NOT_FOUND` errors filtered out (expected behavior, not bugs)

## Environment Variables (Set by Vercel Marketplace)

```
NEXT_PUBLIC_SENTRY_DSN=https://xxx@yyy.ingest.sentry.io/zzz
SENTRY_DSN=https://xxx@yyy.ingest.sentry.io/zzz
SENTRY_AUTH_TOKEN=sntrys_...   # For source map uploads at build time
SENTRY_ORG=hive-ventures        # Sentry org slug
SENTRY_PROJECT=company-slug     # Company-specific project
```

## Installation

```bash
npm install @sentry/nextjs
```

Or use the wizard (recommended for new companies):
```bash
npx @sentry/wizard@latest -i nextjs
```

## Setup Files

### `instrumentation-client.ts` — Browser Runtime

```typescript
import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  sendDefaultPii: true,
  tracesSampleRate: process.env.NODE_ENV === 'development' ? 1.0 : 0.1,
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,
  integrations: [Sentry.replayIntegration()],
  beforeSend(event) {
    // Filter out Next.js not-found errors
    if (event.exception?.values?.[0]?.type === 'NEXT_NOT_FOUND') {
      return null;
    }
    return event;
  },
});

// Track App Router navigation
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
```

### `sentry.server.config.ts` — Node.js Server Runtime

```typescript
import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  sendDefaultPii: true,
  tracesSampleRate: process.env.NODE_ENV === 'development' ? 1.0 : 0.1,
  includeLocalVariables: true,
  beforeSend(event) {
    if (event.exception?.values?.[0]?.type === 'NEXT_NOT_FOUND') {
      return null;
    }
    return event;
  },
});
```

### `sentry.edge.config.ts` — Edge Runtime

```typescript
import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  sendDefaultPii: true,
  tracesSampleRate: process.env.NODE_ENV === 'development' ? 1.0 : 0.1,
});
```

### `instrumentation.ts` — Server Registration Hook

```typescript
import * as Sentry from '@sentry/nextjs';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

// Captures all unhandled server-side request errors
export const onRequestError = Sentry.captureRequestError;
```

### `app/global-error.tsx` — App Router Error Boundary

```tsx
'use client';
import * as Sentry from '@sentry/nextjs';
import NextError from 'next/error';
import { useEffect } from 'react';

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html>
      <body>
        <NextError statusCode={0} />
      </body>
    </html>
  );
}
```

### `next.config.ts` — Wrap with Sentry

```typescript
import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs';

const nextConfig: NextConfig = {
  // your existing config
};

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  widenClientFileUpload: true,
  tunnelRoute: '/monitoring',
  silent: !process.env.CI,
});
```

### Exclude Tunnel Route from Middleware

```typescript
// middleware.ts — add /monitoring to matcher exclusions
export const config = {
  matcher: [
    '/((?!monitoring|_next/static|_next/image|favicon.ico|api/webhooks).*)',
  ],
};
```

## Manual Error Capture Patterns

### In API Routes

```typescript
import * as Sentry from '@sentry/nextjs';
import { getDb, json, err } from '@/lib/db';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const sql = getDb();
    const result = await sql`...`;
    return json(result);
  } catch (error) {
    Sentry.captureException(error, {
      tags: { route: '/api/checkout', company: process.env.COMPANY_SLUG },
    });
    return err('Internal server error', 500);
  }
}
```

### With User Context

```typescript
// Set user context when authenticated
Sentry.setUser({
  id: session.user.id,
  email: session.user.email,
});

// Clear on logout
Sentry.setUser(null);
```

### Custom Events / Breadcrumbs

```typescript
// Track business events
Sentry.addBreadcrumb({
  message: 'User started checkout',
  category: 'user.action',
  data: { plan: 'pro', priceId },
});

// Manual event capture
Sentry.captureMessage('Payment webhook received', {
  level: 'info',
  tags: { event_type: 'checkout.session.completed' },
  extra: { sessionId: session.id },
});
```

## Sentry Tags for Hive Context

Always set company tags so errors are identifiable in a multi-company Sentry org:

```typescript
// src/lib/sentry-tags.ts
import * as Sentry from '@sentry/nextjs';

export function setSentryTags(extra?: Record<string, string>) {
  Sentry.setTag('company', process.env.COMPANY_SLUG || 'unknown');
  Sentry.setTag('company_id', process.env.COMPANY_ID || 'unknown');
  if (extra) {
    Object.entries(extra).forEach(([key, value]) => Sentry.setTag(key, value));
  }
}
```

Use in API routes:
```typescript
import { setSentryTags } from '@/lib/sentry-tags';

export async function GET(req: Request) {
  setSentryTags({ route: '/api/dashboard', action: 'load' });
  // ...
}
```

## Rules

- Never use Sentry in Edge Runtime for PII — Edge Sentry init has `sendDefaultPii: false`
- Always set company tags so errors can be filtered by company in Sentry dashboard
- Source maps must be uploaded — `SENTRY_AUTH_TOKEN` must be set as Vercel env var
- The tunnel route `/monitoring` bypasses ad blockers — keep it excluded from auth middleware
- `replaysOnErrorSampleRate: 1.0` means 100% of sessions with errors get replayed — adjust down if volume is high
