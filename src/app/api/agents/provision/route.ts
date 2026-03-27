import { NextRequest } from "next/server";
import { validateOIDC } from "@/lib/oidc";
import { getDb, json, err } from "@/lib/db";
import { createProject as createNeonProject } from "@/lib/neon-api";
import { createProject as createVercelProject, setEnvVars, addDomain } from "@/lib/vercel";
import { getSettingValue } from "@/lib/settings";

// POST /api/agents/provision — one-call infrastructure provisioning
// Creates Neon DB + runs schema, creates Vercel project + enables Web Analytics,
// sets DATABASE_URL env var on Vercel, records all infra in DB.
// Called by the Engineer agent during new_company provisioning.
export async function POST(req: NextRequest) {
  const claims = await validateOIDC(req);
  if (claims instanceof Response) return claims;

  const body = await req.json();
  const { company_slug, company_id } = body;

  if (!company_slug || !company_id) {
    return err("Missing company_slug or company_id", 400);
  }

  const sql = getDb();
  const results: Record<string, unknown> = { company_slug, company_id };

  // ── Step 1: Create Neon database ──
  let connectionUri: string | null = null;
  try {
    const neon = await createNeonProject(company_slug);
    connectionUri = neon.connectionUri;
    results.neon = {
      project_id: neon.projectId,
      host: neon.host,
      created: true,
    };

    await sql`
      INSERT INTO infra (company_id, service, resource_id, config)
      VALUES (${company_id}, 'neon', ${neon.projectId}, ${JSON.stringify({ host: neon.host })}::jsonb)
      ON CONFLICT DO NOTHING
    `;

    // Run boilerplate schema
    if (connectionUri) {
      try {
        const { neon: neonClient } = await import("@neondatabase/serverless");
        const csql = neonClient(connectionUri);
        await csql`CREATE TABLE IF NOT EXISTS customers (id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, email TEXT UNIQUE NOT NULL, stripe_customer_id TEXT, status TEXT NOT NULL DEFAULT 'active', created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
        await csql`CREATE TABLE IF NOT EXISTS waitlist (id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, email TEXT UNIQUE NOT NULL, name TEXT, referral_code TEXT UNIQUE NOT NULL, referred_by TEXT, referral_count INTEGER NOT NULL DEFAULT 0, position INTEGER, source TEXT DEFAULT 'organic', utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, status TEXT NOT NULL DEFAULT 'waiting', invited_at TIMESTAMPTZ, converted_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
        await csql`CREATE TABLE IF NOT EXISTS page_views (date DATE NOT NULL DEFAULT CURRENT_DATE, path TEXT NOT NULL DEFAULT '/', views INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (date, path))`;
        await csql`CREATE TABLE IF NOT EXISTS pricing_clicks (id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, date DATE NOT NULL DEFAULT CURRENT_DATE, tier TEXT NOT NULL, source_path TEXT NOT NULL DEFAULT '/pricing', created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
        await csql`CREATE TABLE IF NOT EXISTS affiliate_clicks (id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, date DATE NOT NULL DEFAULT CURRENT_DATE, link_id TEXT NOT NULL, destination_url TEXT, source_path TEXT NOT NULL DEFAULT '/', created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
        await csql`CREATE TABLE IF NOT EXISTS email_sequences (id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, sequence TEXT NOT NULL, step INTEGER NOT NULL DEFAULT 1, subject TEXT NOT NULL, body_html TEXT NOT NULL, body_text TEXT, delay_hours INTEGER NOT NULL DEFAULT 0, variant TEXT DEFAULT 'a', is_active BOOLEAN DEFAULT true, send_count INTEGER DEFAULT 0, open_count INTEGER DEFAULT 0, click_count INTEGER DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(sequence, step, variant))`;
        await csql`CREATE TABLE IF NOT EXISTS email_log (id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, recipient TEXT NOT NULL, sequence_id TEXT, subject TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'sent', resend_id TEXT, opened_at TIMESTAMPTZ, clicked_at TIMESTAMPTZ, bounced_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
        (results.neon as Record<string, unknown>).schema_applied = true;
      } catch (e: any) {
        (results.neon as Record<string, unknown>).schema_error = e.message;
      }
    }
  } catch (e: any) {
    results.neon = { error: e.message, created: false };
  }

  // ── Step 2: Create Vercel project + enable Web Analytics ──
  let vercelProjectId: string | null = null;
  try {
    const project = await createVercelProject(company_slug, `carloshmiranda/${company_slug}`);
    vercelProjectId = project.id;
    results.vercel = { project_id: project.id, created: true };

    await sql`
      INSERT INTO infra (company_id, service, resource_id, config)
      VALUES (${company_id}, 'vercel', ${project.id}, ${JSON.stringify({ name: project.name })}::jsonb)
      ON CONFLICT DO NOTHING
    `;

    // Enable Web Analytics
    try {
      // Batch settings fetches to reduce Redis calls from 2 to 1 HTTP request
      const [vercelToken, teamId] = await Promise.all([
        getSettingValue("vercel_token"),
        getSettingValue("vercel_team_id")
      ]);
      const teamParam = teamId ? `?teamId=${teamId}` : "";
      const analyticsRes = await fetch(`https://api.vercel.com/v1/web-analytics/projects${teamParam}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${vercelToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id }),
      });
      (results.vercel as Record<string, unknown>).web_analytics = analyticsRes.ok;
    } catch {
      (results.vercel as Record<string, unknown>).web_analytics = false;
    }

    // Add {slug}.vercel.app as explicit domain alias (team accounts get random suffixes otherwise)
    try {
      await addDomain(vercelProjectId!, `${company_slug}.vercel.app`);
      (results.vercel as Record<string, unknown>).domain_alias = `${company_slug}.vercel.app`;
    } catch {
      (results.vercel as Record<string, unknown>).domain_alias_error = `Failed to add ${company_slug}.vercel.app alias`;
    }
  } catch (e: any) {
    // Project may already exist — try to get it
    if (e.message.includes("409") || e.message.includes("already")) {
      try {
        const { getProject } = await import("@/lib/vercel");
        const existing = await getProject(company_slug);
        vercelProjectId = existing.id;
        results.vercel = { project_id: existing.id, created: false, already_exists: true };
      } catch {
        results.vercel = { error: e.message, created: false };
      }
    } else {
      results.vercel = { error: e.message, created: false };
    }
  }

  // ── Step 3: Set DATABASE_URL on Vercel project ──
  if (vercelProjectId && connectionUri) {
    try {
      await setEnvVars(vercelProjectId, [
        { key: "DATABASE_URL", value: connectionUri },
      ]);
      results.env_vars = { DATABASE_URL: "set" };
    } catch (e: any) {
      results.env_vars = { error: e.message };
    }
  }

  // ── Step 4: Update company record with Vercel + Neon details ──
  // We always add {slug}.vercel.app as an alias (Step 2), so use that as the canonical URL.
  // Also record neon_project_id directly on the companies table for easy access.
  const neonProjectId = (results.neon as Record<string, unknown>)?.project_id as string | undefined;
  const companyDomain = `${company_slug}.vercel.app`;
  const actualVercelUrl = `https://${companyDomain}`;

  await sql`
    UPDATE companies SET
      vercel_project_id = COALESCE(${vercelProjectId}, vercel_project_id),
      vercel_url = COALESCE(${actualVercelUrl}, vercel_url),
      domain = COALESCE(${companyDomain}, domain),
      neon_project_id = COALESCE(${neonProjectId ?? null}, neon_project_id),
      updated_at = NOW()
    WHERE id = ${company_id}
  `.catch(() => {});

  return json(results);
}
