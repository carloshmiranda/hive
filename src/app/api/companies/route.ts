import { getDb, json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { setSentryTags } from "@/lib/sentry-tags";

export async function GET() {
  setSentryTags({
    action_type: "admin",
    route: "/api/companies",
  });

  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const sql = getDb();
  const companies = await sql`
    SELECT c.*, 
      (SELECT row_to_json(m) FROM metrics m WHERE m.company_id = c.id ORDER BY m.date DESC LIMIT 1) as latest_metrics,
      (SELECT count(*) FROM approvals a WHERE a.company_id = c.id AND a.status = 'pending') as pending_approvals,
      (SELECT coalesce(json_agg(json_build_object('gate_type', a.gate_type, 'title', a.title) ORDER BY a.created_at), '[]'::json) FROM approvals a WHERE a.company_id = c.id AND a.status = 'pending') as pending_approval_details
    FROM companies c
    ORDER BY 
      CASE c.status 
        WHEN 'active' THEN 1 WHEN 'mvp' THEN 2 WHEN 'provisioning' THEN 3 
        WHEN 'approved' THEN 4 WHEN 'idea' THEN 5 WHEN 'paused' THEN 6 WHEN 'killed' THEN 7 
      END,
      c.created_at DESC
  `;
  return json(companies);
}

export async function POST(req: Request) {
  setSentryTags({
    action_type: "admin",
    route: "/api/companies",
  });

  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const body = await req.json();
  const { name, slug, description, status } = body;

  if (!name || !slug) return err("name and slug are required");

  const sql = getDb();
  const [company] = await sql`
    INSERT INTO companies (name, slug, description, status)
    VALUES (${name}, ${slug}, ${description || null}, ${status || "idea"})
    RETURNING *
  `;
  return json(company, 201);
}
