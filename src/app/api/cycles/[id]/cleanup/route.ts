import { getDb, json, err } from "@/lib/db";

export const dynamic = "force-dynamic";

// PATCH /api/cycles/[id]/cleanup
// Updates cycle with cleanup/timeout information (Sentinel-only endpoint)
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return err("Unauthorized", 401);
  }

  const { id } = await params;
  const body = await req.json();
  const { cleanup_reason, status } = body;

  if (!cleanup_reason) {
    return err("cleanup_reason is required", 400);
  }

  const sql = getDb();

  try {
    const [cycle] = await sql`
      UPDATE cycles SET
        ceo_review = CASE
          WHEN ceo_review IS NULL THEN ${JSON.stringify({ cycle_cleanup: cleanup_reason })}
          ELSE ceo_review || ${JSON.stringify({ cycle_cleanup: cleanup_reason })}
        END,
        status = ${status || 'failed'},
        finished_at = CASE WHEN ${status || 'failed'} IN ('completed', 'failed', 'partial') THEN now() ELSE finished_at END
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
        cleanup_applied: true
      }
    });
  } catch (error: any) {
    return err(`Failed to update cycle: ${error.message}`, 500);
  }
}