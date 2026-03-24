import { getDb, json, err } from "@/lib/db";

export const dynamic = "force-dynamic";

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
    const review = ceo_review.review;

    if (!review) {
      return err("ceo_review must contain a 'review' object for CEO reviews", 400);
    }

    // Required fields for a complete CEO review
    const requiredFields = ['score', 'agent_grades', 'kill_flag', 'validation_phase'];
    const missingFields = requiredFields.filter(field => review[field] === undefined);

    if (missingFields.length > 0) {
      return err(`Incomplete CEO review: missing required fields: ${missingFields.join(', ')}`, 400);
    }

    // Validate score is a number between 1-10
    if (typeof review.score !== 'number' || review.score < 1 || review.score > 10) {
      return err("CEO review score must be a number between 1 and 10", 400);
    }

    // Validate agent_grades is an object
    if (typeof review.agent_grades !== 'object' || review.agent_grades === null) {
      return err("CEO review agent_grades must be an object", 400);
    }

    // Validate kill_flag is a boolean
    if (typeof review.kill_flag !== 'boolean') {
      return err("CEO review kill_flag must be a boolean", 400);
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