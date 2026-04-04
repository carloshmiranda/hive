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

// --- Cache hit/miss metrics ---
// Atomic counters in Redis — fire-and-forget increments (non-blocking, never break the hot path).
// Keys never expire: they accumulate lifetime stats, readable via getCacheStats().

const CACHE_HIT_KEY = "metrics:cache:hits";
const CACHE_MISS_KEY = "metrics:cache:misses";

export interface CacheStats {
  hits: number;
  misses: number;
  total: number;
  hitRate: number; // 0–1
}

// --- Generic cache helpers ---

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const r = getRedis();
    if (!r) return null;
    const value = await r.get<T>(key);
    // Fire-and-forget hit/miss tracking — non-blocking, failure is non-fatal
    if (value !== null && value !== undefined) {
      r.incr(CACHE_HIT_KEY).catch(() => {});
    } else {
      r.incr(CACHE_MISS_KEY).catch(() => {});
    }
    return value;
  } catch {
    return null;
  }
}

/**
 * Read lifetime cache hit/miss counters.
 * Returns null if Redis is unavailable.
 */
export async function getCacheStats(): Promise<CacheStats | null> {
  try {
    const r = getRedis();
    if (!r) return null;
    const [rawHits, rawMisses] = await r.mget<[number | null, number | null]>(
      CACHE_HIT_KEY,
      CACHE_MISS_KEY,
    );
    const hits = rawHits ?? 0;
    const misses = rawMisses ?? 0;
    const total = hits + misses;
    return { hits, misses, total, hitRate: total > 0 ? hits / total : 0 };
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

// --- Company metrics cache ---

const METRICS_TTL = 21600; // 6 hours — aligned with metrics collection schedule
const METRICS_PREFIX = "met:"; // met:{company_slug}

export async function cachedCompanyMetrics<T>(
  companySlug: string,
  fetcher: () => Promise<T>
): Promise<T> {
  const cacheKey = METRICS_PREFIX + companySlug;
  const cached = await cacheGet<T>(cacheKey);
  if (cached !== null && cached !== undefined) return cached;

  const value = await fetcher();
  await cacheSet(cacheKey, value, METRICS_TTL);
  return value;
}

export async function invalidateCompanyMetrics(companySlug: string): Promise<void> {
  await cacheDel(METRICS_PREFIX + companySlug);
}

export async function invalidateAllMetrics(): Promise<void> {
  await cacheInvalidatePattern(METRICS_PREFIX + "*");
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

// --- Dispatch Queue (Redis Sorted Set) ---
// Priority queue for backlog dispatch using Redis sorted sets.
// Score = computed priority score (higher = more urgent).
// Replaces complex SQL ORDER BY with atomic Redis operations.

const DISPATCH_QUEUE_KEY = "dispatch:queue";

/**
 * Add an item to the dispatch queue with its priority score.
 */
export async function queueAdd(itemId: string, priorityScore: number): Promise<void> {
  try {
    const r = getRedis();
    if (!r) return;
    await r.zadd(DISPATCH_QUEUE_KEY, { score: priorityScore, member: itemId });
  } catch {
    // Queue write failure is non-fatal
  }
}

/**
 * Remove an item from the dispatch queue.
 */
export async function queueRemove(itemId: string): Promise<void> {
  try {
    const r = getRedis();
    if (!r) return;
    await r.zrem(DISPATCH_QUEUE_KEY, itemId);
  } catch {
    // Queue write failure is non-fatal
  }
}

/**
 * Atomically pop the highest-priority item from the queue.
 * Returns the item ID and its score, or null if queue is empty.
 */
export async function queuePop(): Promise<{ itemId: string; score: number } | null> {
  try {
    const r = getRedis();
    if (!r) return null;

    // ZPOPMAX gets highest score (most urgent)
    const result = await r.zpopmax(DISPATCH_QUEUE_KEY, 1);
    if (!result || result.length === 0) return null;

    return { itemId: result[0] as string, score: result[1] as number };
  } catch {
    return null;
  }
}

/**
 * Get the queue size (number of items waiting).
 */
export async function queueSize(): Promise<number> {
  try {
    const r = getRedis();
    if (!r) return 0;
    return await r.zcard(DISPATCH_QUEUE_KEY);
  } catch {
    return 0;
  }
}

/**
 * Get top N items from the queue without removing them.
 * Returns array of {itemId, score} ordered by priority (highest first).
 */
export async function queuePeek(count: number = 10): Promise<Array<{ itemId: string; score: number }>> {
  try {
    const r = getRedis();
    if (!r) return [];

    // ZRANGE with REV and scores gets highest scores first
    const result = await r.zrange(DISPATCH_QUEUE_KEY, 0, count - 1, { withScores: true, rev: true });

    const items: Array<{ itemId: string; score: number }> = [];
    for (let i = 0; i < result.length; i += 2) {
      items.push({
        itemId: result[i] as string,
        score: result[i + 1] as number
      });
    }

    return items;
  } catch {
    return [];
  }
}

/**
 * Rebuild the entire dispatch queue from database.
 * Should be called when queue gets out of sync or on Sentinel cycles.
 */
export async function queueRebuild(readyItems: Array<{ id: string; priority_score: number }>): Promise<void> {
  try {
    const r = getRedis();
    if (!r) return;

    // Clear existing queue
    await r.del(DISPATCH_QUEUE_KEY);

    if (readyItems.length === 0) return;

    // Batch add all items
    if (readyItems.length === 1) {
      await r.zadd(DISPATCH_QUEUE_KEY, { score: readyItems[0].priority_score, member: readyItems[0].id });
    } else {
      const members: Array<{ score: number; member: string }> = readyItems.map(item => ({
        score: item.priority_score,
        member: item.id
      }));
      await r.zadd(DISPATCH_QUEUE_KEY, members[0], ...members.slice(1));
    }
  } catch {
    // Queue rebuild failure is non-fatal
  }
}

/**
 * Sync a single backlog item to the dispatch queue.
 * - If status is 'ready': add/update item with its priority score
 * - If status is not 'ready': remove item from queue
 */
export async function queueSyncItem(
  itemId: string,
  status: string,
  priorityScore?: number
): Promise<void> {
  if (status === "ready" && priorityScore !== undefined) {
    await queueAdd(itemId, priorityScore);
  } else {
    await queueRemove(itemId);
  }
}

// --- Circuit breaker cache ---

const CIRCUIT_BREAKER_TTL = 172800; // 48 hours (48 * 60 * 60)
const CIRCUIT_BREAKER_PREFIX = "cb:"; // cb:{company}:{agent}

/**
 * Get circuit breaker state from Redis cache.
 * Returns true if circuit is open (cached), false if closed, or null if not in cache.
 */
export async function getCachedCircuitState(
  companyId: string,
  agent: string
): Promise<boolean | null> {
  const cacheKey = `${CIRCUIT_BREAKER_PREFIX}${companyId}:${agent}`;
  const cached = await cacheGet<boolean>(cacheKey);
  return cached;
}

/**
 * Set circuit breaker state in Redis cache with 48h TTL.
 */
export async function setCachedCircuitState(
  companyId: string,
  agent: string,
  isOpen: boolean
): Promise<void> {
  const cacheKey = `${CIRCUIT_BREAKER_PREFIX}${companyId}:${agent}`;
  await cacheSet(cacheKey, isOpen, CIRCUIT_BREAKER_TTL);
}

/**
 * Batch set multiple circuit breaker states.
 */
export async function batchSetCircuitStates(
  states: Array<{ companyId: string; agent: string; isOpen: boolean }>
): Promise<void> {
  const r = getRedis();
  if (!r) return;

  try {
    // Use pipeline for efficient batch operations
    const pipeline = r.pipeline();
    for (const state of states) {
      const cacheKey = `${CIRCUIT_BREAKER_PREFIX}${state.companyId}:${state.agent}`;
      pipeline.set(cacheKey, state.isOpen, { ex: CIRCUIT_BREAKER_TTL });
    }
    await pipeline.exec();
  } catch {
    // Cache write failure is non-fatal
  }
}

/**
 * Invalidate circuit breaker cache for a specific agent+company pair.
 */
export async function invalidateCircuitBreaker(
  companyId: string,
  agent: string
): Promise<void> {
  const cacheKey = `${CIRCUIT_BREAKER_PREFIX}${companyId}:${agent}`;
  await cacheDel(cacheKey);
}

/**
 * Invalidate circuit breaker cache for a specific company (all agents).
 */
export async function invalidateCircuitBreakers(companyId?: string): Promise<void> {
  if (companyId) {
    await cacheInvalidatePattern(`${CIRCUIT_BREAKER_PREFIX}${companyId}:*`);
  } else {
    await cacheInvalidatePattern(`${CIRCUIT_BREAKER_PREFIX}*`);
  }
}

// --- Engineer distributed lock ---
// Prevents concurrent Hive Engineer dispatches without requiring a DB round-trip.
// Falls back gracefully: if Redis is unavailable, callers should fall back to the DB query.
//
// Key: "hive:engineer:lock"
// Value: JSON { actionId, startedAt, ttl }
// TTL: 75 minutes (engineer jobs complete in 5-15 min; 75 min catches ghost locks safely)

const ENGINEER_LOCK_KEY = "hive:engineer:lock";
const ENGINEER_LOCK_TTL = 75 * 60; // 75 minutes in seconds

export interface EngineerLock {
  actionId: string;
  startedAt: string;
}

/**
 * Try to acquire the engineer lock. Returns true if acquired, false if already held.
 * Uses Redis SET NX EX — atomic, no race conditions.
 * Falls back to false (not acquired) if Redis is unavailable.
 */
export async function acquireEngineerLock(actionId: string): Promise<boolean> {
  try {
    const r = getRedis();
    if (!r) return false;
    const value: EngineerLock = { actionId, startedAt: new Date().toISOString() };
    // SET key value NX EX ttl — returns "OK" if set, null if key already exists
    const result = await r.set(ENGINEER_LOCK_KEY, JSON.stringify(value), {
      nx: true,
      ex: ENGINEER_LOCK_TTL,
    });
    return result === "OK";
  } catch {
    return false; // Caller falls back to DB check
  }
}

/**
 * Release the engineer lock. Safe to call even if lock isn't held (idempotent).
 */
export async function releaseEngineerLock(): Promise<void> {
  try {
    const r = getRedis();
    if (!r) return;
    await r.del(ENGINEER_LOCK_KEY);
  } catch {
    // Non-fatal — lock will expire via TTL
  }
}

/**
 * Get the current engineer lock state without acquiring it.
 * Returns null if no lock held or Redis unavailable.
 */
export async function getEngineerLock(): Promise<EngineerLock | null> {
  try {
    const r = getRedis();
    if (!r) return null;
    const raw = await r.get<string>(ENGINEER_LOCK_KEY);
    if (!raw) return null;
    return typeof raw === "string" ? JSON.parse(raw) : raw as EngineerLock;
  } catch {
    return null; // Caller falls back to DB check
  }
}

// --- Playbook score leaderboard (Redis sorted sets) ---
// Tracks highest-confidence playbook entries per domain.
// Dispatcher and context API read top-N IDs from Redis before fetching full rows from Neon.
// Key format: playbook:score:{domain} — score = confidence (0.0-1.0)

const PLAYBOOK_LEADERBOARD_PREFIX = "playbook:score:";
const PLAYBOOK_LEADERBOARD_TTL = 86400; // 24h — refresh on every write

/**
 * Add or update a playbook entry's confidence score in the domain leaderboard.
 * Call on every playbook INSERT or confidence UPDATE.
 */
export async function playbookLeaderboardAdd(
  domain: string,
  id: string,
  confidence: number
): Promise<void> {
  try {
    const r = getRedis();
    if (!r) return;
    const key = PLAYBOOK_LEADERBOARD_PREFIX + domain;
    await r.zadd(key, { score: confidence, member: id });
    // Refresh TTL on write so stale domains age out
    await r.expire(key, PLAYBOOK_LEADERBOARD_TTL);
  } catch {
    // Non-fatal
  }
}

/**
 * Get top-N playbook entry IDs for a domain, sorted by confidence descending.
 * Returns empty array if Redis unavailable — callers fall through to Neon.
 */
export async function playbookLeaderboardTop(
  domain: string,
  n = 5
): Promise<string[]> {
  try {
    const r = getRedis();
    if (!r) return [];
    const key = PLAYBOOK_LEADERBOARD_PREFIX + domain;
    // ZRANGE with REV + LIMIT — returns top N members by score descending
    const members = await r.zrange(key, 0, n - 1, { rev: true });
    return (members as string[]).filter(Boolean);
  } catch {
    return [];
  }
}

// --- Interactive session claim lock ---
// Prevents the autonomous dispatcher from auto-dispatching backlog items
// that a human (Carlos via Claude Code) is actively working on in a session.
// Key format: claim:{backlog_id}
// Value: "interactive" (or agent name for future use)
// TTL: 2h — expires automatically if session ends without explicit release

const CLAIM_TTL = 7200; // 2 hours

/**
 * Claim a backlog item for the current interactive session.
 * Returns true if the claim was acquired, false if already claimed.
 * Uses SET NX (only set if not exists) — atomic, no race conditions.
 */
export async function claimBacklogItem(backlogId: string): Promise<boolean> {
  try {
    const r = getRedis();
    if (!r) return true; // No Redis → assume unclaimed (don't block work)
    const key = `claim:${backlogId}`;
    // SET NX EX: only set if not exists, with TTL
    const result = await r.set(key, "interactive", { nx: true, ex: CLAIM_TTL });
    return result === "OK";
  } catch {
    return true; // On error, assume unclaimed
  }
}

/**
 * Release a claim when the interactive session finishes.
 * Safe to call even if the claim doesn't exist.
 */
export async function releaseBacklogClaim(backlogId: string): Promise<void> {
  await cacheDel(`claim:${backlogId}`);
}

/**
 * Check if a backlog item is claimed.
 * Returns the claimant string (e.g. "interactive") or null if unclaimed.
 */
export async function getBacklogClaim(backlogId: string): Promise<string | null> {
  try {
    const r = getRedis();
    if (!r) return null;
    return await r.get<string>(`claim:${backlogId}`);
  } catch {
    return null;
  }
}
