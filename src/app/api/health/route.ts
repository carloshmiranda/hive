import { getDb, json } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

export async function GET() {
  const session = await requireAuth();
  if (!session) return json({ status: "error", message: "Unauthorized" }, 401);

  const sql = getDb();
  const checks: Record<string, { status: string; detail?: string }> = {};

  // 1. Database connection
  try {
    const [row] = await sql`SELECT 1 as ok, now() as ts`;
    checks.database = { status: row?.ok === 1 ? "ok" : "error", detail: row?.ts };
  } catch (e: any) {
    checks.database = { status: "error", detail: e.message };
  }

  // 2. Required settings
  const requiredSettings = [
    { key: "vercel_token", label: "Vercel API token" },
    { key: "github_pat", label: "GitHub PAT" },
    { key: "stripe_secret_key", label: "Stripe secret key" },
    { key: "resend_api_key", label: "Resend API key" },
    { key: "digest_email", label: "Digest email address" },
  ];

  try {
    const settings = await sql`SELECT key FROM settings`;
    const configuredKeys = new Set(settings.map((s: any) => s.key));

    for (const s of requiredSettings) {
      checks[s.key] = {
        status: configuredKeys.has(s.key) ? "ok" : "missing",
        detail: configuredKeys.has(s.key) ? "Configured" : `Add ${s.label} in /settings`,
      };
    }
  } catch (e: any) {
    checks.settings = { status: "error", detail: e.message };
  }

  // 3. Schema tables
  try {
    const tables = await sql`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name
    `;
    const tableNames = tables.map((t: any) => t.table_name);
    const expected = ["companies", "cycles", "agent_actions", "approvals", "metrics", "playbook", "agent_prompts", "settings"];
    const missing = expected.filter(t => !tableNames.includes(t));
    checks.schema = {
      status: missing.length === 0 ? "ok" : "error",
      detail: missing.length === 0 ? `${tableNames.length} tables` : `Missing: ${missing.join(", ")}`,
    };
  } catch (e: any) {
    checks.schema = { status: "error", detail: e.message };
  }

  // 4. Prompt files
  checks.prompts = { status: "info", detail: "Check /prompts/ directory on the server" };

  // Overall status
  const allStatuses = Object.values(checks).map(c => c.status);
  const overall = allStatuses.includes("error") ? "unhealthy" : allStatuses.includes("missing") ? "degraded" : "healthy";

  return json({ status: overall, checks, timestamp: new Date().toISOString() });
}
