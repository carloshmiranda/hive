import { getDb, json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { setSentryTags } from "@/lib/sentry-tags";

export async function GET(req: Request) {
  setSentryTags({
    action_type: "admin",
    route: "/api/cycles",
  });

  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("company_id");
  const limit = parseInt(searchParams.get("limit") || "20");

  const sql = getDb();
  const cycles = companyId
    ? await sql`SELECT * FROM cycles WHERE company_id = ${companyId} ORDER BY cycle_number DESC LIMIT ${limit}`
    : await sql`SELECT c.*, co.name as company_name, co.slug as company_slug FROM cycles c JOIN companies co ON co.id = c.company_id ORDER BY c.started_at DESC LIMIT ${limit}`;

  return json(cycles);
}

export async function POST(req: Request) {
  setSentryTags({
    action_type: "admin",
    route: "/api/cycles",
  });

  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const body = await req.json();
  const { company_id, cycle_number } = body;
  if (!company_id || !cycle_number) return err("company_id and cycle_number required");

  const sql = getDb();
  const [cycle] = await sql`
    INSERT INTO cycles (company_id, cycle_number, status)
    VALUES (${company_id}, ${cycle_number}, 'running')
    RETURNING *
  `;
  return json(cycle, 201);
}
