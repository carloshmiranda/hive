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

  const valid = ["approved", "in_progress", "done", "dismissed", "cancelled"];
  if (!valid.includes(status)) {
    return err(`Invalid status '${status}'. Must be one of: ${valid.join(", ")}`, 400);
  }

  const sql = getDb();

  const [task] = await sql`
    UPDATE company_tasks SET
      status = ${status},
      updated_at = NOW()
    WHERE id = ${id}
    RETURNING id, title, status, company_id, github_issue_number
  `;

  if (!task) return err("Task not found", 404);

  // Fire-and-forget: close GitHub Issue when task completes
  if (task.github_issue_number && ["done", "dismissed", "cancelled"].includes(status)) {
    const [company] = await sql`SELECT github_repo FROM companies WHERE id = ${task.company_id} LIMIT 1`;
    if (company?.github_repo) {
      import("@/lib/github-issues")
        .then(({ syncCompanyTaskStatus }) =>
          syncCompanyTaskStatus(company.github_repo, task.github_issue_number, status)
        )
        .catch(() => {});
    }
  }

  return json(task);
}
