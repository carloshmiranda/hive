import { getDb } from '@/lib/db';

export interface LineageFailureResult {
  totalFailures: number;
  lineageIds: string[];
  exceedsThreshold: boolean;
}

/**
 * Computes cumulative failure count across an item's entire lineage tree.
 * Traverses both up (to root parent) and down (to all descendants) to sum
 * failure_count across the complete parent_id chain.
 *
 * @param itemId - The backlog item ID to check
 * @param failureThreshold - Max allowed failures before blocking (default: 5)
 * @returns LineageFailureResult with total failures, lineage IDs, and threshold check
 */
export async function computeLineageFailures(
  itemId: string,
  failureThreshold = 5
): Promise<LineageFailureResult> {
  const sql = getDb();

  try {
    // Recursive CTE to traverse the complete lineage tree
    // Part 1: Traverse UP to find the root parent
    // Part 2: Traverse DOWN from root to find all descendants
    const result = await sql`
      WITH RECURSIVE lineage_tree AS (
        -- Start with the given item and traverse UP to root
        SELECT id, parent_id, failure_count, title, 0 as level, 'origin' as direction
        FROM hive_backlog
        WHERE id = ${itemId}

        UNION ALL

        -- Traverse UP: follow parent_id chain to root
        SELECT p.id, p.parent_id, p.failure_count, p.title, lt.level - 1, 'up'
        FROM hive_backlog p
        INNER JOIN lineage_tree lt ON p.id = lt.parent_id
        WHERE p.parent_id IS NOT NULL  -- Stop at root (no parent)

        UNION ALL

        -- Traverse DOWN: find all descendants from any lineage member
        SELECT c.id, c.parent_id, c.failure_count, c.title, lt.level + 1, 'down'
        FROM hive_backlog c
        INNER JOIN lineage_tree lt ON c.parent_id = lt.id
        WHERE c.id != lt.id  -- Prevent self-reference
      )
      SELECT
        COALESCE(SUM(failure_count), 0)::int AS total_failures,
        ARRAY_AGG(DISTINCT id) AS lineage_ids,
        COUNT(DISTINCT id) AS lineage_size
      FROM lineage_tree;
    `;

    const row = result[0];
    const totalFailures = row.total_failures || 0;
    const lineageIds = row.lineage_ids || [itemId];
    const exceedsThreshold = totalFailures > failureThreshold;

    console.log(`[backlog-lineage] Item ${itemId}: ${totalFailures} total failures across ${lineageIds.length} lineage items (threshold: ${failureThreshold})`);

    return {
      totalFailures,
      lineageIds,
      exceedsThreshold
    };

  } catch (error) {
    console.error(`[backlog-lineage] Failed to compute lineage failures for ${itemId}:`, error);
    // On error, return safe defaults that don't block dispatch
    return {
      totalFailures: 0,
      lineageIds: [itemId],
      exceedsThreshold: false
    };
  }
}

/**
 * Marks an entire lineage as blocked with [manual_spec_needed] tag.
 * Called when lineage failure threshold is exceeded to prevent death loops.
 *
 * @param lineageIds - Array of backlog item IDs in the lineage
 * @param reason - Reason for blocking (for debugging)
 */
export async function blockLineageForManualSpec(
  lineageIds: string[],
  reason = 'Lineage failure cap exceeded'
): Promise<void> {
  const sql = getDb();

  try {
    if (lineageIds.length === 0) {
      console.warn('[backlog-lineage] blockLineageForManualSpec called with empty lineage');
      return;
    }

    // Update all items in the lineage to blocked status with manual spec needed tag
    await sql`
      UPDATE hive_backlog
      SET
        status = 'blocked',
        dispatched_at = NULL,
        notes = CASE
          WHEN notes IS NULL THEN '[manual_spec_needed] ${reason}'
          WHEN notes NOT LIKE '%[manual_spec_needed]%' THEN notes || E'\n\n[manual_spec_needed] ${reason}'
          ELSE notes
        END,
        updated_at = now()
      WHERE id = ANY(${lineageIds})
        AND status NOT IN ('done', 'rejected');
    `;

    console.log(`[backlog-lineage] Blocked ${lineageIds.length} items in lineage: ${reason}`);

  } catch (error) {
    console.error('[backlog-lineage] Failed to block lineage for manual spec:', error);
    // Don't throw - this shouldn't crash the dispatch flow
  }
}