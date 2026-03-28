/**
 * Redis caching layer for Hive.
 *
 * Uses Upstash Redis (free tier: 500K commands/month, 256 MB).
 * Falls back gracefully when Redis is unavailable — no-op, never breaks.
 *
 * Requires env vars: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
 * (auto-set by Vercel Marketplace Upstash integration)
 */
import { Redis } from "@upstash/redis";

let redis: Redis | null = null;

function getRedis(): Redis | null {
  if (redis) return redis;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  redis = new Redis({
    url,
    token,
    enableAutoPipelining: true // Batch multiple Redis calls into single HTTP request
  });
  return redis;
}

// --- Generic cache helpers ---

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const r = getRedis();
    if (!r) return null;
    return await r.get<T>(key);
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  try {
    const r = getRedis();
    if (!r) return;
    await r.set(key, value, { ex: ttlSeconds });
  } catch {
    // Cache write failure is non-fatal
  }
}

export async function cacheDel(...keys: string[]): Promise<void> {
  try {
    const r = getRedis();
    if (!r) return;
    if (keys.length > 0) await r.del(...keys);
  } catch {
    // Cache delete failure is non-fatal
  }
}

/**
 * Pattern-based cache invalidation via SCAN + DEL.
 * Use sparingly — SCAN is O(N) on the keyspace.
 */
export async function cacheInvalidatePattern(pattern: string): Promise<number> {
  try {
    const r = getRedis();
    if (!r) return 0;

    let cursor = 0;
    let deleted = 0;
    do {
      const [nextCursor, keys] = await r.scan(cursor, { match: pattern, count: 100 });
      cursor = typeof nextCursor === "string" ? parseInt(nextCursor) : nextCursor;
      if (keys.length > 0) {
        await r.del(...(keys as string[]));
        deleted += keys.length;
      }
    } while (cursor !== 0);

    return deleted;
  } catch {
    return 0;
  }
}

// --- Settings cache (highest-ROI cache target) ---
// Settings are fetched 118 times across 41 files. This is the #1 optimization.

const SETTINGS_TTL = 600; // 10 minutes
const SETTINGS_PREFIX = "s:"; // short prefix to save memory

/**
 * Get a cached setting value. Falls back to the provided fetcher on miss.
 */
export async function cachedSetting(
  key: string,
  fetcher: () => Promise<string | null>,
): Promise<string | null> {
  const cacheKey = SETTINGS_PREFIX + key;
  const cached = await cacheGet<string>(cacheKey);

  // Distinguish between "not in cache" (null) and "cached as missing" ("__null__")
  if (cached === "__null__") return null;
  if (cached !== null && cached !== undefined) return cached;

  // Cache miss — fetch from DB
  const value = await fetcher();

  if (value !== null) {
    await cacheSet(cacheKey, value, SETTINGS_TTL);
  } else {
    // Cache missing keys with short TTL to avoid repeated DB misses
    await cacheSet(cacheKey, "__null__", 60);
  }

  return value;
}

/**
 * Invalidate a single setting (call when setting is updated).
 */
export async function invalidateSetting(key: string): Promise<void> {
  await cacheDel(SETTINGS_PREFIX + key);
}

/**
 * Invalidate all settings (call on bulk update).
 */
export async function invalidateAllSettings(): Promise<void> {
  await cacheInvalidatePattern(SETTINGS_PREFIX + "*");
}

// --- Playbook cache ---

const PLAYBOOK_TTL = 3600; // 1 hour — entries rarely change
const PLAYBOOK_PREFIX = "pb:";

export async function cachedPlaybook<T>(
  domain: string | null,
  fetcher: () => Promise<T>,
): Promise<T> {
  const cacheKey = PLAYBOOK_PREFIX + (domain || "all");
  const cached = await cacheGet<T>(cacheKey);
  if (cached !== null && cached !== undefined) return cached;

  const value = await fetcher();
  await cacheSet(cacheKey, value, PLAYBOOK_TTL);
  return value;
}

export async function invalidatePlaybook(): Promise<void> {
  await cacheInvalidatePattern(PLAYBOOK_PREFIX + "*");
}

// --- Company list cache ---

const COMPANIES_TTL = 300; // 5 minutes
const COMPANIES_PREFIX = "co:";

export async function cachedCompanyList<T>(fetcher: () => Promise<T>, variant: string = "list"): Promise<T> {
  const cacheKey = COMPANIES_PREFIX + variant;
  const cached = await cacheGet<T>(cacheKey);
  if (cached !== null && cached !== undefined) return cached;

  const value = await fetcher();
  await cacheSet(cacheKey, value, COMPANIES_TTL);
  return value;
}

export async function invalidateCompanyList(): Promise<void> {
  await cacheInvalidatePattern(COMPANIES_PREFIX + "*");
}

/**
 * Health check for cache availability.
 */
export async function cacheHealthCheck(): Promise<{ ok: boolean; latencyMs?: number }> {
  try {
    const r = getRedis();
    if (!r) return { ok: false };
    const start = Date.now();
    await r.ping();
    return { ok: true, latencyMs: Date.now() - start };
  } catch {
    return { ok: false };
  }
}
