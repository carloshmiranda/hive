import { getDb } from "./db";
import crypto from "crypto";

export type AgentType = 'build' | 'growth' | 'fix' | 'ceo' | 'scout' | 'evolver';

/**
 * Generate content hash for payload deduplication
 */
export function generateContentHash(content: unknown): string {
  const contentString = typeof content === 'string' ? content : JSON.stringify(content);
  return crypto.createHash('sha256').update(contentString).digest('hex').substring(0, 16);
}

/**
 * Generate cache key for agent context with optional content hash
 * Format: company_id:agent_type:cycle_id:content_hash
 */
export function generateCacheKey(companyId: string, agentType: AgentType, cycleId?: string, contentHash?: string): string {
  const base = `${companyId}:${agentType}:${cycleId || 'no-cycle'}`;
  return contentHash ? `${base}:${contentHash}` : base;
}

/**
 * Get cached context for an agent with content-based deduplication
 * Overloaded to support portfolio agents (legacy cacheKey parameter)
 */
export async function getCachedContext(
  companyIdOrKey: string,
  agentType: AgentType,
  cycleId?: string,
  contentHash?: string
): Promise<unknown | null> {
  const sql = getDb();

  try {
    // Clean expired entries first
    await sql`DELETE FROM context_cache WHERE expires_at < now()`.catch(() => {});

    // Handle portfolio agents (cacheKey starts with _portfolio:)
    if (companyIdOrKey.startsWith('_portfolio:')) {
      const [cached] = await sql`
        SELECT context_data FROM context_cache
        WHERE cache_key = ${companyIdOrKey} AND expires_at > now()
        LIMIT 1
      `.catch(() => []);

      if (cached) {
        console.log(`[cache] Portfolio cache hit: ${companyIdOrKey}`);
        return cached.context_data;
      }
      return null;
    }

    // Company-level agents: use enhanced caching with content deduplication
    const companyId = companyIdOrKey;

    // If we have a content hash, look for exact content match first
    if (contentHash) {
      const contentCacheKey = generateCacheKey(companyId, agentType, cycleId, contentHash);
      const [cached] = await sql`
        SELECT context_data FROM context_cache
        WHERE cache_key = ${contentCacheKey} AND expires_at > now()
        LIMIT 1
      `.catch(() => []);

      if (cached) {
        console.log(`[cache] Content hash hit: ${contentCacheKey}`);
        return cached.context_data;
      }
    }

    // Fallback to traditional cache key (for backward compatibility)
    const cacheKey = generateCacheKey(companyId, agentType, cycleId);
    const [cached] = await sql`
      SELECT context_data FROM context_cache
      WHERE cache_key = ${cacheKey} AND expires_at > now()
      LIMIT 1
    `.catch(() => []);

    if (cached) {
      console.log(`[cache] Traditional cache hit: ${cacheKey}`);
      return cached.context_data;
    }

    return null;
  } catch (error) {
    console.warn('Cache get failed:', error);
    return null; // Fail gracefully - don't block on cache errors
  }
}

/**
 * Store context in cache with 10-minute TTL and content-based deduplication
 * Overloaded to support portfolio agents (legacy cacheKey parameter)
 */
export async function setCachedContext(
  companyIdOrKey: string,
  agentType: AgentType,
  contextData: unknown,
  cycleId?: string
): Promise<void> {
  const sql = getDb();
  const contextJson = JSON.stringify(contextData);

  try {
    // Handle portfolio agents (cacheKey starts with _portfolio:)
    if (companyIdOrKey.startsWith('_portfolio:')) {
      await sql`
        INSERT INTO context_cache (cache_key, agent_type, company_id, cycle_id, context_data)
        VALUES (${companyIdOrKey}, ${agentType}, ${'_portfolio'}, ${null}, ${contextJson})
        ON CONFLICT (cache_key) DO UPDATE SET
          context_data = EXCLUDED.context_data,
          created_at = now(),
          expires_at = now() + INTERVAL '10 minutes'
      `.catch(() => {}); // Ignore cache write failures - don't block normal flow

      console.log(`[cache] Stored portfolio context: ${companyIdOrKey}`);
      return;
    }

    // Company-level agents: use enhanced caching with content deduplication
    const companyId = companyIdOrKey;
    const contentHash = generateContentHash(contextData);

    // Store with content hash for deduplication
    const contentCacheKey = generateCacheKey(companyId, agentType, cycleId, contentHash);

    // Also store with traditional key for backward compatibility
    const traditionalKey = generateCacheKey(companyId, agentType, cycleId);

    // Insert/update both keys
    await sql`
      INSERT INTO context_cache (cache_key, agent_type, company_id, cycle_id, context_data)
      VALUES
        (${contentCacheKey}, ${agentType}, ${companyId}, ${cycleId || null}, ${contextJson}),
        (${traditionalKey}, ${agentType}, ${companyId}, ${cycleId || null}, ${contextJson})
      ON CONFLICT (cache_key) DO UPDATE SET
        context_data = EXCLUDED.context_data,
        created_at = now(),
        expires_at = now() + INTERVAL '10 minutes'
    `.catch(() => {}); // Ignore cache write failures - don't block normal flow

    console.log(`[cache] Stored context with deduplication: ${contentCacheKey.substring(0, 40)}...`);
  } catch (error) {
    console.warn('Cache set failed:', error);
    // Don't throw - cache failures shouldn't break the API
  }
}

/**
 * Invalidate cache for a specific company (called when cycle updates)
 */
export async function invalidateCompanyCache(companyId: string): Promise<void> {
  const sql = getDb();

  try {
    await sql`
      DELETE FROM context_cache WHERE company_id = ${companyId}
    `.catch(() => {});
  } catch (error) {
    console.warn('Cache invalidation failed:', error);
  }
}

/**
 * Invalidate cache for a specific cycle (called when cycle data changes)
 */
export async function invalidateCycleCache(cycleId: string): Promise<void> {
  const sql = getDb();

  try {
    await sql`
      DELETE FROM context_cache WHERE cycle_id = ${cycleId}
    `.catch(() => {});
  } catch (error) {
    console.warn('Cache invalidation failed:', error);
  }
}

/**
 * Clean up expired cache entries (can be called periodically)
 */
export async function cleanExpiredCache(): Promise<number> {
  const sql = getDb();

  try {
    const result = await sql`
      DELETE FROM context_cache WHERE expires_at < now()
      RETURNING cache_key
    `.catch(() => []);

    return result.length;
  } catch (error) {
    console.warn('Cache cleanup failed:', error);
    return 0;
  }
}