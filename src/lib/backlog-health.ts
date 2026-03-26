// Backlog health check system - prevent poisoning via volume, circularity, and staleness
// Called by: backlog dispatch route and sentinel cron

import { getDb } from "@/lib/db";

export interface BacklogHealthCheckResult {
  healthy: boolean;
  violations: string[];
  actions_taken: string[];
  total_items: number;
  active_items: number;
  stale_archived: number;
  duplicates_merged: number;
  circular_flagged: number;
}

// Configuration constants
const MAX_TOTAL_ITEMS = 200;           // Cap total items to prevent volume poisoning
const MAX_ACTIVE_ITEMS = 50;           // Cap active items (status != done, archived, cancelled)
const STALENESS_DAYS = 90;             // Auto-archive items older than 90 days
const DUPLICATE_SIMILARITY_THRESHOLD = 0.8; // Text similarity threshold for duplicate detection
const MAX_CIRCULAR_DEPTH = 5;          // Maximum depth for circular reference detection

// Helper function to compute text similarity (basic Jaccard similarity)
function computeTextSimilarity(text1: string, text2: string): number {
  const normalize = (text: string) =>
    text.toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(word => word.length > 2);

  const words1 = new Set(normalize(text1));
  const words2 = new Set(normalize(text2));

  const intersection = new Set([...words1].filter(x => words2.has(x)));
  const union = new Set([...words1, ...words2]);

  return union.size === 0 ? 0 : intersection.size / union.size;
}

// Helper function to extract referenced backlog items from text
function extractBacklogReferences(text: string): string[] {
  // Look for patterns like "depends on", "blocks", "related to", backlog IDs, etc.
  const references: string[] = [];

  // UUID pattern for direct backlog item references
  const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  const uuidMatches = text.match(uuidPattern) || [];
  references.push(...uuidMatches);

  // Look for task/item references
  const taskPattern = /(?:task|item|backlog)[\s#-]*(\d+|[a-z0-9-]+)/gi;
  const taskMatches = text.match(taskPattern) || [];
  references.push(...taskMatches.map(m => m.toLowerCase()));

  return [...new Set(references)]; // Deduplicate
}

// Check for circular dependencies between backlog items
async function detectCircularReferences(sql: ReturnType<typeof getDb>): Promise<{flagged: string[], count: number}> {
  const items = await sql`
    SELECT id, title, description, notes
    FROM hive_backlog
    WHERE status NOT IN ('done', 'archived', 'cancelled')
  `.catch(() => []);

  const flagged: string[] = [];
  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  // Build reference map
  const referenceMap = new Map<string, string[]>();
  for (const item of items) {
    const allText = `${item.title} ${item.description} ${item.notes || ''}`;
    const references = extractBacklogReferences(allText);
    referenceMap.set(item.id, references);
  }

  // DFS to detect cycles
  function hasCycle(itemId: string, depth = 0): boolean {
    if (depth > MAX_CIRCULAR_DEPTH) return false; // Prevent infinite recursion
    if (recursionStack.has(itemId)) return true;   // Cycle detected
    if (visited.has(itemId)) return false;         // Already processed

    visited.add(itemId);
    recursionStack.add(itemId);

    const references = referenceMap.get(itemId) || [];
    for (const ref of references) {
      // Check if this reference matches any item ID (exact or partial)
      const referencedItem = items.find(item =>
        item.id === ref ||
        item.id.includes(ref) ||
        item.title.toLowerCase().includes(ref.toLowerCase())
      );

      if (referencedItem && hasCycle(referencedItem.id, depth + 1)) {
        flagged.push(itemId);
        recursionStack.delete(itemId);
        return true;
      }
    }

    recursionStack.delete(itemId);
    return false;
  }

  // Check all items for cycles
  for (const item of items) {
    if (!visited.has(item.id)) {
      hasCycle(item.id);
    }
  }

  return { flagged, count: flagged.length };
}

// Find and merge duplicate backlog items
async function deduplicateBacklogItems(sql: ReturnType<typeof getDb>): Promise<number> {
  const items = await sql`
    SELECT id, title, description, priority, category, created_at
    FROM hive_backlog
    WHERE status NOT IN ('done', 'archived', 'cancelled')
    ORDER BY created_at ASC
  `.catch(() => []);

  let mergeCount = 0;
  const processed = new Set<string>();

  for (let i = 0; i < items.length; i++) {
    const itemA = items[i];
    if (processed.has(itemA.id)) continue;

    const duplicates: typeof items = [];

    for (let j = i + 1; j < items.length; j++) {
      const itemB = items[j];
      if (processed.has(itemB.id)) continue;

      const titleSim = computeTextSimilarity(itemA.title, itemB.title);
      const descSim = computeTextSimilarity(itemA.description, itemB.description);
      const avgSim = (titleSim + descSim) / 2;

      if (avgSim >= DUPLICATE_SIMILARITY_THRESHOLD) {
        duplicates.push(itemB);
      }
    }

    if (duplicates.length > 0) {
      // Keep the oldest item (created first), merge others into it
      const duplicateIds = duplicates.map(d => d.id);
      const duplicateTitles = duplicates.map(d => d.title).join(', ');

      await sql`
        UPDATE hive_backlog
        SET notes = COALESCE(notes, '') || ${` | Merged duplicates: ${duplicateTitles}`},
            updated_at = NOW()
        WHERE id = ${itemA.id}
      `.catch(() => {});

      await sql`
        UPDATE hive_backlog
        SET status = 'archived',
            notes = COALESCE(notes, '') || ${` | Archived as duplicate of ${itemA.title}`},
            updated_at = NOW()
        WHERE id = ANY(${duplicateIds})
      `.catch(() => {});

      duplicates.forEach(d => processed.add(d.id));
      mergeCount += duplicates.length;
    }

    processed.add(itemA.id);
  }

  return mergeCount;
}

// Archive stale backlog items
async function archiveStaleItems(sql: ReturnType<typeof getDb>): Promise<number> {
  const result = await sql`
    UPDATE hive_backlog
    SET status = 'archived',
        notes = COALESCE(notes, '') || ' | Auto-archived: stale (90+ days old)',
        updated_at = NOW()
    WHERE status NOT IN ('done', 'archived', 'cancelled')
    AND created_at < NOW() - INTERVAL '${STALENESS_DAYS} days'
    AND priority IN ('P2', 'P3')  -- Don't auto-archive critical items
  `.catch(() => ({ count: 0 }));

  return result.count || 0;
}

// Check if item meets concreteness requirements
function checkConcreteness(item: { title: string; description: string }): { concrete: boolean; reason?: string } {
  const allText = `${item.title} ${item.description}`;

  // Must reference specific files/paths
  const hasSpecificFile = /\b(src\/|\.ts|\.tsx|\.yml|\.json|route\.ts|page\.tsx|\.md|\.js|\.css)\b/.test(allText);

  // Must have actionable verbs
  const hasActionableVerb = /\b(add|remove|change|update|fix|replace|create|delete|move|rename|insert|wrap|extract|implement|refactor|optimize)\b/i.test(allText);

  // Must be long enough (not too vague)
  const isLongEnough = allText.length >= 80;

  // Must not be too generic
  const isNotTooGeneric = !/\b(improve|enhance|better|optimize|clean|refactor)\b/.test(allText) || hasSpecificFile;

  if (!hasSpecificFile) {
    return { concrete: false, reason: "No specific files/paths mentioned" };
  }
  if (!hasActionableVerb) {
    return { concrete: false, reason: "No actionable verbs (add, fix, create, etc.)" };
  }
  if (!isLongEnough) {
    return { concrete: false, reason: "Description too short/vague (< 80 chars)" };
  }
  if (!isNotTooGeneric) {
    return { concrete: false, reason: "Too generic - needs specific implementation details" };
  }

  return { concrete: true };
}

// Main backlog health check function
export async function performBacklogHealthCheck(): Promise<BacklogHealthCheckResult> {
  const sql = getDb();
  const violations: string[] = [];
  const actions_taken: string[] = [];

  try {
    // Get current counts
    const [stats] = await sql`
      SELECT
        COUNT(*) as total_items,
        COUNT(*) FILTER (WHERE status NOT IN ('done', 'archived', 'cancelled')) as active_items
      FROM hive_backlog
    `.catch(() => [{ total_items: 0, active_items: 0 }]);

    const total_items = Number(stats.total_items);
    const active_items = Number(stats.active_items);

    // 1. Volume cap check
    if (total_items > MAX_TOTAL_ITEMS) {
      violations.push(`Total items (${total_items}) exceeds maximum (${MAX_TOTAL_ITEMS})`);
    }
    if (active_items > MAX_ACTIVE_ITEMS) {
      violations.push(`Active items (${active_items}) exceeds maximum (${MAX_ACTIVE_ITEMS})`);
    }

    // 2. Archive stale items
    const stale_archived = await archiveStaleItems(sql);
    if (stale_archived > 0) {
      actions_taken.push(`Archived ${stale_archived} stale items (90+ days old)`);
    }

    // 3. Deduplicate items
    const duplicates_merged = await deduplicateBacklogItems(sql);
    if (duplicates_merged > 0) {
      actions_taken.push(`Merged ${duplicates_merged} duplicate items`);
    }

    // 4. Detect circular references
    const { flagged: circularItems, count: circular_flagged } = await detectCircularReferences(sql);
    if (circular_flagged > 0) {
      violations.push(`${circular_flagged} items have circular dependencies`);

      // Flag circular items for manual review
      if (circularItems.length > 0) {
        await sql`
          UPDATE hive_backlog
          SET notes = COALESCE(notes, '') || ' | ⚠️ CIRCULAR DEPENDENCY DETECTED - needs manual review',
              priority = 'P3'  -- Deprioritize until resolved
          WHERE id = ANY(${circularItems})
        `.catch(() => {});

        actions_taken.push(`Flagged ${circularItems.length} items with circular dependencies`);
      }
    }

    // 5. Concreteness gate - flag vague items
    const vague_items = await sql`
      SELECT id, title, description
      FROM hive_backlog
      WHERE status = 'proposed'
      AND (notes IS NULL OR notes NOT LIKE '%VAGUE%')
    `.catch(() => []);

    let vague_flagged = 0;
    for (const item of vague_items) {
      const { concrete, reason } = checkConcreteness(item);
      if (!concrete) {
        await sql`
          UPDATE hive_backlog
          SET notes = COALESCE(notes, '') || ${` | ⚠️ VAGUE: ${reason}`},
              priority = 'P3'
          WHERE id = ${item.id}
        `.catch(() => {});
        vague_flagged++;
      }
    }

    if (vague_flagged > 0) {
      violations.push(`${vague_flagged} items are too vague/generic`);
      actions_taken.push(`Flagged ${vague_flagged} vague items for clarification`);
    }

    // Final health assessment
    const healthy = violations.length === 0;

    return {
      healthy,
      violations,
      actions_taken,
      total_items,
      active_items: active_items - stale_archived, // Updated count after archiving
      stale_archived,
      duplicates_merged,
      circular_flagged,
    };

  } catch (error) {
    console.error("[backlog-health] Health check failed:", error);
    return {
      healthy: false,
      violations: [`Health check failed: ${error instanceof Error ? error.message : String(error)}`],
      actions_taken: [],
      total_items: 0,
      active_items: 0,
      stale_archived: 0,
      duplicates_merged: 0,
      circular_flagged: 0,
    };
  }
}

// Check if backlog is healthy before allowing new dispatches
export async function isBacklogHealthy(): Promise<boolean> {
  const result = await performBacklogHealthCheck();
  return result.healthy;
}