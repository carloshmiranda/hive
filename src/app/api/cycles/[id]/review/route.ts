import { getDb, json, err } from "@/lib/db";
import { CeoReviewSchema } from "@/lib/agent-schemas";
import { qstashPublish } from "@/lib/qstash";
import { cacheSet } from "@/lib/redis-cache";

export const dynamic = "force-dynamic";

// Deduplicate CEO PR review proposals - keep most recent, reject older ones
async function deduplicateCeoPrReviewProposals(sql: any) {
  // Find all pending CEO review proposals
  const ceoReviewProposals = await sql`
    SELECT id, title, created_at
    FROM evolver_proposals
    WHERE status = 'pending'
      AND gap_type = 'outcome'
      AND (title ILIKE '%CEO%' AND title ILIKE '%review%')
    ORDER BY created_at DESC
  `;

  if (ceoReviewProposals.length <= 1) {
    return; // No duplicates to handle
  }

  // Group similar proposals (those with overlapping keywords)
  const groups: Array<typeof ceoReviewProposals> = [];
  const processed = new Set<string>();

  for (const proposal of ceoReviewProposals) {
    if (processed.has(proposal.id)) continue;

    const group = [proposal];
    processed.add(proposal.id);

    // Find similar proposals (simple keyword overlap approach)
    const keyWords = proposal.title.toLowerCase().split(/\s+/).filter((w: string) => w.length > 3);

    for (const other of ceoReviewProposals) {
      if (processed.has(other.id)) continue;

      const otherWords = other.title.toLowerCase().split(/\s+/).filter((w: string) => w.length > 3);
      const overlap = keyWords.filter((w: string) => otherWords.includes(w)).length;

      // If significant overlap (>30% of words), consider them duplicates
      if (overlap >= Math.ceil(Math.min(keyWords.length, otherWords.length) * 0.3)) {
        group.push(other);
        processed.add(other.id);
      }
    }

    if (group.length > 1) {
      groups.push(group);
    }
  }

  // For each group, keep the most recent and reject older ones
  for (const group of groups) {
    group.sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    const [keep, ...reject] = group;

    if (reject.length > 0) {
      const rejectIds = reject.map((p: any) => p.id);
      await sql`
        UPDATE evolver_proposals
        SET status = 'rejected',
            reviewed_at = NOW(),
            notes = ${`Deduplicated: keeping most recent proposal ${keep.id} (${keep.title})`}
        WHERE id = ANY(${rejectIds})
      `;
    }
  }
}

// Grade → quality score mapping (before retry penalty)
function gradeToScore(grade: string): number {
  switch (grade.toUpperCase()) {
    case 'A': return 1.0;
    case 'B': return 0.75;
    case 'C': return 0.5;
    case 'F': return 0.0;
    default: return 0.5; // unknown grade → neutral
  }
}

/**
 * Score all actions in a cycle from CEO agent_grades, write quality_score,
 * update routing_weights, and mirror success_rate to Redis.
 * Fire-and-forget from the review endpoint — errors are logged, not surfaced.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function scoreAndLearn(sql: any, cycleId: string, agentGrades: Record<string, unknown>): Promise<string[]> {
  // Fetch all successful actions in this cycle
  const actions = await sql`
    SELECT id, agent, action_type, retry_count
    FROM agent_actions
    WHERE cycle_id = ${cycleId}
      AND status = 'success'
      AND agent NOT IN ('dispatch', 'backlog_dispatch', 'webhook', 'system', 'admin', 'sentinel')
  ` as Array<{ id: string; agent: string; action_type: string; retry_count: number }>;

  if (actions.length === 0) return [];

  const actionIds: string[] = [];

  for (const action of actions) {
    const gradeRaw = agentGrades[action.agent];
    if (!gradeRaw) continue;

    const gradeStr = typeof gradeRaw === 'string'
      ? gradeRaw
      : (gradeRaw as { grade?: string }).grade || '';

    if (!gradeStr) continue;

    const baseScore = gradeToScore(gradeStr);
    const retryPenalty = Math.min((action.retry_count || 0) * 0.1, 0.3);
    const qualityScore = Math.max(0, baseScore - retryPenalty);

    // Write quality score
    await sql`
      UPDATE agent_actions SET quality_score = ${qualityScore} WHERE id = ${action.id}
    `.catch((e: Error) => console.warn(`[review] quality_score write failed for ${action.id}: ${e.message}`));

    actionIds.push(action.id);

    // Update routing_weights — upsert success/failure count
    const isSuccess = qualityScore >= 0.6;
    await sql`
      INSERT INTO routing_weights (task_type, model, agent, successes, failures, last_updated)
      VALUES (${action.action_type}, 'hive', ${action.agent},
        ${isSuccess ? 1 : 0}, ${isSuccess ? 0 : 1}, now())
      ON CONFLICT (task_type, model, agent) DO UPDATE SET
        successes = routing_weights.successes + ${isSuccess ? 1 : 0},
        failures  = routing_weights.failures  + ${isSuccess ? 0 : 1},
        last_updated = now()
      RETURNING task_type, agent, success_rate
    `.then(async (rows: Array<{ task_type: string; agent: string; success_rate: number }>) => {
      // Mirror success_rate to Redis sorted set routing:{task_type}:{agent}
      // TTL 30min — warm reads for dispatcher, falls through to Neon on miss
      const row = rows[0];
      if (row) {
        await cacheSet(
          `routing:${row.task_type}:${row.agent}`,
          String(row.success_rate),
          1800
        ).catch(() => {});
      }
    }).catch((e: Error) => console.warn(`[review] routing_weights upsert failed for ${action.agent}:${action.action_type}: ${e.message}`));
  }

  return actionIds;
}

// PATCH /api/cycles/[id]/review
// Updates cycle with CEO review data (agent-authorized endpoint)
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return err("Unauthorized", 401);
  }

  const { id } = await params;
  const body = await req.json();
  const { ceo_review, status } = body;

  if (!ceo_review) {
    return err("ceo_review is required", 400);
  }

  // Validate CEO review structure for actual reviews (not cleanup operations)
  // Allow timeout cleanup operations (which have timeout_reason field)
  if (!ceo_review.timeout_reason && !ceo_review.cycle_cleanup) {
    if (!ceo_review.review) {
      return err("ceo_review must contain a 'review' object for CEO reviews", 400);
    }

    const parsed = CeoReviewSchema.safeParse(ceo_review.review);
    if (!parsed.success) {
      const issues = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
      return err(`Invalid CEO review structure: ${issues}`, 400);
    }
  }

  const sql = getDb();

  try {
    const [cycle] = await sql`
      UPDATE cycles SET
        ceo_review = ${JSON.stringify(ceo_review)},
        status = ${status || 'completed'},
        finished_at = CASE WHEN ${status || 'completed'} IN ('completed', 'failed', 'partial') THEN now() ELSE finished_at END
      WHERE id = ${id}
      RETURNING *
    `;

    if (!cycle) {
      return err("Cycle not found", 404);
    }

    // Deduplicate CEO PR review proposals - keep most recent, reject older ones
    await deduplicateCeoPrReviewProposals(sql);

    // Quality scoring: score actions, update routing_weights, mirror to Redis
    // Fire-and-forget — errors don't block the review response
    const agentGrades = ceo_review?.review?.agent_grades as Record<string, unknown> | undefined;
    let actionIds: string[] = [];
    if (agentGrades && typeof agentGrades === 'object') {
      actionIds = await scoreAndLearn(sql, id, agentGrades).catch((e: Error) => {
        console.warn(`[review] scoreAndLearn failed: ${e.message}`);
        return [];
      });
    }

    // Distillation: publish QStash message to extract patterns from high-quality actions
    if (actionIds.length > 0) {
      await qstashPublish("/api/distill/trajectory", {
        cycle_id: id,
        action_ids: actionIds,
      }, {
        retries: 2,
        deduplicationId: `distill-${id}`,
      }).catch((e: Error) => console.warn(`[review] distillation QStash publish failed: ${e.message}`));
    }

    return json({
      ok: true,
      cycle: {
        id: cycle.id,
        status: cycle.status,
        finished_at: cycle.finished_at,
        ceo_review_saved: true,
        scored_actions: actionIds.length,
      }
    });
  } catch (error: any) {
    return err(`Failed to update cycle: ${error.message}`, 500);
  }
}