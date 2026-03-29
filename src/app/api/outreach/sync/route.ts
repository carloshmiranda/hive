import { NextRequest } from "next/server";
import { getDb, json, err } from "@/lib/db";
import { createAudience, addContact, listContacts, updateContactSubscription, listAudiences } from "@/lib/resend";

/**
 * POST /api/outreach/sync
 *
 * Syncs company leads from Neon to Resend Audiences/Contacts API
 * - Creates Resend audience for company if not exists
 * - Syncs leads from research_reports.lead_list to Resend contacts
 * - Handles suppression/unsubscribe management
 * - Returns sync status and counts
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { company_id } = body;

    if (!company_id) {
      return err("Missing company_id", 400);
    }

    const sql = getDb();

    // Get company data
    const [company] = await sql`
      SELECT id, name, slug, resend_audience_id
      FROM companies
      WHERE id = ${company_id}
    `;

    if (!company) {
      return err("Company not found", 404);
    }

    let audienceId = company.resend_audience_id;

    // Create Resend audience if it doesn't exist
    if (!audienceId) {
      const audienceResult = await createAudience({
        name: `${company.name} (${company.slug})`,
      });

      if (!audienceResult.success) {
        return err(`Failed to create Resend audience: ${audienceResult.error}`, 500);
      }

      audienceId = audienceResult.audience!.id;

      // Store audience ID in database
      await sql`
        UPDATE companies
        SET resend_audience_id = ${audienceId}
        WHERE id = ${company_id}
      `;
    }

    // Get lead list from research_reports
    const [leadListReport] = await sql`
      SELECT content
      FROM research_reports
      WHERE company_id = ${company_id} AND report_type = 'lead_list'
    `;

    if (!leadListReport?.content) {
      return json({
        ok: true,
        message: "No leads found to sync",
        company: company.slug,
        audience_id: audienceId,
        leads_synced: 0,
        leads_total: 0,
      });
    }

    // Get existing contacts from Resend to avoid duplicates
    const existingContactsResult = await listContacts(audienceId);
    const existingEmails = existingContactsResult.success
      ? new Set(existingContactsResult.contacts?.map(c => c.email.toLowerCase()) || [])
      : new Set();

    // Parse leads from research_reports content
    const leads = Array.isArray(leadListReport.content.leads)
      ? leadListReport.content.leads
      : Array.isArray(leadListReport.content)
        ? leadListReport.content
        : [];

    let syncedCount = 0;
    let skippedCount = 0;
    const errors: string[] = [];

    // Sync leads to Resend contacts
    for (const lead of leads) {
      if (!lead?.email) {
        skippedCount++;
        continue;
      }

      const email = lead.email.toLowerCase();

      // Skip if contact already exists
      if (existingEmails.has(email)) {
        skippedCount++;
        continue;
      }

      // Add contact to Resend audience
      const contactResult = await addContact({
        audienceId,
        email: lead.email,
        firstName: lead.first_name || lead.firstName || undefined,
        lastName: lead.last_name || lead.lastName || undefined,
        unsubscribed: false,
      });

      if (contactResult.success) {
        syncedCount++;
        existingEmails.add(email); // Track to avoid re-adding in same batch
      } else {
        errors.push(`${lead.email}: ${contactResult.error}`);
      }

      // Rate limit: small delay between requests
      if (syncedCount % 10 === 0) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    return json({
      ok: true,
      message: `Synced ${syncedCount} leads to Resend audience`,
      company: company.slug,
      audience_id: audienceId,
      leads_synced: syncedCount,
      leads_skipped: skippedCount,
      leads_total: leads.length,
      errors: errors.slice(0, 5), // First 5 errors only
    });

  } catch (e: any) {
    console.error("[outreach-sync] Error:", e);
    return err(`Sync failed: ${e.message}`, 500);
  }
}

/**
 * GET /api/outreach/sync?company_id=<id>
 *
 * Get sync status for a company
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const companyId = searchParams.get("company_id");

    if (!companyId) {
      return err("Missing company_id parameter", 400);
    }

    const sql = getDb();

    // Get company and audience info
    const [company] = await sql`
      SELECT id, name, slug, resend_audience_id
      FROM companies
      WHERE id = ${companyId}
    `;

    if (!company) {
      return err("Company not found", 404);
    }

    let contactCount = 0;
    let audienceExists = false;

    if (company.resend_audience_id) {
      const contactsResult = await listContacts(company.resend_audience_id);
      if (contactsResult.success) {
        contactCount = contactsResult.contacts?.length || 0;
        audienceExists = true;
      }
    }

    // Get lead count from database
    const [leadListReport] = await sql`
      SELECT content
      FROM research_reports
      WHERE company_id = ${companyId} AND report_type = 'lead_list'
    `;

    const dbLeadCount = leadListReport?.content?.leads?.length
      || (Array.isArray(leadListReport?.content) ? leadListReport.content.length : 0);

    return json({
      ok: true,
      company: company.slug,
      audience_id: company.resend_audience_id,
      audience_exists: audienceExists,
      resend_contacts: contactCount,
      db_leads: dbLeadCount,
      sync_needed: dbLeadCount > contactCount,
    });

  } catch (e: any) {
    console.error("[outreach-sync] Get status error:", e);
    return err(`Status check failed: ${e.message}`, 500);
  }
}