import { getDb, json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const { id } = await params;
  const body = await req.json();
  const sql = getDb();

  const [cycle] = await sql`
    UPDATE cycles SET
      status = COALESCE(${body.status ?? null}, status),
      ceo_plan = COALESCE(${body.ceo_plan ? JSON.stringify(body.ceo_plan) : null}, ceo_plan),
      ceo_review = COALESCE(${body.ceo_review ? JSON.stringify(body.ceo_review) : null}, ceo_review),
      finished_at = CASE WHEN ${body.status ?? null} IN ('completed', 'failed', 'partial') THEN now() ELSE finished_at END
    WHERE id = ${id}
    RETURNING *
  `;
  if (!cycle) return err("Cycle not found", 404);
  return json(cycle);
}
