import { NextRequest } from "next/server";
import { getDb, json, err } from "@/lib/db";
import { provisionNeonStore } from "@/lib/vercel";

/**
 * POST /api/agents/provision-neon — Provision a new Neon store for a company.
 * Body: { company_slug: string }
 * Auth: CRON_SECRET
 *
 * Provisions via Vercel Marketplace even if neon_project_id already set.
 * Use this for DB separation (moving companies to their own DBs).
 */
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return err("Unauthorized", 401);
  }

  try {
    const { company_slug } = await req.json();
    if (!company_slug) return err("company_slug required", 400);

    const sql = getDb();
    const [company] = await sql`
      SELECT id, slug, name, neon_project_id, vercel_project_id
      FROM companies WHERE slug = ${company_slug}
    `;
    if (!company) return err(`Company ${company_slug} not found`, 404);
    if (!company.vercel_project_id) return err(`Company ${company_slug} has no Vercel project`, 400);

    // Provision a new Neon store via Vercel Marketplace
    const store = await provisionNeonStore(company.vercel_project_id, `hive-${company_slug}-db`);
    if (!store) return err("Provisioning returned null", 500);

    // Update company record
    const oldNeonId = company.neon_project_id;
    await sql`
      UPDATE companies
      SET neon_project_id = ${store.storeId}, updated_at = NOW()
      WHERE id = ${company.id}
    `;

    // Record in infra table
    await sql`
      INSERT INTO infra (company_id, service, resource_id, config, status)
      VALUES (${company.id}, 'neon', ${store.storeId}, ${JSON.stringify({
        method: "vercel_marketplace",
        old_neon_project_id: oldNeonId,
        provisioned_for: "db_separation"
      })}::jsonb, 'active')
      ON CONFLICT DO NOTHING
    `;

    return json({
      ok: true,
      company: company_slug,
      store_id: store.storeId,
      status: store.status,
      old_neon_project_id: oldNeonId,
      note: "New Neon store provisioned. DATABASE_URL should be auto-injected into Vercel env vars."
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("provision-neon error:", msg);
    return err(msg, 500);
  }
}
