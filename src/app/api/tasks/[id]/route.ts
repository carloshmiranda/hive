import { NextRequest } from "next/server";
import { getDb, json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { validateOIDC } from "@/lib/oidc";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // Support both session auth (dashboard) and OIDC auth (workflows)
  const session = await requireAuth();
  if (!session) {
    // Try OIDC authentication for workflows
    const oidcClaims = await validateOIDC(req);
    if (oidcClaims instanceof Response) return oidcClaims;
  }

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

  // Sync GitHub Issue status (fire-and-forget)
  if (status && task.github_issue_number) {
    sql`SELECT github_repo FROM companies WHERE id = ${task.company_id}`.then(([company]) => {
      if (!company?.github_repo) return;
      return import("@/lib/github-issues").then(({ syncCompanyTaskStatus }) =>
        syncCompanyTaskStatus(company.github_repo, task.github_issue_number, status)
      );
    }).catch(() => {});
  }

  return json(task);
}
