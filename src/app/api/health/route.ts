import { getDb, json } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { decrypt } from "@/lib/crypto";
import { cacheHealthCheck } from "@/lib/redis-cache";
import { setSentryTags } from "@/lib/sentry-tags";

export async function GET(request: Request) {
  const session = await requireAuth();
  const url = new URL(request.url);
  const isPublic = url.searchParams.has('public');

  // Set Sentry tags for tracking
  const action_type = isPublic ? 'health_check_public' : 'health_check';
  setSentryTags({
    request,
    custom_action_type: action_type
  });

  // For external uptime monitoring, return simple health status without auth
  if (isPublic || !session) {
    try {
      const sql = getDb();
      await sql`SELECT 1 as ok`;
      return json({
        status: "healthy",
        timestamp: new Date().toISOString(),
        service: "hive"
      }, 200);
    } catch (e: any) {
      return json({
        status: "unhealthy",
        timestamp: new Date().toISOString(),
        service: "hive",
        error: "Database connection failed"
      }, 503);
    }
  }

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

  // 4. Redis cache
  const cacheStatus = await cacheHealthCheck();
  checks.redis_cache = {
    status: cacheStatus.ok ? "ok" : "unavailable",
    detail: cacheStatus.ok ? `${cacheStatus.latencyMs}ms latency` : "Not configured (KV_REST_API_URL/TOKEN missing)",
  };

  // 5. Secrets decryption — verify all encrypted settings are readable
  try {
    const secrets = await sql`SELECT key, value FROM settings WHERE is_secret = true AND value IS NOT NULL`;
    const broken: string[] = [];
    for (const s of secrets) {
      try {
        decrypt(s.value);
      } catch {
        broken.push(s.key);
      }
    }
    checks.secrets_decryption = {
      status: broken.length === 0 ? "ok" : "error",
      detail: broken.length === 0
        ? `${secrets.length} secrets decryptable`
        : `Cannot decrypt: ${broken.join(", ")}. Check ENCRYPTION_KEY / ENCRYPTION_KEY_OLD.`,
    };
  } catch (e: any) {
    checks.secrets_decryption = { status: "error", detail: e.message };
  }

  // 6. Prompt files
  checks.prompts = { status: "info", detail: "Check /prompts/ directory on the server" };

  // Overall status
  const allStatuses = Object.values(checks).map(c => c.status);
  const overall = allStatuses.includes("error") ? "unhealthy" : allStatuses.includes("missing") ? "degraded" : "healthy";

  return json({ status: overall, checks, timestamp: new Date().toISOString() });
}
