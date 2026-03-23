import { NextRequest } from "next/server";
import { getDb, json, err } from "@/lib/db";
import { createProject as createNeonProject } from "@/lib/neon-api";
import { setEnvVars, getProject, getLatestDeployment, listProjectsForRepo, removeGitLink, redeployProduction } from "@/lib/vercel";
import { getSettingValue } from "@/lib/settings";

/**
 * POST /api/agents/repair-infra — fix missing infrastructure for existing companies.
 *
 * Repairs: missing Neon DB, missing env vars, broken Vercel deploys,
 * duplicate Vercel projects, stale escalations.
 * Callable by Sentinel via CRON_SECRET auth.
 */
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return err("Unauthorized", 401);
  }

  try {
  const body = await req.json();
  const { company_slug } = body;
  if (!company_slug) return err("company_slug required", 400);

  const sql = getDb();
  const [company] = await sql`
    SELECT id, slug, neon_project_id, vercel_project_id, vercel_url, github_repo
    FROM companies WHERE slug = ${company_slug} AND status IN ('mvp', 'active', 'approved', 'provisioning')
  `;
  if (!company) return err(`Company ${company_slug} not found or not active`, 404);

  const repairs: Record<string, unknown> = { company_slug };

  // ── Repair 1: Missing Neon database ──
  if (!company.neon_project_id) {
    try {
      const neon = await createNeonProject(company_slug);
      repairs.neon = { project_id: neon.projectId, created: true };

      // Record infra
      await sql`
        INSERT INTO infra (company_id, service, resource_id, config, status)
        VALUES (${company.id}, 'neon', ${neon.projectId}, ${JSON.stringify({ host: neon.host, connection_string: neon.connectionUri })}::jsonb, 'active')
        ON CONFLICT DO NOTHING
      `;

      // Update company record
      await sql`
        UPDATE companies SET neon_project_id = ${neon.projectId}, updated_at = NOW()
        WHERE id = ${company.id}
      `;

      // Run boilerplate schema on the new DB
      if (neon.connectionUri) {
        try {
          const { neon: neonClient } = await import("@neondatabase/serverless");
          const csql = neonClient(neon.connectionUri);
          await csql`CREATE TABLE IF NOT EXISTS customers (id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, email TEXT UNIQUE NOT NULL, stripe_customer_id TEXT, status TEXT NOT NULL DEFAULT 'active', created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
          await csql`CREATE TABLE IF NOT EXISTS waitlist (id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, email TEXT UNIQUE NOT NULL, name TEXT, referral_code TEXT UNIQUE NOT NULL, referred_by TEXT, referral_count INTEGER NOT NULL DEFAULT 0, position INTEGER, source TEXT DEFAULT 'organic', utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, status TEXT NOT NULL DEFAULT 'waiting', invited_at TIMESTAMPTZ, converted_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
          await csql`CREATE TABLE IF NOT EXISTS page_views (date DATE NOT NULL DEFAULT CURRENT_DATE, path TEXT NOT NULL DEFAULT '/', views INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (date, path))`;
          await csql`CREATE TABLE IF NOT EXISTS pricing_clicks (id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, date DATE NOT NULL DEFAULT CURRENT_DATE, tier TEXT NOT NULL, source_path TEXT NOT NULL DEFAULT '/pricing', created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
          await csql`CREATE TABLE IF NOT EXISTS affiliate_clicks (id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, date DATE NOT NULL DEFAULT CURRENT_DATE, link_id TEXT NOT NULL, destination_url TEXT, source_path TEXT NOT NULL DEFAULT '/', created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
          await csql`CREATE TABLE IF NOT EXISTS email_sequences (id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, sequence TEXT NOT NULL, step INTEGER NOT NULL DEFAULT 1, subject TEXT NOT NULL, body_html TEXT NOT NULL, body_text TEXT, delay_hours INTEGER NOT NULL DEFAULT 0, variant TEXT DEFAULT 'a', is_active BOOLEAN DEFAULT true, send_count INTEGER DEFAULT 0, open_count INTEGER DEFAULT 0, click_count INTEGER DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(sequence, step, variant))`;
          await csql`CREATE TABLE IF NOT EXISTS email_log (id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, recipient TEXT NOT NULL, sequence_id TEXT, subject TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'sent', resend_id TEXT, opened_at TIMESTAMPTZ, clicked_at TIMESTAMPTZ, bounced_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
          (repairs.neon as Record<string, unknown>).schema_applied = true;
        } catch (e: any) {
          (repairs.neon as Record<string, unknown>).schema_error = e.message;
        }
      }

      // Set DATABASE_URL on Vercel if project exists
      if (company.vercel_project_id && neon.connectionUri) {
        try {
          await setEnvVars(company.vercel_project_id, [
            { key: "DATABASE_URL", value: neon.connectionUri },
          ]);
          repairs.vercel_env = { DATABASE_URL: "set" };
        } catch (e: any) {
          repairs.vercel_env = { error: e.message };
        }
      }
    } catch (e: any) {
      const msg = e.message || "";
      if (msg.includes("managed by Vercel") || msg.includes("organization is managed")) {
        repairs.neon = { skipped: true, reason: "Neon org managed by Vercel — use Vercel dashboard to provision DB" };
      } else {
        repairs.neon = { error: msg, created: false };
      }
    }
  } else {
    // DB exists — verify connection and check for missing tables
    const [neonInfra] = await sql`
      SELECT config FROM infra
      WHERE company_id = ${company.id} AND service = 'neon' AND status = 'active'
    `;
    if (neonInfra?.config?.connection_string) {
      try {
        const { neon: neonClient } = await import("@neondatabase/serverless");
        const csql = neonClient(neonInfra.config.connection_string);
        const tables = await csql`
          SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public'
        `;
        const tableNames = new Set(tables.map((t: any) => t.table_name));
        const expected = ["customers", "waitlist", "page_views", "pricing_clicks", "affiliate_clicks", "email_sequences", "email_log"];
        const missing = expected.filter(t => !tableNames.has(t));
        if (missing.length > 0) {
          // Run missing table creation
          for (const table of missing) {
            try {
              if (table === "customers") await csql`CREATE TABLE IF NOT EXISTS customers (id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, email TEXT UNIQUE NOT NULL, stripe_customer_id TEXT, status TEXT NOT NULL DEFAULT 'active', created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
              if (table === "waitlist") await csql`CREATE TABLE IF NOT EXISTS waitlist (id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, email TEXT UNIQUE NOT NULL, name TEXT, referral_code TEXT UNIQUE NOT NULL, referred_by TEXT, referral_count INTEGER NOT NULL DEFAULT 0, position INTEGER, source TEXT DEFAULT 'organic', utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, status TEXT NOT NULL DEFAULT 'waiting', invited_at TIMESTAMPTZ, converted_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
              if (table === "page_views") await csql`CREATE TABLE IF NOT EXISTS page_views (date DATE NOT NULL DEFAULT CURRENT_DATE, path TEXT NOT NULL DEFAULT '/', views INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (date, path))`;
              if (table === "pricing_clicks") await csql`CREATE TABLE IF NOT EXISTS pricing_clicks (id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, date DATE NOT NULL DEFAULT CURRENT_DATE, tier TEXT NOT NULL, source_path TEXT NOT NULL DEFAULT '/pricing', created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
              if (table === "affiliate_clicks") await csql`CREATE TABLE IF NOT EXISTS affiliate_clicks (id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, date DATE NOT NULL DEFAULT CURRENT_DATE, link_id TEXT NOT NULL, destination_url TEXT, source_path TEXT NOT NULL DEFAULT '/', created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
              if (table === "email_sequences") await csql`CREATE TABLE IF NOT EXISTS email_sequences (id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, sequence TEXT NOT NULL, step INTEGER NOT NULL DEFAULT 1, subject TEXT NOT NULL, body_html TEXT NOT NULL, body_text TEXT, delay_hours INTEGER NOT NULL DEFAULT 0, variant TEXT DEFAULT 'a', is_active BOOLEAN DEFAULT true, send_count INTEGER DEFAULT 0, open_count INTEGER DEFAULT 0, click_count INTEGER DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(sequence, step, variant))`;
              if (table === "email_log") await csql`CREATE TABLE IF NOT EXISTS email_log (id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text, recipient TEXT NOT NULL, sequence_id TEXT, subject TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'sent', resend_id TEXT, opened_at TIMESTAMPTZ, clicked_at TIMESTAMPTZ, bounced_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
            } catch { /* individual table creation — non-blocking */ }
          }
          repairs.schema_repair = { missing_tables: missing, repaired: true };
        } else {
          repairs.neon = { exists: true, tables_ok: true };
        }
      } catch (e: any) {
        repairs.neon = { exists: true, connection_error: e.message };
      }
    } else {
      repairs.neon = { exists: true, no_connection_string_in_infra: true };
    }
  }

  // ── Repair 2: Missing Vercel env var (DATABASE_URL) ──
  if (company.vercel_project_id && company.neon_project_id) {
    try {
      const vercelToken = await getSettingValue("vercel_token");
      const teamId = await getSettingValue("vercel_team_id");
      const teamParam = teamId ? `&teamId=${teamId}` : "";
      const envRes = await fetch(
        `https://api.vercel.com/v9/projects/${company.vercel_project_id}/env?${teamParam}`,
        { headers: { Authorization: `Bearer ${vercelToken}` } }
      );
      if (envRes.ok) {
        const envData = await envRes.json();
        const hasDbUrl = envData.envs?.some((e: { key: string }) => e.key === "DATABASE_URL");
        if (!hasDbUrl) {
          // Fetch connection string from infra table
          const [neonInfra] = await sql`
            SELECT config FROM infra
            WHERE company_id = ${company.id} AND service = 'neon' AND status = 'active'
          `;
          if (neonInfra?.config?.connection_string) {
            await setEnvVars(company.vercel_project_id, [
              { key: "DATABASE_URL", value: neonInfra.config.connection_string },
            ]);
            repairs.vercel_env_repair = { DATABASE_URL: "set" };
          }
        }
      }
    } catch (e: any) {
      repairs.vercel_env_check = { error: e.message };
    }
  }

  // ── Repair 3: Vercel deploy health ──
  // Diagnose: project missing, deploy broken, duplicate projects on same repo
  if (company.vercel_project_id) {
    try {
      // 3a. Check if the tracked Vercel project actually exists
      let projectExists = true;
      try {
        await getProject(company.vercel_project_id);
      } catch {
        projectExists = false;
        repairs.vercel_project = { error: "tracked project not found", project_id: company.vercel_project_id };
      }

      // 3b. Check for duplicate Vercel projects on same GitHub repo
      if (company.github_repo) {
        try {
          const projects = await listProjectsForRepo(company.github_repo);
          if (projects.length > 1) {
            // Multiple projects deploying from same repo — this causes 429s and conflicts
            const tracked = projects.find(p => p.id === company.vercel_project_id || p.name === company.vercel_project_id);
            const duplicates = projects.filter(p => p.id !== company.vercel_project_id && p.name !== company.vercel_project_id);

            repairs.vercel_duplicates = {
              tracked_project: tracked?.name || company.vercel_project_id,
              duplicate_projects: duplicates.map(d => d.name),
              action: "unlinked_duplicates",
            };

            // Unlink git repo from duplicate projects (they'll stop auto-deploying)
            for (const dup of duplicates) {
              const unlinked = await removeGitLink(dup.id);
              (repairs.vercel_duplicates as Record<string, unknown>)[`unlinked_${dup.name}`] = unlinked;
            }
          }
        } catch (e: any) {
          repairs.vercel_repo_check = { error: e.message };
        }
      }

      // 3c. Check if latest deployment is healthy, redeploy if needed
      if (projectExists) {
        try {
          const dep = await getLatestDeployment(company.vercel_project_id);
          if (!dep) {
            // No deployments at all — trigger one
            const redeploy = await redeployProduction(company.vercel_project_id);
            repairs.vercel_deploy = { action: redeploy ? "redeployed" : "redeploy_failed", reason: "no_deployments", deployment_id: redeploy?.id };
          } else if (dep.readyState === "ERROR" || dep.state === "ERROR") {
            // Latest deploy errored — trigger fresh deploy
            const redeploy = await redeployProduction(company.vercel_project_id);
            repairs.vercel_deploy = { action: redeploy ? "redeployed" : "redeploy_failed", reason: "last_deploy_errored", deployment_id: redeploy?.id };
          } else {
            repairs.vercel_deploy = { status: "healthy", state: dep.readyState, url: dep.url };
          }
        } catch (e: any) {
          repairs.vercel_deploy = { error: e.message };
        }
      }
    } catch (e: any) {
      repairs.vercel_repair = { error: e.message };
    }
  }

  // ── Repair 4: Resolve stale escalations ──
  // If the same escalation has been pending for 3+ cycles, mark it resolved with auto-repair note
  const { repair_type } = body;
  if (repair_type === "stale_escalation") {
    try {
      const staleEscalations = await sql`
        SELECT id, title, gate_type FROM approvals
        WHERE company_id = ${company.id} AND status = 'pending'
          AND gate_type = 'spend_approval'
          AND created_at < NOW() - INTERVAL '48 hours'
      `;
      for (const esc of staleEscalations) {
        await sql`
          UPDATE approvals SET status = 'rejected', decided_at = NOW(),
            context = context || ${JSON.stringify({ auto_resolved: true, reason: "stale_escalation_auto_repair", repairs })}::jsonb
          WHERE id = ${esc.id}
        `;
      }
      repairs.stale_escalations = { resolved: staleEscalations.length, ids: staleEscalations.map((e: any) => e.id) };
    } catch (e: any) {
      repairs.stale_escalations = { error: e.message };
    }
  }

  // Log the repair action
  await sql`
    INSERT INTO agent_actions (company_id, agent, action_type, description, status, output, started_at, finished_at)
    VALUES (
      ${company.id}, 'sentinel', 'infra_repair',
      ${`Infrastructure repair for ${company_slug}`},
      'success', ${JSON.stringify(repairs)}::jsonb,
      NOW(), NOW()
    )
  `;

  return json({ ok: true, repairs });

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("repair-infra crashed:", msg);
    return err(`Internal error: ${msg}`, 500);
  }
}
