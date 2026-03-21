import { NextRequest } from "next/server";
import { validateOIDC } from "@/lib/oidc";
import { getDb, json, err } from "@/lib/db";
import { getSettingValue } from "@/lib/settings";

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

export async function POST(req: NextRequest) {
  const claims = await validateOIDC(req);
  if (claims instanceof Response) return claims;

  // Verify workflow is allowed
  // workflow_ref looks like: "owner/repo/.github/workflows/hive-build.yml@refs/heads/main"
  // Must split by @ first (refs/heads/main contains slashes), then extract filename
  const workflowRef = String(claims.job_workflow_ref || claims.workflow_ref || "");
  const workflowPath = workflowRef.split("@")[0]; // strip @refs/heads/main
  const workflowFile = workflowPath.split("/").pop() || "";
  if (!workflowFile || !ALLOWED_WORKFLOWS.includes(workflowFile)) {
    return err(`Workflow '${workflowFile || claims.workflow}' not authorized (ref: ${workflowRef})`, 403);
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
