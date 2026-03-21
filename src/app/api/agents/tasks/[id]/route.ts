import { NextRequest } from "next/server";
import { validateOIDC } from "@/lib/oidc";
import { getDb, json, err } from "@/lib/db";

// PATCH /api/agents/tasks/:id — update task status via OIDC auth
// Body: { status: "in_progress" | "done" | "approved" }
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const claims = await validateOIDC(req);
  if (claims instanceof Response) return claims;

  const { id } = await params;

  let body;
  try {
    body = await req.json();
  } catch {
    return err("Invalid JSON body", 400);
  }

  const { status } = body;
  if (!status) {
    return err("Missing required field: status", 400);
  }

  const valid = ["approved", "in_progress", "done"];
  if (!valid.includes(status)) {
    return err(`Invalid status '${status}'. Must be one of: ${valid.join(", ")}`, 400);
  }

  const sql = getDb();

  const [task] = await sql`
    UPDATE company_tasks SET
      status = ${status},
      updated_at = NOW()
    WHERE id = ${id}
    RETURNING id, title, status
  `;

  if (!task) return err("Task not found", 404);
  return json(task);
}
