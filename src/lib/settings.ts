import { getDb } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { cachedSetting } from "@/lib/redis-cache";

// Read a decrypted setting value — used by lib wrappers and orchestrator.
// Redis-cached with 10-min TTL (118 call sites across 41 files).
export async function getSettingValue(key: string): Promise<string | null> {
  return cachedSetting(key, async () => {
    const sql = getDb();
    try {
      const [row] = await sql`SELECT value, is_secret FROM settings WHERE key = ${key}`;
      if (!row) return null;
      return row.is_secret ? decrypt(row.value) : row.value;
    } catch {
      // Settings table might not exist yet on first run
      return null;
    }
  });
}
