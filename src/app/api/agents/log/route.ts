import { NextRequest } from "next/server";
import { validateOIDC } from "@/lib/oidc";
import { getDb, json, err } from "@/lib/db";

// POST /api/agents/log — log agent action via OIDC auth
// Body: { company_slug, agent, action_type, status, description?, error? }
export async function POST(req: NextRequest) {
  const claims = await validateOIDC(req);
  if (claims instanceof Response) return claims;

  let body;
  try {
    body = await req.json();
  } catch {
    return err("Invalid JSON body", 400);
  }

  const { company_slug, agent, action_type, status, description, error: errorMsg } = body;
  if (!agent || !action_type || !status) {
    return err("Missing required fields: agent, action_type, status", 400);
  }

  const sql = getDb();

  let companyId = null;
  if (company_slug) {
    const [company] = await sql`
      SELECT id FROM companies WHERE slug = ${company_slug} LIMIT 1
    `.catch(() => []);
    companyId = company?.id || null;
  }

  await sql`
    INSERT INTO agent_actions (agent, company_id, action_type, status, description, error, started_at, finished_at)
    VALUES (${agent}, ${companyId}, ${action_type}, ${status},
      ${description || null}, ${errorMsg || null}, NOW() - INTERVAL '20 minutes', NOW())
  `;

  return json({ logged: true });
}
