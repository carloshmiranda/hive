import { cacheGet, cacheSet, cacheInvalidatePattern } from "./redis-cache";

export type AgentType = 'build' | 'growth' | 'fix' | 'ceo' | 'scout' | 'evolver';

/**
 * Generate cache key for agent context.
 * Format: ctx:{company_id}:{agent_type}:{cycle_id}
 */
function makeCacheKey(companyId: string, agentType: AgentType, cycleId?: string): string {
  return `ctx:${companyId}:${agentType}:${cycleId || 'no-cycle'}`;
}

/**
 * Get cached context for an agent.
 * Falls back to null on Redis miss or unavailability — never blocks.
 */
export async function getCachedContext(
  companyIdOrKey: string,
  agentType: AgentType,
  cycleId?: string,
  _contentHash?: string // kept for API compatibility, unused
): Promise<unknown | null> {
  try {
    const key = companyIdOrKey.startsWith('_portfolio:')
      ? companyIdOrKey
      : makeCacheKey(companyIdOrKey, agentType, cycleId);

    const cached = await cacheGet<unknown>(key);
    if (cached !== null) {
      console.log(`[cache] Redis hit: ${key}`);
    }
    return cached;
  } catch {
    return null;
  }
}

/**
 * Store context in Redis with 10-minute TTL.
 * Ignores write failures — cache misses must never block agents.
 */
export async function setCachedContext(
  companyIdOrKey: string,
  agentType: AgentType,
  contextData: unknown,
  cycleId?: string
): Promise<void> {
  try {
    const key = companyIdOrKey.startsWith('_portfolio:')
      ? companyIdOrKey
      : makeCacheKey(companyIdOrKey, agentType, cycleId);

    await cacheSet(key, contextData, 600); // 10-minute TTL
    console.log(`[cache] Stored context: ${key}`);
  } catch {
    // Don't throw — cache failures shouldn't break the API
  }
}

/**
 * Invalidate all cached contexts for a company (called when cycle updates).
 */
export async function invalidateCompanyCache(companyId: string): Promise<void> {
  try {
    await cacheInvalidatePattern(`ctx:${companyId}:*`);
  } catch {
    // Ignore — cache invalidation failures are non-fatal
  }
}

/**
 * Invalidate cached contexts for a specific cycle (called when cycle data changes).
 */
export async function invalidateCycleCache(cycleId: string): Promise<void> {
  try {
    await cacheInvalidatePattern(`ctx:*:*:${cycleId}`);
  } catch {
    // Ignore — cache invalidation failures are non-fatal
  }
}
