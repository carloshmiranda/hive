import { getDb, json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const { id } = await params;
  const body = await req.json();
  const { status, priority, cycle_id } = body;

  const sql = getDb();

  if (status) {
    const valid = ["proposed", "approved", "in_progress", "done", "dismissed"];
    if (!valid.includes(status)) return err("Invalid status", 400);
  }

  const [task] = await sql`
    UPDATE company_tasks SET
      status = COALESCE(${status || null}, status),
      priority = COALESCE(${priority ?? null}, priority),
      cycle_id = COALESCE(${cycle_id || null}, cycle_id),
      updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `;

  if (!task) return err("Task not found", 404);
  return json(task);
}
