import { getDb } from "@/lib/db";

/**
 * Work Stealing Implementation for Failed Tasks
 *
 * After 2 agent failures on a task:
 * 1. Mark it as stealable
 * 2. Any available agent can claim it
 * 3. 10-min grace period after claiming
 * 4. Tasks >75% complete are protected
 * 5. 5-min contest window if original agent wants to reclaim
 */

export interface StealableTask {
  id: string;
  title: string;
  description: string;
  priority: string;
  category: string;
  failure_count: number;
  completion_percentage: number;
  claimed_by: string | null;
  claimed_at: Date | null;
  original_agent: string | null;
  dispatched_at: Date | null;
}

export interface WorkStealingResult {
  task: StealableTask | null;
  reason: string;
  contested?: boolean;
}

/**
 * Mark a task as stealable after failures
 */
export async function markTaskAsStealable(
  sql: ReturnType<typeof getDb>,
  taskId: string,
  failingAgent: string
): Promise<void> {
  await sql`
    UPDATE hive_backlog
    SET
      stealable = true,
      failure_count = failure_count + 1,
      original_agent = COALESCE(original_agent, ${failingAgent}),
      status = 'ready',
      claimed_by = NULL,
      claimed_at = NULL,
      dispatched_at = NULL
    WHERE id = ${taskId}
      AND failure_count >= 1  -- becomes stealable after 2nd failure (1 previous + this failure)
  `;
}

/**
 * Find and claim a stealable task for an agent
 */
export async function claimStealableTask(
  sql: ReturnType<typeof getDb>,
  claimingAgent: string = 'engineer'
): Promise<WorkStealingResult> {
  // First, clean up expired claims (10-min grace period)
  await sql`
    UPDATE hive_backlog
    SET
      claimed_by = NULL,
      claimed_at = NULL,
      status = 'ready'
    WHERE stealable = true
      AND claimed_by IS NOT NULL
      AND claimed_at < NOW() - INTERVAL '10 minutes'
  `;

  // Look for unclaimed stealable tasks (not protected by >75% completion)
  const [stealableTask] = await sql`
    SELECT
      id, title, description, priority, category,
      failure_count, completion_percentage, claimed_by, claimed_at,
      original_agent, dispatched_at
    FROM hive_backlog
    WHERE stealable = true
      AND status = 'ready'
      AND claimed_by IS NULL
      AND completion_percentage < 75  -- protect near-complete tasks
    ORDER BY priority, failure_count DESC, created_at ASC
    LIMIT 1
  ` as StealableTask[];

  if (!stealableTask) {
    return { task: null, reason: "no_stealable_tasks" };
  }

  // Check if this is a contest scenario (original agent trying to reclaim within 5 minutes)
  const isOriginalAgent = stealableTask.original_agent === claimingAgent;
  const recentFailure = stealableTask.dispatched_at &&
    new Date().getTime() - new Date(stealableTask.dispatched_at).getTime() < 5 * 60 * 1000;

  if (isOriginalAgent && recentFailure) {
    // Contest window: original agent gets priority
    await sql`
      UPDATE hive_backlog
      SET
        claimed_by = ${claimingAgent},
        claimed_at = NOW(),
        status = 'dispatched'
      WHERE id = ${stealableTask.id}
    `;

    return {
      task: { ...stealableTask, claimed_by: claimingAgent, claimed_at: new Date() },
      reason: "reclaimed_in_contest_window",
      contested: true
    };
  }

  // Normal claim
  await sql`
    UPDATE hive_backlog
    SET
      claimed_by = ${claimingAgent},
      claimed_at = NOW(),
      status = 'dispatched'
    WHERE id = ${stealableTask.id}
      AND claimed_by IS NULL  -- prevent race conditions
  `;

  // Verify the claim was successful (another agent might have claimed it simultaneously)
  const [claimedTask] = await sql`
    SELECT
      id, title, description, priority, category,
      failure_count, completion_percentage, claimed_by, claimed_at,
      original_agent, dispatched_at
    FROM hive_backlog
    WHERE id = ${stealableTask.id}
      AND claimed_by = ${claimingAgent}
  ` as StealableTask[];

  if (!claimedTask) {
    return { task: null, reason: "claim_race_condition" };
  }

  return {
    task: claimedTask,
    reason: "successfully_claimed"
  };
}

/**
 * Update completion percentage for a task (for 75% protection)
 */
export async function updateTaskCompletion(
  sql: ReturnType<typeof getDb>,
  taskId: string,
  percentage: number
): Promise<void> {
  if (percentage < 0 || percentage > 100) {
    throw new Error("Completion percentage must be between 0 and 100");
  }

  await sql`
    UPDATE hive_backlog
    SET completion_percentage = ${percentage}
    WHERE id = ${taskId}
  `;
}

/**
 * Check if a task should be marked as stealable (after 2 failures)
 */
export async function checkStealableCondition(
  sql: ReturnType<typeof getDb>,
  taskId: string
): Promise<boolean> {
  const [task] = await sql`
    SELECT failure_count, completion_percentage, stealable
    FROM hive_backlog
    WHERE id = ${taskId}
  ` as { failure_count: number; completion_percentage: number; stealable: boolean }[];

  if (!task) return false;

  // Already stealable
  if (task.stealable) return true;

  // Should become stealable after 2 failures and not >75% complete
  return task.failure_count >= 2 && task.completion_percentage < 75;
}

/**
 * Get statistics about work stealing activity
 */
export async function getWorkStealingStats(
  sql: ReturnType<typeof getDb>
): Promise<{
  stealableTasks: number;
  claimedTasks: number;
  protectedTasks: number;
  contestableReclaims: number;
}> {
  const [stats] = await sql`
    SELECT
      COUNT(CASE WHEN stealable = true AND claimed_by IS NULL THEN 1 END) as stealable_tasks,
      COUNT(CASE WHEN stealable = true AND claimed_by IS NOT NULL THEN 1 END) as claimed_tasks,
      COUNT(CASE WHEN stealable = true AND completion_percentage >= 75 THEN 1 END) as protected_tasks,
      COUNT(CASE WHEN
        stealable = true
        AND original_agent IS NOT NULL
        AND dispatched_at > NOW() - INTERVAL '5 minutes'
      THEN 1 END) as contestable_reclaims
    FROM hive_backlog
    WHERE stealable = true
  ` as any[];

  return {
    stealableTasks: parseInt(stats.stealable_tasks || 0),
    claimedTasks: parseInt(stats.claimed_tasks || 0),
    protectedTasks: parseInt(stats.protected_tasks || 0),
    contestableReclaims: parseInt(stats.contestable_reclaims || 0)
  };
}