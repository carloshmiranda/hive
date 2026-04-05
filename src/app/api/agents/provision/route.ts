import { NextRequest } from "next/server";
import { validateOIDC } from "@/lib/oidc";
import { getDb, json, err } from "@/lib/db";
import { createProject as createNeonProject } from "@/lib/neon-api";
import { createProject as createVercelProject, setEnvVars, addDomain, provisionNeonStore, hasEnvVar, getEnvVar } from "@/lib/vercel";
import { getSettingValue } from "@/lib/settings";
import { setSentryTags } from "@/lib/sentry-tags";
import { getFramework, recommendFramework } from "@/lib/frameworks";
import { generateBrand } from "@/lib/brand";

// POST /api/agents/provision — one-call infrastructure provisioning
// Creates Neon DB + runs schema, creates Vercel project + enables Web Analytics,
// sets DATABASE_URL env var on Vercel, records all infra in DB.
// Called by the Engineer agent during new_company provisioning.
export async function POST(req: NextRequest) {
  setSentryTags({
    action_type: "agent_api",
    route: "/api/agents/provision",
  });

  const claims = await validateOIDC(req);
  if (claims instanceof Response) return claims;

  const body = await req.json();
  const { company_slug, company_id, framework: requestedFramework, company_type } = body;

  if (!company_slug || !company_id) {
    return err("Missing company_slug or company_id", 400);
  }

  // Resolve framework: explicit request > recommendation from business type > nextjs default
  const frameworkId = requestedFramework || recommendFramework(company_type) || "nextjs";
  const fw = getFramework(frameworkId);

  // Add company_id tag to Sentry
  setSentryTags({ company_id });

  const sql = getDb();
  const results: Record<string, unknown> = { company_slug, company_id, framework: frameworkId, boilerplate_dir: fw.boilerplateDir };

  // ── Step 1: Create Neon database (3-tier: Vercel Marketplace → Neon API → existing) ──
  let connectionUri: string | null = null;
  let neonProjectId: string | null = null;

  // Helper: run boilerplate schema on a connection URI
  async function applySchema(uri: string): Promise<boolean> {
    try {
      const { neon: neonClient } = await import("@neondatabase/serverless");
      const csql = neonClient(uri);
      await csql`CREATE TABLE IF NOT EXISTS customers (id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, email TEXT UNIQUE NOT NULL, stripe_customer_id TEXT, status TEXT NOT NULL DEFAULT 'active', created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
      await csql`CREATE TABLE IF NOT EXISTS waitlist (id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, email TEXT UNIQUE NOT NULL, name TEXT, referral_code TEXT UNIQUE NOT NULL, referred_by TEXT, referral_count INTEGER NOT NULL DEFAULT 0, position INTEGER, source TEXT DEFAULT 'organic', utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, status TEXT NOT NULL DEFAULT 'waiting', invited_at TIMESTAMPTZ, converted_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
      await csql`CREATE TABLE IF NOT EXISTS page_views (date DATE NOT NULL DEFAULT CURRENT_DATE, path TEXT NOT NULL DEFAULT '/', views INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (date, path))`;
      await csql`CREATE TABLE IF NOT EXISTS pricing_clicks (id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, date DATE NOT NULL DEFAULT CURRENT_DATE, tier TEXT NOT NULL, source_path TEXT NOT NULL DEFAULT '/pricing', created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
      await csql`CREATE TABLE IF NOT EXISTS affiliate_clicks (id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, date DATE NOT NULL DEFAULT CURRENT_DATE, link_id TEXT NOT NULL, destination_url TEXT, source_path TEXT NOT NULL DEFAULT '/', created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
      await csql`CREATE TABLE IF NOT EXISTS email_sequences (id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, sequence TEXT NOT NULL, step INTEGER NOT NULL DEFAULT 1, subject TEXT NOT NULL, body_html TEXT NOT NULL, body_text TEXT, delay_hours INTEGER NOT NULL DEFAULT 0, variant TEXT DEFAULT 'a', is_active BOOLEAN DEFAULT true, send_count INTEGER DEFAULT 0, open_count INTEGER DEFAULT 0, click_count INTEGER DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(sequence, step, variant))`;
      await csql`CREATE TABLE IF NOT EXISTS email_log (id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, recipient TEXT NOT NULL, sequence_id TEXT, subject TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'sent', resend_id TEXT, opened_at TIMESTAMPTZ, clicked_at TIMESTAMPTZ, bounced_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
      return true;
    } catch {
      return false;
    }
  }

  // Tier 1: Try Vercel Marketplace (auto-provisions Neon + injects DATABASE_URL)
  try {
    const store = await provisionNeonStore(company_slug, `${company_slug}-db`);
    if (store) {
      neonProjectId = store.storeId;
      results.neon = { store_id: store.storeId, method: "vercel_marketplace", created: true };

      await sql`
        INSERT INTO infra (company_id, service, resource_id, config)
        VALUES (${company_id}, 'neon', ${store.storeId}, ${JSON.stringify({ method: "vercel_marketplace" })}::jsonb)
        ON CONFLICT DO NOTHING
      `;

      // Marketplace auto-injects DATABASE_URL — wait briefly then fetch it
      // Schema will be applied after Vercel project is created (Step 3)
    }
  } catch (marketplaceErr: any) {
    console.warn(`[provision] Vercel Marketplace Neon failed: ${marketplaceErr.message}`);

    // Tier 2: Fall back to direct Neon API
    try {
      const neon = await createNeonProject(company_slug);
      connectionUri = neon.connectionUri;
      neonProjectId = neon.projectId;
      results.neon = {
        project_id: neon.projectId,
        host: neon.host,
        method: "neon_api",
        created: true,
      };

      await sql`
        INSERT INTO infra (company_id, service, resource_id, config)
        VALUES (${company_id}, 'neon', ${neon.projectId}, ${JSON.stringify({ host: neon.host })}::jsonb)
        ON CONFLICT DO NOTHING
      `;

      // Apply schema immediately since we have the connection URI
      const schemaOk = connectionUri ? await applySchema(connectionUri) : false;
      (results.neon as Record<string, unknown>).schema_applied = schemaOk;
    } catch (neonErr: any) {
      results.neon = { error: neonErr.message, marketplace_error: marketplaceErr.message, created: false };
    }
  }

  // ── Step 2: Create Vercel project + enable Web Analytics ──
  let vercelProjectId: string | null = null;
  try {
    const project = await createVercelProject(company_slug, `carloshmiranda/${company_slug}`, {
      framework: fw.vercelFramework,
      buildCommand: fw.buildCommand,
      outputDirectory: fw.outputDirectory,
    });
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
      const analyticsRes = await fetch(`https://api.vercel.com/v9/projects/${project.id}/web-analytics${teamParam}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${vercelToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
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

  // ── Step 3: Set DATABASE_URL on Vercel project + apply schema ──
  if (vercelProjectId && connectionUri) {
    // Direct Neon API path — we have connectionUri, set it on Vercel
    try {
      await setEnvVars(vercelProjectId, [
        { key: "DATABASE_URL", value: connectionUri },
      ]);
      results.env_vars = { DATABASE_URL: "set" };
    } catch (e: any) {
      results.env_vars = { error: e.message };
    }
  } else if (vercelProjectId && !connectionUri && (results.neon as Record<string, unknown>)?.method === "vercel_marketplace") {
    // Marketplace path — DATABASE_URL was auto-injected, fetch it to apply schema
    try {
      // Wait for Vercel to propagate the env var from the store connection
      await new Promise(resolve => setTimeout(resolve, 3000));
      const dbUrl = await getEnvVar(vercelProjectId, "DATABASE_URL");
      if (dbUrl) {
        connectionUri = dbUrl;

        // Verify pooled connection (should contain '-pooler' in hostname)
        const isPooled = dbUrl.includes('-pooler');
        if (!isPooled) {
          console.warn(`[provision] ${company_slug}: DATABASE_URL may not use pooled connections (missing '-pooler' in hostname)`);
          results.env_vars = { DATABASE_URL: "auto_injected", pooled: false, warning: "non_pooled_connection" };
        } else {
          results.env_vars = { DATABASE_URL: "auto_injected", pooled: true };
        }

        const schemaOk = await applySchema(dbUrl);
        (results.neon as Record<string, unknown>).schema_applied = schemaOk;
      } else {
        results.env_vars = { DATABASE_URL: "pending_marketplace_injection" };
      }
    } catch (e: any) {
      results.env_vars = { error: e.message, note: "marketplace_env_fetch_failed" };
    }
  }

  // ── Step 4: Update company record with Vercel + Neon details ──
  const companyDomain = `${company_slug}.vercel.app`;
  const actualVercelUrl = `https://${companyDomain}`;

  await sql`
    UPDATE companies SET
      vercel_project_id = COALESCE(${vercelProjectId}, vercel_project_id),
      vercel_url = COALESCE(${actualVercelUrl}, vercel_url),
      domain = COALESCE(${companyDomain}, domain),
      neon_project_id = COALESCE(${neonProjectId ?? null}, neon_project_id),
      framework = ${frameworkId},
      updated_at = NOW()
    WHERE id = ${company_id}
  `.catch(() => {});

  // ── Step 5: Generate brand identity ──
  try {
    const brand = await generateBrand(sql, company_id);
    results.brand = brand;
  } catch (e: any) {
    results.brand = { error: e.message };
  }

  return json(results);
}
