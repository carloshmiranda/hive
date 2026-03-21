import { NextRequest } from "next/server";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { getDb, json, err } from "@/lib/db";
import { getSettingValue } from "@/lib/settings";

const GITHUB_JWKS_URL = "https://token.actions.githubusercontent.com/.well-known/jwks";
const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";
const EXPECTED_AUDIENCE = "https://hive-phi.vercel.app";
const EXPECTED_OWNER = "carloshmiranda";

// Workflows allowed to request tokens
const ALLOWED_WORKFLOWS = [
  "hive-build.yml",
  "hive-fix.yml",
  "hive-growth.yml",
];

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJWKS() {
  if (!jwks) jwks = createRemoteJWKSet(new URL(GITHUB_JWKS_URL));
  return jwks;
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return err("Missing Authorization header", 401);
  }

  const oidcToken = authHeader.slice(7);

  // Validate GitHub OIDC JWT
  let claims;
  try {
    const result = await jwtVerify(oidcToken, getJWKS(), {
      issuer: GITHUB_ISSUER,
      audience: EXPECTED_AUDIENCE,
    });
    claims = result.payload as Record<string, unknown>;
  } catch (e) {
    return err(`OIDC validation failed: ${e instanceof Error ? e.message : "unknown"}`, 401);
  }

  // Verify repo owner
  if (claims.repository_owner !== EXPECTED_OWNER) {
    return err("Repository owner not authorized", 403);
  }

  // Verify workflow is allowed
  const workflow = String(claims.workflow || "");
  const workflowFile = workflow.split("/").pop() || workflow;
  if (!ALLOWED_WORKFLOWS.includes(workflowFile)) {
    return err(`Workflow ${workflowFile} not authorized`, 403);
  }

  // Verify repo is a known company in the DB
  const sql = getDb();
  const repo = String(claims.repository || "");
  const [company] = await sql`
    SELECT id, slug FROM companies WHERE github_repo = ${repo} LIMIT 1
  `.catch(() => []);

  if (!company) {
    return err(`Repository ${repo} not registered in Hive`, 404);
  }

  // Determine which token to return based on request
  let tokenType: string;
  try {
    const body = await req.json();
    tokenType = body.token_type || "claude";
  } catch {
    tokenType = "claude";
  }

  let tokenValue: string | null = null;
  if (tokenType === "claude") {
    tokenValue = await getSettingValue("claude_code_oauth_token");
  } else if (tokenType === "gemini") {
    tokenValue = await getSettingValue("gemini_api_key");
  } else if (tokenType === "github_pat") {
    tokenValue = await getSettingValue("github_token");
  }

  if (!tokenValue) {
    return err(`Token type '${tokenType}' not configured in settings`, 500);
  }

  return json({
    token: tokenValue,
    company: company.slug,
    company_id: company.id,
  });
}
