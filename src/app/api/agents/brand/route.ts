import { NextRequest } from "next/server";
import { getDb, json, err } from "@/lib/db";
import { generateBrand } from "@/lib/brand";
import { setSentryTags } from "@/lib/sentry-tags";

// POST /api/agents/brand — generate (or regenerate) brand identity for a company
// Called at provisioning time and on-demand for brand refreshes.
// Auth: CRON_SECRET bearer token
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return err("Unauthorized", 401);
  }

  setSentryTags({
    action_type: "agent_api",
    route: "/api/agents/brand",
  });

  let body: { company_slug?: string; company_id?: string };
  try {
    body = await req.json();
  } catch {
    return err("Invalid JSON body", 400);
  }

  const { company_slug, company_id } = body;
  if (!company_slug && !company_id) {
    return err("company_slug or company_id is required", 400);
  }

  const sql = getDb();

  // Resolve company_id from slug if needed
  let resolvedId = company_id;
  if (!resolvedId && company_slug) {
    const [row] = await sql`SELECT id FROM companies WHERE slug = ${company_slug} LIMIT 1`;
    if (!row) return err("Company not found", 404);
    resolvedId = row.id;
  }

  try {
    const brand = await generateBrand(sql, resolvedId!);
    return json({ ok: true, company_slug: company_slug ?? resolvedId, brand });
  } catch (e: any) {
    return err(`Brand generation failed: ${e.message}`, 500);
  }
}
