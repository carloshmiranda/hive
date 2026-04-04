---
name: resend-email
description: Invoke when adding email sending, transactional emails, email sequences, welcome emails, or Resend to a Hive portfolio company. Also use when the user mentions "send email," "transactional email," "welcome email," "onboarding email," "Resend SDK," "email template," "from address," or "email sequences." Hive uses a single Resend account with per-company from addresses.
metadata:
  version: 1.0.0
---

# Resend Email for Hive Companies

Hive uses a **single Resend account** shared across all portfolio companies. Each company sends from `noreply@{company-domain}` or `hello@{company-domain}`. The `email_sequences` and `email_log` tables are already in the company schema.

## Architecture Rules

- Single Resend API key in Hive settings (`resend_api_key`)
- Per-company from addresses: `noreply@{slug}.vercel.app` until custom domain
- All sends logged to `email_log` table
- Sequence emails stored in `email_sequences` table (Growth agent writes these)
- Max 100 emails/day on Resend free tier — respect this

## Environment Variables

```
RESEND_API_KEY=re_...
EMAIL_FROM=noreply@company.vercel.app
```

## Setup

```bash
npm install resend
```

```typescript
// src/lib/email.ts
import { Resend } from 'resend';

export const resend = new Resend(process.env.RESEND_API_KEY!);

export const EMAIL_FROM = process.env.EMAIL_FROM ?? 'noreply@hive-phi.vercel.app';

export async function sendEmail({
  to,
  subject,
  html,
  text,
  sequenceId,
}: {
  to: string;
  subject: string;
  html: string;
  text?: string;
  sequenceId?: string;
}) {
  const { data, error } = await resend.emails.send({
    from: EMAIL_FROM,
    to,
    subject,
    html,
    text,
  });

  if (error) {
    console.error('[email] send failed:', error);
    throw error;
  }

  return data;
}
```

## Waitlist Welcome Email

```typescript
// src/app/api/waitlist/route.ts
import { getDb } from '@/lib/db';
import { sendEmail } from '@/lib/email';

export async function POST(req: Request) {
  const { email, name } = await req.json();
  const sql = getDb();

  // Generate referral code
  const referralCode = Math.random().toString(36).substring(2, 8).toUpperCase();

  const [entry] = await sql`
    INSERT INTO waitlist (email, name, referral_code)
    VALUES (${email}, ${name || null}, ${referralCode})
    ON CONFLICT (email) DO NOTHING
    RETURNING *
  `;

  if (entry) {
    // Send welcome email
    await sendEmail({
      to: email,
      subject: 'You\'re on the list! 🎉',
      html: `
        <h1>You're on the waitlist!</h1>
        <p>Hi ${name || 'there'},</p>
        <p>You're #${entry.position || 'early'} on the list.</p>
        <p>Your referral code: <strong>${referralCode}</strong></p>
        <p>Share it to move up the list.</p>
      `,
    });
  }

  return Response.json({ ok: true });
}
```

## Transactional Email Patterns

### Password Reset
```typescript
await sendEmail({
  to: user.email,
  subject: 'Reset your password',
  html: `<a href="${resetUrl}">Reset password</a>`,
});
```

### Payment Receipt
```typescript
await sendEmail({
  to: customer.email,
  subject: 'Payment confirmed',
  html: `<p>Your payment of €${amount / 100} has been processed.</p>`,
});
```

## Email Sequence Sending

The Growth agent writes sequences to `email_sequences` table. The app sends them based on `delay_hours` from trigger event.

```typescript
// src/lib/email-sequences.ts
import { getDb } from '@/lib/db';
import { sendEmail } from '@/lib/email';

export async function sendSequenceEmail(
  sequenceName: string,
  step: number,
  recipientEmail: string
) {
  const sql = getDb();
  const [seq] = await sql`
    SELECT * FROM email_sequences
    WHERE sequence = ${sequenceName}
      AND step = ${step}
      AND is_active = true
    ORDER BY variant LIMIT 1
  `;

  if (!seq) return;

  await sendEmail({
    to: recipientEmail,
    subject: seq.subject,
    html: seq.body_html,
    text: seq.body_text,
  });

  // Update send count
  await sql`
    UPDATE email_sequences
    SET send_count = send_count + 1
    WHERE id = ${seq.id}
  `;

  // Log the send
  await sql`
    INSERT INTO email_log (recipient, sequence_id, subject, status)
    VALUES (${recipientEmail}, ${seq.id}, ${seq.subject}, 'sent')
  `;
}
```

## Resend Webhook (Track Opens/Clicks)

```typescript
// src/app/api/webhooks/resend/route.ts
import { getDb } from '@/lib/db';

export async function POST(req: Request) {
  const event = await req.json();
  const sql = getDb();

  const { type, data } = event;
  const resendId = data?.email_id;

  if (!resendId) return new Response('ok');

  switch (type) {
    case 'email.opened':
      await sql`
        UPDATE email_log SET opened_at = now()
        WHERE resend_id = ${resendId}
      `;
      break;
    case 'email.clicked':
      await sql`
        UPDATE email_log SET clicked_at = now()
        WHERE resend_id = ${resendId}
      `;
      break;
    case 'email.bounced':
      await sql`
        UPDATE email_log SET bounced_at = now(), status = 'bounced'
        WHERE resend_id = ${resendId}
      `;
      break;
  }

  return new Response('ok');
}
```

## Custom Domain Setup

Once the company has a real domain:
1. Add domain in Resend dashboard
2. Add DNS records (SPF, DKIM, DMARC)
3. Update `EMAIL_FROM` env var in Vercel

## Rules

- Only send to opted-in users (waitlist, customers, explicit subscribers)
- Every marketing email needs an unsubscribe link (Resend adds this automatically)
- Max 1 marketing email/week per user
- Transactional only (receipts, password resets, verification) can exceed this
