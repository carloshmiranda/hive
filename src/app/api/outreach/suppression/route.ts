import { NextRequest } from "next/server";
import { getDb, json, err } from "@/lib/db";
import { getSuppressedEmails, suppressEmail } from "@/lib/outreach-suppression";
import { updateContactSubscription, listContacts } from "@/lib/resend";

/**
 * GET /api/outreach/suppression?company_id=<id>
 *
 * Get suppression list for a company
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const companyId = searchParams.get("company_id");

    if (!companyId) {
      return err("Missing company_id parameter", 400);
    }

    const suppressedEmails = await getSuppressedEmails(companyId);

    return json({
      ok: true,
      company_id: companyId,
      suppressed_emails: Array.from(suppressedEmails),
      count: suppressedEmails.size,
    });

  } catch (e: any) {
    console.error("[suppression] GET error:", e);
    return err(`Failed to get suppression list: ${e.message}`, 500);
  }
}

/**
 * POST /api/outreach/suppression
 *
 * Add email to suppression list
 * Body: { company_id, email, reason? }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { company_id, email, reason = "manual" } = body;

    if (!company_id || !email) {
      return err("Missing company_id or email", 400);
    }

    // Add to local suppression list
    const suppressed = await suppressEmail(company_id, email, reason);

    if (!suppressed) {
      return err("Failed to suppress email", 500);
    }

    // Also mark as unsubscribed in Resend if audience exists
    try {
      const sql = getDb();
      const [company] = await sql`
        SELECT resend_audience_id
        FROM companies
        WHERE id = ${company_id}
      `;

      if (company?.resend_audience_id) {
        const contactsResult = await listContacts(company.resend_audience_id);
        if (contactsResult.success) {
          const contact = contactsResult.contacts?.find(c =>
            c.email.toLowerCase() === email.toLowerCase()
          );

          if (contact && !contact.unsubscribed) {
            await updateContactSubscription(
              company.resend_audience_id,
              contact.id,
              true
            );
            console.log(`[suppression] Marked ${email} as unsubscribed in Resend`);
          }
        }
      }
    } catch (resendError: any) {
      console.warn(`[suppression] Resend sync failed for ${email}: ${resendError.message}`);
      // Don't fail the request - local suppression still worked
    }

    return json({
      ok: true,
      message: `Email ${email} added to suppression list`,
      email: email.toLowerCase(),
      reason,
    });

  } catch (e: any) {
    console.error("[suppression] POST error:", e);
    return err(`Failed to suppress email: ${e.message}`, 500);
  }
}

/**
 * DELETE /api/outreach/suppression
 *
 * Remove email from suppression list (unsuppress)
 * Body: { company_id, email }
 */
export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json();
    const { company_id, email } = body;

    if (!company_id || !email) {
      return err("Missing company_id or email", 400);
    }

    const sql = getDb();

    // Remove from suppression by updating the outreach_log to mark as removed
    const removalEntry = {
      email: email.toLowerCase(),
      removed_at: new Date().toISOString(),
      reason: "manual_removal",
    };

    await sql`
      INSERT INTO research_reports (company_id, report_type, content, summary)
      VALUES (
        ${company_id},
        'outreach_log',
        ${JSON.stringify({ suppressions_removed: [removalEntry] })},
        ${`Email unsuppressed: ${email}`}
      )
      ON CONFLICT (company_id, report_type) DO UPDATE SET
        content = jsonb_set(
          COALESCE(outreach_log.content, '{}'::jsonb),
          '{suppressions_removed}',
          COALESCE(outreach_log.content->'suppressions_removed', '[]'::jsonb) || ${JSON.stringify([removalEntry])}::jsonb
        ),
        updated_at = now()
    `;

    // Also re-subscribe in Resend if audience exists
    try {
      const [company] = await sql`
        SELECT resend_audience_id
        FROM companies
        WHERE id = ${company_id}
      `;

      if (company?.resend_audience_id) {
        const contactsResult = await listContacts(company.resend_audience_id);
        if (contactsResult.success) {
          const contact = contactsResult.contacts?.find(c =>
            c.email.toLowerCase() === email.toLowerCase()
          );

          if (contact && contact.unsubscribed) {
            await updateContactSubscription(
              company.resend_audience_id,
              contact.id,
              false
            );
            console.log(`[suppression] Re-subscribed ${email} in Resend`);
          }
        }
      }
    } catch (resendError: any) {
      console.warn(`[suppression] Resend re-subscribe failed for ${email}: ${resendError.message}`);
    }

    return json({
      ok: true,
      message: `Email ${email} removed from suppression list`,
      email: email.toLowerCase(),
    });

  } catch (e: any) {
    console.error("[suppression] DELETE error:", e);
    return err(`Failed to unsuppress email: ${e.message}`, 500);
  }
}