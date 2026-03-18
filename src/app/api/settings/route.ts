import { getDb, json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { encrypt, decrypt } from "@/lib/crypto";

// Settings are stored in a simple key-value pattern in Neon.
// We create the table on first access if it doesn't exist.
async function ensureTable() {
  const sql = getDb();
  await sql`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      is_secret BOOLEAN DEFAULT false,
      updated_at TIMESTAMPTZ DEFAULT now()
    )
  `;
}

// Keys that are considered secrets (will be encrypted)
const SECRET_KEYS = new Set([
  "neon_api_key", "vercel_token", "github_token",
  "stripe_secret_key", "resend_api_key", "google_search_console_key"
]);

// All valid setting keys
const VALID_KEYS = [
  "neon_api_key", "vercel_token", "vercel_team_id",
  "github_token", "github_owner",
  "stripe_secret_key",
  "resend_api_key", "resend_domain",
  "google_search_console_key",
  "digest_email", "notification_email",
];

export async function GET() {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  await ensureTable();
  const sql = getDb();
  const rows = await sql`SELECT key, value, is_secret, updated_at FROM settings ORDER BY key`;

  // Mask secrets — show only last 4 chars
  const settings = rows.map(row => ({
    key: row.key,
    value: row.is_secret
      ? (row.value ? "••••" + decrypt(row.value).slice(-4) : "")
      : row.value,
    is_set: !!row.value,
    is_secret: row.is_secret,
    updated_at: row.updated_at,
  }));

  // Include unset keys so the UI shows empty fields
  const setKeys = new Set(settings.map(s => s.key));
  for (const key of VALID_KEYS) {
    if (!setKeys.has(key)) {
      settings.push({ key, value: "", is_set: false, is_secret: SECRET_KEYS.has(key), updated_at: null });
    }
  }

  settings.sort((a, b) => a.key.localeCompare(b.key));
  return json(settings);
}

export async function POST(req: Request) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  await ensureTable();
  const body = await req.json();
  const { key, value } = body;

  if (!key || !VALID_KEYS.includes(key)) return err(`Invalid key. Valid keys: ${VALID_KEYS.join(", ")}`);
  if (value === undefined) return err("value is required");

  const isSecret = SECRET_KEYS.has(key);
  const storedValue = isSecret && value ? encrypt(value) : value;

  const sql = getDb();
  await sql`
    INSERT INTO settings (key, value, is_secret, updated_at)
    VALUES (${key}, ${storedValue}, ${isSecret}, now())
    ON CONFLICT (key) DO UPDATE SET
      value = EXCLUDED.value,
      is_secret = EXCLUDED.is_secret,
      updated_at = now()
  `;

  return json({ key, saved: true });
}
