import { getDb, json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

// GET /api/backlog — list Hive self-improvement backlog items
export async function GET(req: Request) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status"); // ready, dispatched, done, all
  const priority = searchParams.get("priority"); // P0, P1, P2, P3

  const sql = getDb();
  let items;

  if (status === "all") {
    items = await sql`
      SELECT * FROM hive_backlog
      ${priority ? sql`WHERE priority = ${priority}` : sql``}
      ORDER BY
        CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,
        created_at ASC
      LIMIT 100
    `;
  } else {
    const filterStatus = status || "ready";
    items = await sql`
      SELECT * FROM hive_backlog
      WHERE status = ${filterStatus}
      ${priority ? sql`AND priority = ${priority}` : sql``}
      ORDER BY
        CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,
        created_at ASC
      LIMIT 100
    `;
  }

  return json(items);
}

// POST /api/backlog — add a new backlog item
export async function POST(req: Request) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const body = await req.json();
  const { priority, title, description, category, source } = body;

  if (!title || !description) {
    return err("title and description are required");
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
    INSERT INTO hive_backlog (priority, title, description, category, source)
    VALUES (
      ${priority || "P2"},
      ${title},
      ${description},
      ${category || "feature"},
      ${source || "brainstorm"}
    )
    RETURNING *
  `;

  return json(item, 201);
}
