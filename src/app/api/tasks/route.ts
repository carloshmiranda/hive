import { getDb, json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

export async function GET(req: Request) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("company_id");
  const status = searchParams.get("status");

  const sql = getDb();

  if (companyId) {
    const tasks = status
      ? await sql`
          SELECT t.*, c.slug as company_slug, c.name as company_name
          FROM company_tasks t JOIN companies c ON c.id = t.company_id
          WHERE t.company_id = ${companyId} AND t.status = ${status}
          ORDER BY t.priority ASC, t.created_at DESC
        `
      : await sql`
          SELECT t.*, c.slug as company_slug, c.name as company_name
          FROM company_tasks t JOIN companies c ON c.id = t.company_id
          WHERE t.company_id = ${companyId} AND t.status NOT IN ('done', 'dismissed')
          ORDER BY t.priority ASC, t.created_at DESC
        `;
    return json(tasks);
  }

  // All active tasks across companies
  const tasks = await sql`
    SELECT t.*, c.slug as company_slug, c.name as company_name
    FROM company_tasks t JOIN companies c ON c.id = t.company_id
    WHERE t.status NOT IN ('done', 'dismissed')
    ORDER BY t.priority ASC, t.created_at DESC
    LIMIT 100
  `;
  return json(tasks);
}

export async function POST(req: Request) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const body = await req.json();
  const sql = getDb();

  // Support bulk insert (CEO agent sends array)
  const items = Array.isArray(body) ? body : [body];
  const results = [];

  for (const item of items) {
    const { company_id, category, title, description, priority, source, prerequisites, acceptance } = item;
    if (!company_id || !category || !title || !description) {
      continue;
    }

    // Deduplicate: skip if same company + title exists and is not done/dismissed
    const [existing] = await sql`
      SELECT id FROM company_tasks
      WHERE company_id = ${company_id} AND title = ${title}
      AND status NOT IN ('done', 'dismissed')
    `;
    if (existing) continue;

    const [task] = await sql`
      INSERT INTO company_tasks (company_id, category, title, description, priority, source, prerequisites, acceptance)
      VALUES (
        ${company_id}, ${category}, ${title}, ${description},
        ${priority ?? 2}, ${source || "ceo"},
        ${prerequisites || []}, ${acceptance || null}
      )
      RETURNING *
    `;
    results.push(task);
  }

  return json(results, 201);
}
