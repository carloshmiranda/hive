import { getDb } from "./db";

/**
 * Check if an email address should be suppressed for outreach.
 * Returns true if the email is unsubscribed, bounced, or marked as rejected.
 */
export async function isEmailSuppressed(companyId: string, email: string): Promise<boolean> {
  const sql = getDb();

  try {
    // Get outreach log for this company
    const [outreachLog] = await sql`
      SELECT content
      FROM research_reports
      WHERE company_id = ${companyId} AND report_type = 'outreach_log'
    `;

    if (!outreachLog?.content) {
      return false; // No suppression data yet
    }

    const content = outreachLog.content;
    const normalizedEmail = email.toLowerCase();

    // Check unsubscribes
    if (Array.isArray(content.unsubscribes)) {
      for (const unsub of content.unsubscribes) {
        if (unsub.email && unsub.email.toLowerCase() === normalizedEmail) {
          return true;
        }
      }
    }

    // Check bounces
    if (Array.isArray(content.bounces)) {
      for (const bounce of content.bounces) {
        if (bounce.email && bounce.email.toLowerCase() === normalizedEmail) {
          return true;
        }
      }
    }

    // Check rejected leads
    if (Array.isArray(content.emails_drafted)) {
      for (const email_draft of content.emails_drafted) {
        if (email_draft.to && email_draft.to.toLowerCase() === normalizedEmail) {
          if (email_draft.status === 'rejected' || email_draft.status === 'unsubscribed') {
            return true;
          }
        }
      }
    }

    return false;

  } catch (e: any) {
    console.warn(`[suppression] Error checking suppression for ${email}: ${e.message}`);
    return false; // Fail open - don't suppress on errors
  }
}

/**
 * Get all suppressed emails for a company as a Set for fast lookup.
 */
export async function getSuppressedEmails(companyId: string): Promise<Set<string>> {
  const sql = getDb();
  const suppressedEmails = new Set<string>();

  try {
    const [outreachLog] = await sql`
      SELECT content
      FROM research_reports
      WHERE company_id = ${companyId} AND report_type = 'outreach_log'
    `;

    if (!outreachLog?.content) {
      return suppressedEmails;
    }

    const content = outreachLog.content;

    // Add unsubscribes
    if (Array.isArray(content.unsubscribes)) {
      for (const unsub of content.unsubscribes) {
        if (unsub.email) {
          suppressedEmails.add(unsub.email.toLowerCase());
        }
      }
    }

    // Add bounces
    if (Array.isArray(content.bounces)) {
      for (const bounce of content.bounces) {
        if (bounce.email) {
          suppressedEmails.add(bounce.email.toLowerCase());
        }
      }
    }

    // Add rejected/unsubscribed from emails_drafted
    if (Array.isArray(content.emails_drafted)) {
      for (const email_draft of content.emails_drafted) {
        if (email_draft.to && (email_draft.status === 'rejected' || email_draft.status === 'unsubscribed')) {
          suppressedEmails.add(email_draft.to.toLowerCase());
        }
      }
    }

  } catch (e: any) {
    console.warn(`[suppression] Error getting suppressed emails: ${e.message}`);
  }

  return suppressedEmails;
}

/**
 * Add an email to the suppression list (for manual suppression)
 */
export async function suppressEmail(companyId: string, email: string, reason: string = 'manual'): Promise<boolean> {
  const sql = getDb();

  try {
    const suppressionEntry = {
      email: email.toLowerCase(),
      suppressed_at: new Date().toISOString(),
      reason,
    };

    await sql`
      INSERT INTO research_reports (company_id, report_type, content, summary)
      VALUES (
        ${companyId},
        'outreach_log',
        ${JSON.stringify({ manual_suppressions: [suppressionEntry] })},
        ${`Email suppressed: ${email}`}
      )
      ON CONFLICT (company_id, report_type) DO UPDATE SET
        content = jsonb_set(
          COALESCE(outreach_log.content, '{}'::jsonb),
          '{manual_suppressions}',
          COALESCE(outreach_log.content->'manual_suppressions', '[]'::jsonb) || ${JSON.stringify([suppressionEntry])}::jsonb
        ),
        updated_at = now()
    `;

    return true;
  } catch (e: any) {
    console.error(`[suppression] Error suppressing email ${email}: ${e.message}`);
    return false;
  }
}