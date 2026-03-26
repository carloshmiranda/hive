import { getDb } from "./db";

export type AgentType = 'build' | 'growth' | 'fix' | 'ceo' | 'scout' | 'evolver';

/**
 * Generate cache key for agent context
 * Format: company_id:agent_type:cycle_id
 */
export function generateCacheKey(companyId: string, agentType: AgentType, cycleId?: string): string {
  return `${companyId}:${agentType}:${cycleId || 'no-cycle'}`;
}

/**
 * Get cached context for an agent
 */
export async function getCachedContext(companyId: string, agentType: AgentType, cycleId?: string): Promise<unknown | null> {
  const sql = getDb();
  const cacheKey = generateCacheKey(companyId, agentType, cycleId);

  try {
    // Clean expired entries and get valid cache
    const [cached] = await sql`
      DELETE FROM context_cache WHERE expires_at < now();

      SELECT context_data FROM context_cache
      WHERE cache_key = ${cacheKey} AND expires_at > now()
      LIMIT 1
    `.catch(() => []);

    if (cached) {
      return cached.context_data;
    }

    return null;
  } catch (error) {
    console.warn('Cache get failed:', error);
    return null; // Fail gracefully - don't block on cache errors
  }
}

/**
 * Store context in cache with 10-minute TTL
 */
export async function setCachedContext(
  companyId: string,
  agentType: AgentType,
  contextData: unknown,
  cycleId?: string
): Promise<void> {
  const sql = getDb();
  const cacheKey = generateCacheKey(companyId, agentType, cycleId);

  try {
    await sql`
      INSERT INTO context_cache (cache_key, agent_type, company_id, cycle_id, context_data)
      VALUES (${cacheKey}, ${agentType}, ${companyId}, ${cycleId || null}, ${JSON.stringify(contextData)})
      ON CONFLICT (cache_key) DO UPDATE SET
        context_data = ${JSON.stringify(contextData)},
        created_at = now(),
        expires_at = now() + INTERVAL '10 minutes'
    `.catch(() => {}); // Ignore cache write failures - don't block normal flow
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