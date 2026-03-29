import type { getDb } from "@/lib/db";

/**
 * Work Stealing with Contest Windows
 *
 * Rules:
 * 1. After 2 agent failures on a task, mark it stealable
 * 2. Next available dispatch can grab it
 * 3. 10-min grace period after claiming
 * 4. Tasks >75% complete are protected
 * 5. 5-min contest window if original agent wants to reclaim
 */

export const FAILURE_THRESHOLD = 2;
export const GRACE_PERIOD_MINUTES = 10;
export const PROTECTION_THRESHOLD = 75; // percentage
export const CONTEST_WINDOW_MINUTES = 5;

interface StealableTask {
  id: string;
  title: string;
  failure_count: number;
  completion_percentage: number;
  claimed_by: string | null;
  claimed_at: string | null;
  contest_window_until: string | null;
}

/**
 * Mark a task as stealable if it meets failure criteria
 */
export async function markTaskStealableOnFailure(
  sql: ReturnType<typeof getDb>,
  taskId: string,
  currentAgent: string
): Promise<boolean> {
  try {
    const [task] = await sql`
      SELECT id, failure_count, completion_percentage, is_stealable
      FROM hive_backlog
      WHERE id = ${taskId}
    `;

    if (!task) return false;

    // Don't make protected tasks stealable (>75% complete)
    if (task.completion_percentage > PROTECTION_THRESHOLD) {
      return false;
    }

    // Increment failure count
    const newFailureCount = task.failure_count + 1;

    // Mark as stealable if threshold reached
    const shouldMarkStealable = newFailureCount >= FAILURE_THRESHOLD;

    await sql`
      UPDATE hive_backlog
      SET
        failure_count = ${newFailureCount},
        is_stealable = ${shouldMarkStealable},
        updated_at = NOW()
      WHERE id = ${taskId}
    `;

    if (shouldMarkStealable) {
      console.log(`[work-stealing] Task ${taskId} marked stealable after ${newFailureCount} failures`);
    }

    return shouldMarkStealable;
  } catch (error) {
    console.error(`[work-stealing] Error marking task ${taskId} stealable:`, error);
    return false;
  }
}

/**
 * Claim a stealable task for work stealing
 */
export async function claimStealableTask(
  sql: ReturnType<typeof getDb>,
  taskId: string,
  claimingAgent: string
): Promise<{ success: boolean; reason?: string }> {
  try {
    // Check if task is available for claiming
    const [task] = await sql`
      SELECT id, is_stealable, claimed_by, claimed_at, completion_percentage,
             contest_window_until
      FROM hive_backlog
      WHERE id = ${taskId} AND status IN ('ready', 'approved')
    `;

    if (!task) {
      return { success: false, reason: "Task not found or not in claimable status" };
    }

    if (!task.is_stealable) {
      return { success: false, reason: "Task is not marked as stealable" };
    }

    if (task.completion_percentage > PROTECTION_THRESHOLD) {
      return { success: false, reason: "Task is protected (>75% complete)" };
    }

    // Check if already claimed and grace period hasn't expired
    if (task.claimed_by && task.claimed_at) {
      const claimedAt = new Date(task.claimed_at);
      const graceExpiry = new Date(claimedAt.getTime() + GRACE_PERIOD_MINUTES * 60 * 1000);

      if (new Date() < graceExpiry) {
        return { success: false, reason: "Task still in grace period" };
      }
    }

    // Check contest window (original agent can reclaim)
    if (task.contest_window_until && new Date() < new Date(task.contest_window_until)) {
      return { success: false, reason: "Task in contest window for original agent" };
    }

    // Claim the task
    const contestWindowUntil = new Date(Date.now() + CONTEST_WINDOW_MINUTES * 60 * 1000);

    await sql`
      UPDATE hive_backlog
      SET
        claimed_by = ${claimingAgent},
        claimed_at = NOW(),
        contest_window_until = ${contestWindowUntil.toISOString()},
        updated_at = NOW()
      WHERE id = ${taskId}
    `;

    console.log(`[work-stealing] Task ${taskId} claimed by ${claimingAgent}`);
    return { success: true };
  } catch (error) {
    console.error(`[work-stealing] Error claiming task ${taskId}:`, error);
    return { success: false, reason: "Database error" };
  }
}

/**
 * Get available stealable tasks for an agent
 */
export async function getAvailableStealableTasks(
  sql: ReturnType<typeof getDb>,
  requestingAgent: string,
  limit: number = 5
): Promise<StealableTask[]> {
  try {
    const tasks = await sql`
      SELECT id, title, failure_count, completion_percentage,
             claimed_by, claimed_at, contest_window_until
      FROM hive_backlog
      WHERE is_stealable = true
        AND status IN ('ready', 'approved')
        AND completion_percentage <= ${PROTECTION_THRESHOLD}
        AND (
          claimed_by IS NULL
          OR claimed_at < NOW() - INTERVAL '${GRACE_PERIOD_MINUTES} minutes'
          OR (contest_window_until IS NOT NULL AND contest_window_until < NOW())
        )
      ORDER BY
        CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,
        failure_count DESC,
        created_at ASC
      LIMIT ${limit}
    `;

    return tasks as StealableTask[];
  } catch (error) {
    console.error(`[work-stealing] Error fetching stealable tasks:`, error);
    return [];
  }
}

/**
 * Update completion percentage for a task
 */
export async function updateTaskCompletion(
  sql: ReturnType<typeof getDb>,
  taskId: string,
  percentage: number
): Promise<boolean> {
  try {
    if (percentage < 0 || percentage > 100) {
      throw new Error("Completion percentage must be between 0 and 100");
    }

    await sql`
      UPDATE hive_backlog
      SET
        completion_percentage = ${percentage},
        updated_at = NOW()
      WHERE id = ${taskId}
    `;

    return true;
  } catch (error) {
    console.error(`[work-stealing] Error updating completion for task ${taskId}:`, error);
    return false;
  }
}

/**
 * Allow original agent to reclaim task during contest window
 */
export async function reclaimTask(
  sql: ReturnType<typeof getDb>,
  taskId: string,
  originalAgent: string
): Promise<{ success: boolean; reason?: string }> {
  try {
    const [task] = await sql`
      SELECT id, claimed_by, contest_window_until, is_stealable
      FROM hive_backlog
      WHERE id = ${taskId}
    `;

    if (!task) {
      return { success: false, reason: "Task not found" };
    }

    if (!task.is_stealable || !task.contest_window_until) {
      return { success: false, reason: "Task not in contest window" };
    }

    if (new Date() > new Date(task.contest_window_until)) {
      return { success: false, reason: "Contest window expired" };
    }

    // Reclaim the task
    await sql`
      UPDATE hive_backlog
      SET
        claimed_by = ${originalAgent},
        claimed_at = NOW(),
        contest_window_until = NULL,
        updated_at = NOW()
      WHERE id = ${taskId}
    `;

    console.log(`[work-stealing] Task ${taskId} reclaimed by original agent ${originalAgent}`);
    return { success: true };
  } catch (error) {
    console.error(`[work-stealing] Error reclaiming task ${taskId}:`, error);
    return { success: false, reason: "Database error" };
  }
}

/**
 * Reset work stealing state when task completes successfully
 */
export async function resetTaskStealingState(
  sql: ReturnType<typeof getDb>,
  taskId: string
): Promise<boolean> {
  try {
    await sql`
      UPDATE hive_backlog
      SET
        failure_count = 0,
        is_stealable = false,
        claimed_by = NULL,
        claimed_at = NULL,
        contest_window_until = NULL,
        updated_at = NOW()
      WHERE id = ${taskId}
    `;

    return true;
  } catch (error) {
    console.error(`[work-stealing] Error resetting stealing state for task ${taskId}:`, error);
    return false;
  }
}