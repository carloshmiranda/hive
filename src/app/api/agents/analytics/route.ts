import { NextRequest } from "next/server";
import { validateOIDC } from "@/lib/oidc";
import { getDb, json, err } from "@/lib/db";
import { getSettingValue } from "@/lib/settings";

// POST /api/agents/analytics — enable Vercel Web Analytics for a company
// Can also be called for all companies at once with { "all": true }
export async function POST(req: NextRequest) {
  const result = await validateOIDC(req);
  if (result instanceof Response) return result;

  const body = await req.json();
  const sql = getDb();

  const vercelToken = await getSettingValue("vercel_token");
  if (!vercelToken) return err("Vercel token not configured", 500);
  const teamId = await getSettingValue("vercel_team_id");
  const teamParam = teamId ? `?teamId=${teamId}` : "";

  // Get companies to enable analytics for
  let companies;
  if (body.all) {
    companies = await sql`
      SELECT id, slug, vercel_project_id FROM companies
      WHERE status IN ('mvp', 'active') AND vercel_project_id IS NOT NULL
    `;
  } else if (body.company_slug) {
    companies = await sql`
      SELECT id, slug, vercel_project_id FROM companies
      WHERE slug = ${body.company_slug} AND vercel_project_id IS NOT NULL
    `;
  } else {
    return err("Provide company_slug or all: true", 400);
  }

  const results = [];
  for (const company of companies) {
    try {
      const res = await fetch(`https://api.vercel.com/v1/web-analytics/projects${teamParam}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${vercelToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: company.vercel_project_id }),
      });
      results.push({ slug: company.slug, enabled: res.ok, status: res.status });
    } catch (e: any) {
      results.push({ slug: company.slug, enabled: false, error: e.message });
    }
  }

  return json({ results });
}
