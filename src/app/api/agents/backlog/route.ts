import { NextRequest } from "next/server";
import { validateOIDC } from "@/lib/oidc";
import { getDb, json, err } from "@/lib/db";
import { setSentryTags } from "@/lib/sentry-tags";

// POST /api/agents/backlog — create a new backlog item (OIDC auth)
// Body: { title, description, priority?, source?, theme?, company_id? }
export async function POST(req: NextRequest) {
  setSentryTags({
    action_type: "agent_api",
    route: "/api/agents/backlog",
  });

  const claims = await validateOIDC(req);
  if (claims instanceof Response) return claims;

  let body;
  try {
    body = await req.json();
  } catch {
    return err("Invalid JSON body", 400);
  }

  const { title, description, priority, source, theme, company_id } = body;
  if (!title || !description) {
    return err("title and description are required", 400);
  }

  // Add company_id tag to Sentry if present
  if (company_id) {
    setSentryTags({ company_id });
  }

  const sql = getDb();

  // Dedup: don't create if a similar item already exists (ready/approved/dispatched/in_progress)
  const [existing] = await sql`
    SELECT id, title, status FROM hive_backlog
    WHERE status IN ('ready', 'approved', 'dispatched', 'in_progress')
    AND title ILIKE ${title.slice(0, 50) + "%"}
    LIMIT 1
  `;
  if (existing) {
    return json({ duplicate: true, existing_id: existing.id, existing_status: existing.status }, 409);
  }

  const [item] = await sql`
    INSERT INTO hive_backlog (priority, title, description, source, theme, company_id)
    VALUES (
      ${priority || "P2"},
      ${title},
      ${description},
      ${source || "agent"},
      ${theme || null},
      ${company_id || null}
    )
    RETURNING *
  `;

  // Fire-and-forget GitHub Issue creation
  import("@/lib/github-issues")
    .then(({ createBacklogIssue }) =>
      createBacklogIssue({
        id: item.id,
        title: item.title,
        description: item.description || item.title,
        priority: item.priority || "P2",
        category: item.category || "feature",
        theme: item.theme || null,
      })
    )
    .then((issue) => {
      if (issue) {
        sql`UPDATE hive_backlog SET github_issue_number = ${issue.number}, github_issue_url = ${issue.url} WHERE id = ${item.id}`.catch(() => {});
      }
    })
    .catch(() => {});

  return json(item, 201);
}

// PATCH /api/agents/backlog?id=<uuid> — update a backlog item (OIDC auth)
// Body: { status?, notes? }
export async function PATCH(req: NextRequest) {
  setSentryTags({
    action_type: "agent_api",
    route: "/api/agents/backlog",
  });

  const claims = await validateOIDC(req);
  if (claims instanceof Response) return claims;

  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return err("Query param 'id' is required", 400);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return err("Invalid JSON body", 400);
  }

  const { status, notes } = body;
  if (!status && !notes) {
    return err("At least one of status or notes is required", 400);
  }

  const sql = getDb();

  // Verify item exists + get github_issue_number for sync
  const [existing] = await sql`
    SELECT id, github_issue_number FROM hive_backlog WHERE id = ${id} LIMIT 1
  `;
  if (!existing) {
    return err("Backlog item not found", 404);
  }

  // Build update: append notes, set status
  let updated;
  if (status && notes) {
    [updated] = await sql`
      UPDATE hive_backlog
      SET status = ${status},
          notes = COALESCE(notes, '') || ${" " + notes},
          updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
  } else if (status) {
    [updated] = await sql`
      UPDATE hive_backlog
      SET status = ${status},
          updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
  } else {
    [updated] = await sql`
      UPDATE hive_backlog
      SET notes = COALESCE(notes, '') || ${" " + notes},
          updated_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `;
  }

  // Sync status change to GitHub Issue
  if (status && existing.github_issue_number) {
    import("@/lib/github-issues")
      .then(({ syncBacklogStatus }) => syncBacklogStatus(existing.github_issue_number, status))
      .catch(() => {});
  }

  return json(updated);
}
