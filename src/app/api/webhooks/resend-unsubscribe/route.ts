import { NextRequest } from "next/server";
import { getDb, json, err } from "@/lib/db";
import { updateContactSubscription } from "@/lib/resend";

/**
 * POST /api/webhooks/resend-unsubscribe
 *
 * Handles Resend webhook events for unsubscribes and email bounces.
 * Updates contact suppression status in Resend and logs in research_reports.
 *
 * Webhook events we handle:
 * - email.delivered
 * - email.bounced
 * - contact.created
 * - contact.updated (unsubscribed)
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { type, data } = body;

    console.log(`[resend-webhook] Received: ${type}`, data);

    const sql = getDb();

    // Handle contact unsubscribe events
    if (type === "contact.updated" && data.unsubscribed) {
      await handleUnsubscribe(sql, data);
    }

    // Handle bounced emails (mark as suppressed)
    if (type === "email.bounced") {
      await handleBounce(sql, data);
    }

    // Log all webhook events for debugging
    await sql`
      INSERT INTO research_reports (company_id, report_type, content, summary)
      VALUES (
        (SELECT id FROM companies WHERE resend_audience_id = ${data.audience_id || null} LIMIT 1),
        'outreach_log',
        ${JSON.stringify({ webhook_event: type, data, timestamp: new Date().toISOString() })},
        ${`Resend webhook: ${type}`}
      )
      ON CONFLICT (company_id, report_type) DO UPDATE SET
        content = jsonb_set(
          COALESCE(research_reports.content, '{}'::jsonb),
          '{webhook_events}',
          COALESCE(research_reports.content->'webhook_events', '[]'::jsonb) || ${JSON.stringify([{ type, data, timestamp: new Date().toISOString() }])}::jsonb
        ),
        updated_at = now()
    `;

    return json({ ok: true, processed: true });

  } catch (e: any) {
    console.error("[resend-webhook] Error:", e);
    return json({ ok: true, error: e.message }); // Return 200 to avoid webhook retries
  }
}

async function handleUnsubscribe(sql: any, contactData: any) {
  try {
    // Find company by audience_id
    const [company] = await sql`
      SELECT id, name, slug
      FROM companies
      WHERE resend_audience_id = ${contactData.audience_id}
    `;

    if (!company) {
      console.warn(`[resend-webhook] No company found for audience ${contactData.audience_id}`);
      return;
    }

    // Log unsubscribe in outreach log
    await sql`
      INSERT INTO research_reports (company_id, report_type, content, summary)
      VALUES (
        ${company.id},
        'outreach_log',
        ${JSON.stringify({
          unsubscribes: [{
            email: contactData.email,
            contact_id: contactData.id,
            audience_id: contactData.audience_id,
            unsubscribed_at: new Date().toISOString(),
            reason: "webhook_unsubscribe"
          }]
        })},
        ${`Contact unsubscribed: ${contactData.email}`}
      )
      ON CONFLICT (company_id, report_type) DO UPDATE SET
        content = jsonb_set(
          COALESCE(research_reports.content, '{}'::jsonb),
          '{unsubscribes}',
          COALESCE(research_reports.content->'unsubscribes', '[]'::jsonb) || ${JSON.stringify([{
            email: contactData.email,
            contact_id: contactData.id,
            audience_id: contactData.audience_id,
            unsubscribed_at: new Date().toISOString(),
            reason: "webhook_unsubscribe"
          }])}::jsonb
        ),
        updated_at = now()
    `;

    console.log(`[resend-webhook] Logged unsubscribe for ${contactData.email} (company: ${company.slug})`);

  } catch (e: any) {
    console.error(`[resend-webhook] handleUnsubscribe error:`, e);
  }
}

async function handleBounce(sql: any, bounceData: any) {
  try {
    // Extract email from bounce data
    const email = bounceData.to?.[0] || bounceData.email;
    if (!email) return;

    // Find company by matching sent emails in outreach_log
    const [matchingCompany] = await sql`
      SELECT id, name, slug, resend_audience_id
      FROM companies c
      JOIN research_reports rr ON c.id = rr.company_id
      WHERE rr.report_type = 'outreach_log'
      AND rr.content::text ILIKE ${'%' + email + '%'}
      LIMIT 1
    `;

    if (matchingCompany?.resend_audience_id) {
      // Find the contact in Resend and mark as unsubscribed
      const { listContacts } = await import("@/lib/resend");
      const contactsResult = await listContacts(matchingCompany.resend_audience_id);

      if (contactsResult.success) {
        const contact = contactsResult.contacts?.find(c =>
          c.email.toLowerCase() === email.toLowerCase()
        );

        if (contact && !contact.unsubscribed) {
          // Mark as unsubscribed in Resend
          await updateContactSubscription(
            matchingCompany.resend_audience_id,
            contact.id,
            true
          );

          // Log bounce in outreach log
          await sql`
            INSERT INTO research_reports (company_id, report_type, content, summary)
            VALUES (
              ${matchingCompany.id},
              'outreach_log',
              ${JSON.stringify({
                bounces: [{
                  email,
                  contact_id: contact.id,
                  bounce_type: bounceData.type,
                  bounced_at: new Date().toISOString(),
                  reason: "email_bounce"
                }]
              })},
              ${`Email bounced: ${email}`}
            )
            ON CONFLICT (company_id, report_type) DO UPDATE SET
              content = jsonb_set(
                COALESCE(research_reports.content, '{}'::jsonb),
                '{bounces}',
                COALESCE(research_reports.content->'bounces', '[]'::jsonb) || ${JSON.stringify([{
                  email,
                  contact_id: contact.id,
                  bounce_type: bounceData.type,
                  bounced_at: new Date().toISOString(),
                  reason: "email_bounce"
                }])}::jsonb
              ),
              updated_at = now()
          `;

          console.log(`[resend-webhook] Suppressed bounced contact: ${email} (company: ${matchingCompany.slug})`);
        }
      }
    }

  } catch (e: any) {
    console.error(`[resend-webhook] handleBounce error:`, e);
  }
}