import { getDb, json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

// PATCH /api/backlog/:id — update a backlog item
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const { id } = await params;
  const body = await req.json();
  const { status, priority, notes, pr_number, pr_url } = body;

  const sql = getDb();

  const updates: string[] = [];
  const values: Record<string, unknown> = {};

  if (status) {
    values.status = status;
    if (status === "dispatched") values.dispatched_at = new Date().toISOString();
    if (status === "done") values.completed_at = new Date().toISOString();
  }
  if (priority) values.priority = priority;
  if (notes !== undefined) values.notes = notes;
  if (pr_number) values.pr_number = pr_number;
  if (pr_url) values.pr_url = pr_url;

  // Build dynamic update
  const [item] = await sql`
    UPDATE hive_backlog SET
      status = COALESCE(${values.status || null}, status),
      priority = COALESCE(${values.priority || null}, priority),
      notes = COALESCE(${values.notes !== undefined ? values.notes : null}, notes),
      pr_number = COALESCE(${values.pr_number || null}, pr_number),
      pr_url = COALESCE(${values.pr_url || null}, pr_url),
      dispatched_at = COALESCE(${values.dispatched_at || null}::timestamptz, dispatched_at),
      completed_at = COALESCE(${values.completed_at || null}::timestamptz, completed_at)
    WHERE id = ${id}
    RETURNING *
  `;

  if (!item) return err("Backlog item not found", 404);

  // Sync GitHub Issue status (fire-and-forget)
  if (status && item.github_issue_number) {
    import("@/lib/github-issues")
      .then(({ syncBacklogStatus }) => syncBacklogStatus(item.github_issue_number, status))
      .catch(() => {});
  }

  return json(item);
}

// DELETE /api/backlog/:id — remove a backlog item
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const { id } = await params;
  const sql = getDb();

  const [item] = await sql`
    DELETE FROM hive_backlog WHERE id = ${id} RETURNING id
  `;

  if (!item) return err("Backlog item not found", 404);
  return json({ deleted: true, id: item.id });
}
