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