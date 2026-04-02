import { getDb, json, err } from "@/lib/db";
import { CeoReviewSchema } from "@/lib/agent-schemas";

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

    return json({
      ok: true,
      cycle: {
        id: cycle.id,
        status: cycle.status,
        finished_at: cycle.finished_at,
        ceo_review_saved: true
      }
    });
  } catch (error: any) {
    return err(`Failed to update cycle: ${error.message}`, 500);
  }
}