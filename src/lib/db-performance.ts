/**
 * Database Performance Monitoring for Neon PostgreSQL
 *
 * Tracks slow queries and cache hit ratios to identify performance bottlenecks
 * particularly in sentinel runs that execute 30-50 queries.
 */

import { getDb } from "@/lib/db";

export interface SlowQuery {
  query: string;
  calls: number;
  mean_exec_time: number;
  total_exec_time: number;
}

export interface CacheStats {
  file_cache_size?: number;
  file_cache_hit_rate?: number;
}

export interface DbPerformanceReport {
  timestamp: Date;
  slow_queries: SlowQuery[];
  cache_stats: CacheStats | null;
  issues: string[];
  recommendations: string[];
}

/**
 * Enable pg_stat_statements extension if not already enabled
 */
export async function enableStatStatementsExtension(): Promise<void> {
  const sql = getDb();
  try {
    await sql`CREATE EXTENSION IF NOT EXISTS pg_stat_statements`;
    console.log("[db-performance] pg_stat_statements extension enabled");
  } catch (error: any) {
    console.warn("[db-performance] Failed to enable pg_stat_statements:", error.message);
    throw new Error(`Failed to enable pg_stat_statements: ${error.message}`);
  }
}

/**
 * Enable Neon extension for cache statistics if not already enabled
 */
export async function enableNeonExtension(): Promise<void> {
  const sql = getDb();
  try {
    await sql`CREATE EXTENSION IF NOT EXISTS neon`;
    console.log("[db-performance] neon extension enabled");
  } catch (error: any) {
    console.warn("[db-performance] Failed to enable neon extension:", error.message);
    throw new Error(`Failed to enable neon extension: ${error.message}`);
  }
}

/**
 * Query the slowest database queries
 */
export async function getSlowQueries(limit: number = 20): Promise<SlowQuery[]> {
  const sql = getDb();
  try {
    const results = await sql`
      SELECT
        query,
        calls,
        mean_exec_time,
        total_exec_time
      FROM pg_stat_statements
      ORDER BY mean_exec_time DESC
      LIMIT ${limit}
    `;

    return results.map(row => ({
      query: row.query as string,
      calls: row.calls as number,
      mean_exec_time: row.mean_exec_time as number,
      total_exec_time: row.total_exec_time as number,
    }));
  } catch (error: any) {
    console.warn("[db-performance] Failed to fetch slow queries:", error.message);
    throw new Error(`Failed to fetch slow queries: ${error.message}`);
  }
}

/**
 * Get database cache hit ratio statistics
 */
export async function getCacheStats(): Promise<CacheStats | null> {
  const sql = getDb();
  try {
    const results = await sql`SELECT * FROM neon_stat_file_cache`;

    if (results.length === 0) {
      return null;
    }

    const stats = results[0];
    return {
      file_cache_size: stats.file_cache_size as number | undefined,
      file_cache_hit_rate: stats.file_cache_hit_rate as number | undefined,
    };
  } catch (error: any) {
    console.warn("[db-performance] Failed to fetch cache stats:", error.message);
    // Return null instead of throwing since cache stats are optional
    return null;
  }
}

/**
 * Generate performance report with issues and recommendations
 */
export async function generatePerformanceReport(): Promise<DbPerformanceReport> {
  const timestamp = new Date();
  const issues: string[] = [];
  const recommendations: string[] = [];

  let slow_queries: SlowQuery[] = [];
  let cache_stats: CacheStats | null = null;

  // Try to get slow queries
  try {
    slow_queries = await getSlowQueries(20);
  } catch (error: any) {
    issues.push(`Unable to fetch slow queries: ${error.message}`);
    if (error.message.includes('pg_stat_statements')) {
      recommendations.push('Enable pg_stat_statements extension to track query performance');
    }
  }

  // Try to get cache stats
  try {
    cache_stats = await getCacheStats();
  } catch (error: any) {
    issues.push(`Unable to fetch cache stats: ${error.message}`);
    if (error.message.includes('neon')) {
      recommendations.push('Enable neon extension to track cache performance');
    }
  }

  // Analyze slow queries
  if (slow_queries.length > 0) {
    const sentinel_queries = slow_queries.filter(q =>
      q.calls >= 30 && q.mean_exec_time > 100 // queries called 30+ times with >100ms avg
    );

    if (sentinel_queries.length > 0) {
      issues.push(`Found ${sentinel_queries.length} potentially slow sentinel queries`);
      recommendations.push('Review and optimize slow queries that are called frequently (30+ times)');
    }

    const very_slow = slow_queries.filter(q => q.mean_exec_time > 1000); // > 1 second
    if (very_slow.length > 0) {
      issues.push(`${very_slow.length} queries averaging >1000ms execution time`);
      recommendations.push('Investigate queries with >1s average execution time for optimization opportunities');
    }
  }

  // Analyze cache hit ratio
  if (cache_stats && cache_stats.file_cache_hit_rate !== undefined) {
    const hit_rate = cache_stats.file_cache_hit_rate;
    if (hit_rate < 0.99) { // Target 99%+
      issues.push(`Cache hit rate is ${(hit_rate * 100).toFixed(1)}% (target: 99%+)`);
      recommendations.push('Poor cache hit rate may indicate insufficient cache size or inefficient queries');
    } else {
      console.log(`[db-performance] Cache hit rate: ${(hit_rate * 100).toFixed(1)}% (healthy)`);
    }
  }

  return {
    timestamp,
    slow_queries,
    cache_stats,
    issues,
    recommendations,
  };
}

/**
 * Initialize database performance monitoring by enabling required extensions
 */
export async function initializeDbPerformanceMonitoring(): Promise<{
  extensions_enabled: string[];
  errors: string[]
}> {
  const extensions_enabled: string[] = [];
  const errors: string[] = [];

  // Try to enable pg_stat_statements
  try {
    await enableStatStatementsExtension();
    extensions_enabled.push('pg_stat_statements');
  } catch (error: any) {
    errors.push(`pg_stat_statements: ${error.message}`);
  }

  // Try to enable neon extension
  try {
    await enableNeonExtension();
    extensions_enabled.push('neon');
  } catch (error: any) {
    errors.push(`neon: ${error.message}`);
  }

  return { extensions_enabled, errors };
}