---
name: stripe-integration
description: Invoke when adding Stripe payments, subscriptions, webhooks, Checkout Sessions, Customer Portal, or pricing to a Hive portfolio company. Also use when the user mentions "add Stripe," "set up payments," "subscription billing," "checkout," "stripe webhook," "customer portal," "pricing page," or "monetize this company." Hive-specific: single Stripe account with company metadata tags.
metadata:
  version: 1.0.0
---

# Stripe Integration for Hive Companies

Hive uses a **single Stripe account** for all portfolio companies. Revenue is separated by product metadata, NOT by Connect accounts. This is ADR-002 — do not propose Stripe Connect.

## Architecture Rules

- All Stripe products tagged with `metadata: { company_id, company_slug }`
- Webhooks go to `/api/webhooks/stripe` — already provisioned in each company
- Customer records stored in `customers` table (already in company schema)
- Pricing clicks tracked in `pricing_clicks` table (already in company schema)

## Setup Checklist

### 1. Environment Variables (already set by Hive provisioner)
```
STRIPE_SECRET_KEY=sk_...
STRIPE_PUBLISHABLE_KEY=pk_...
STRIPE_WEBHOOK_SECRET=whsec_...
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_...
```

### 2. Install Stripe SDK
```bash
npm install stripe @stripe/stripe-js
```

### 3. Initialize Stripe Server-Side
```typescript
// src/lib/stripe.ts
import Stripe from 'stripe';

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2024-12-18.acacia',
});
```

### 4. Create Products with Company Metadata
```typescript
const product = await stripe.products.create({
  name: 'Pro Plan',
  metadata: {
    company_id: process.env.COMPANY_ID!,
    company_slug: process.env.COMPANY_SLUG!,
  },
});

const price = await stripe.prices.create({
  product: product.id,
  unit_amount: 2900, // €29.00
  currency: 'eur',
  recurring: { interval: 'month' },
});
```

## Checkout Session (Recommended Pattern)

```typescript
// src/app/api/checkout/route.ts
import { stripe } from '@/lib/stripe';
import { getDb } from '@/lib/db';

export async function POST(req: Request) {
  const { priceId, email } = await req.json();
  const sql = getDb();

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [{ price: priceId, quantity: 1 }],
    customer_email: email,
    success_url: `${process.env.NEXT_PUBLIC_APP_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/pricing`,
    metadata: {
      company_id: process.env.COMPANY_ID!,
      company_slug: process.env.COMPANY_SLUG!,
    },
  });

  // Track pricing click
  await sql`
    INSERT INTO pricing_clicks (tier, source_path)
    VALUES ('pro', '/pricing')
  `;

  return Response.json({ url: session.url });
}
```

## Webhook Handler

```typescript
// src/app/api/webhooks/stripe/route.ts
import { stripe } from '@/lib/stripe';
import { getDb } from '@/lib/db';
import { headers } from 'next/headers';

export async function POST(req: Request) {
  const body = await req.text();
  const sig = (await headers()).get('stripe-signature')!;

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch {
    return new Response('Webhook signature failed', { status: 400 });
  }

  const sql = getDb();

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.CheckoutSession;
      const email = session.customer_email!;
      await sql`
        INSERT INTO customers (email, stripe_customer_id, status)
        VALUES (${email}, ${session.customer as string}, 'active')
        ON CONFLICT (email) DO UPDATE SET
          stripe_customer_id = EXCLUDED.stripe_customer_id,
          status = 'active'
      `;
      break;
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const customer = await stripe.customers.retrieve(sub.customer as string) as Stripe.Customer;
      await sql`
        UPDATE customers SET status = 'churned'
        WHERE email = ${customer.email}
      `;
      break;
    }
  }

  return new Response('ok');
}
```

## Customer Portal

```typescript
// src/app/api/portal/route.ts
import { stripe } from '@/lib/stripe';
import { getDb } from '@/lib/db';
import { requireAuth } from '@/lib/auth';

export async function POST(req: Request) {
  const session = await requireAuth();
  if (!session) return new Response('Unauthorized', { status: 401 });

  const sql = getDb();
  const [customer] = await sql`
    SELECT stripe_customer_id FROM customers WHERE email = ${session.user.email}
  `;
  if (!customer?.stripe_customer_id) {
    return Response.json({ error: 'No subscription found' }, { status: 404 });
  }

  const portalSession = await stripe.billingPortal.sessions.create({
    customer: customer.stripe_customer_id,
    return_url: `${process.env.NEXT_PUBLIC_APP_URL}/account`,
  });

  return Response.json({ url: portalSession.url });
}
```

## Pricing Page Pattern

```typescript
// Load prices server-side (Next.js App Router)
const prices = await stripe.prices.list({
  active: true,
  expand: ['data.product'],
});
```

## Revenue Readiness Checklist

Before adding payment:
- [ ] Pricing page exists with clear CTAs
- [ ] `pricing_clicks` tracking on "Get started" buttons
- [ ] Stripe webhook endpoint deployed and verified
- [ ] Success/cancel pages exist
- [ ] Customer portal linked from account page
- [ ] Stripe test mode used in development

## Testing

Use Stripe test cards:
- Success: `4242 4242 4242 4242`
- Decline: `4000 0000 0000 9995`
- 3D Secure: `4000 0027 6000 3184`

Use `stripe listen --forward-to localhost:3000/api/webhooks/stripe` for local webhook testing.
