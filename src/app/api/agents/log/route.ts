import { NextRequest } from "next/server";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { getDb, json, err } from "@/lib/db";

const GITHUB_JWKS_URL = "https://token.actions.githubusercontent.com/.well-known/jwks";
const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";
const EXPECTED_AUDIENCE = "https://hive-phi.vercel.app";
const EXPECTED_OWNER = "carloshmiranda";

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJWKS() {
  if (!jwks) jwks = createRemoteJWKSet(new URL(GITHUB_JWKS_URL));
  return jwks;
}

// POST /api/agents/log — log agent action via OIDC auth
// Body: { company_slug, agent, action_type, status, description?, error? }
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return err("Missing Authorization header", 401);
  }
  try {
    const result = await jwtVerify(authHeader.slice(7), getJWKS(), {
      issuer: GITHUB_ISSUER,
      audience: EXPECTED_AUDIENCE,
    });
    const claims = result.payload as Record<string, unknown>;
    if (claims.repository_owner !== EXPECTED_OWNER) {
      return err("Repository owner not authorized", 403);
    }
  } catch (e) {
    return err(`OIDC validation failed: ${e instanceof Error ? e.message : "unknown"}`, 401);
  }

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
