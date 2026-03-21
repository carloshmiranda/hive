import { NextRequest } from "next/server";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { getDb, json, err } from "@/lib/db";
import { getSettingValue } from "@/lib/settings";

const GITHUB_JWKS_URL = "https://token.actions.githubusercontent.com/.well-known/jwks";
const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";
const EXPECTED_AUDIENCE = "https://hive-phi.vercel.app";
const EXPECTED_OWNER = "carloshmiranda";

// The Hive orchestrator repo (not in companies table — special case)
const HIVE_REPO = "carloshmiranda/hive";

// Workflows allowed to request tokens
const ALLOWED_WORKFLOWS = [
  // Company repo workflows
  "hive-build.yml",
  "hive-fix.yml",
  "hive-growth.yml",
  // Hive repo brain agent workflows
  "hive-ceo.yml",
  "hive-engineer.yml",
  "hive-scout.yml",
  "hive-evolver.yml",
  "hive-healer.yml",
  "hive-sentinel.yml",
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
  // workflow_ref looks like: "owner/repo/.github/workflows/hive-build.yml@refs/heads/main"
  // workflow claim is just the name: "Hive Build" — not useful for matching
  const workflowRef = String(claims.job_workflow_ref || claims.workflow_ref || "");
  const workflowFile = workflowRef.split("/").pop()?.split("@")[0] || "";
  if (!workflowFile || !ALLOWED_WORKFLOWS.includes(workflowFile)) {
    return err(`Workflow '${workflowFile || claims.workflow}' not authorized`, 403);
  }

  // Determine which token to return based on request
  let tokenType: string;
  try {
    const body = await req.json();
    tokenType = body.token_type || "claude";
  } catch {
    tokenType = "claude";
  }

  // Check if this is the Hive orchestrator repo (not in companies table)
  const repo = String(claims.repository || "");
  let responseMeta: { company: string; company_id: string | null };

  if (repo === HIVE_REPO) {
    responseMeta = { company: "hive", company_id: null };
  } else {
    // Verify repo is a known company in the DB
    const sql = getDb();
    const [company] = await sql`
      SELECT id, slug FROM companies WHERE github_repo = ${repo} LIMIT 1
    `.catch(() => []);

    if (!company) {
      return err(`Repository ${repo} not registered in Hive`, 404);
    }
    responseMeta = { company: company.slug, company_id: company.id };
  }

  // Token type → settings key mapping
  const tokenMap: Record<string, string> = {
    claude: "claude_code_oauth_token",
    gemini: "gemini_api_key",
    github_pat: "github_token",
    vercel_token: "vercel_token",
    neon_api_key: "neon_api_key",
    cron_secret: "cron_secret",
  };

  const settingsKey = tokenMap[tokenType];
  if (!settingsKey) {
    return err(`Unknown token type '${tokenType}'`, 400);
  }

  const tokenValue = await getSettingValue(settingsKey);
  if (!tokenValue) {
    return err(`Token type '${tokenType}' not configured in settings`, 500);
  }

  return json({
    token: tokenValue,
    ...responseMeta,
  });
}
