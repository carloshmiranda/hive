import { getDb } from "@/lib/db";
import { decrypt, DecryptionError } from "@/lib/crypto";
import { cachedSetting } from "@/lib/redis-cache";

// Read a decrypted setting value — used by lib wrappers and orchestrator.
// Redis-cached with 10-min TTL (118 call sites across 41 files).
export async function getSettingValue(key: string): Promise<string | null> {
  return cachedSetting(key, async () => {
    const sql = getDb();
    try {
      const [row] = await sql`SELECT value, is_secret FROM settings WHERE key = ${key}`;
      if (!row) return null;
      if (!row.is_secret) return row.value;
      return decrypt(row.value);
    } catch (e) {
      if (e instanceof DecryptionError) {
        console.error(`[settings] DECRYPTION FAILED for "${key}": ${e.message}. Re-enter this secret in /settings or set ENCRYPTION_KEY_OLD.`);
      } else {
        console.error(`[settings] error reading "${key}":`, e instanceof Error ? e.message : e);
      }
      return null;
    }
  });
}
