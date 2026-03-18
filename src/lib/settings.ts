import { getDb } from "@/lib/db";
import { decrypt } from "@/lib/crypto";

// Read a decrypted setting value — used by lib wrappers and orchestrator
export async function getSettingValue(key: string): Promise<string | null> {
  const sql = getDb();
  try {
    const [row] = await sql`SELECT value, is_secret FROM settings WHERE key = ${key}`;
    if (!row) return null;
    return row.is_secret ? decrypt(row.value) : row.value;
  } catch {
    // Settings table might not exist yet on first run
    return null;
  }
}
