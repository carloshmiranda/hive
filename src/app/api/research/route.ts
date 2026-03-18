import { getDb, json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

export async function GET(req: Request) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("company_id");
  const reportType = searchParams.get("type");

  const sql = getDb();

  if (companyId && reportType) {
    const [report] = await sql`
      SELECT r.*, c.name as company_name, c.slug as company_slug
      FROM research_reports r JOIN companies c ON c.id = r.company_id
      WHERE r.company_id = ${companyId} AND r.report_type = ${reportType}
    `;
    return json(report || null);
  }

  if (companyId) {
    const reports = await sql`
      SELECT r.*, c.name as company_name, c.slug as company_slug
      FROM research_reports r JOIN companies c ON c.id = r.company_id
      WHERE r.company_id = ${companyId}
      ORDER BY r.created_at DESC
    `;
    return json(reports);
  }

  const reports = await sql`
    SELECT r.*, c.name as company_name, c.slug as company_slug
    FROM research_reports r JOIN companies c ON c.id = r.company_id
    ORDER BY r.created_at DESC LIMIT 50
  `;
  return json(reports);
}

export async function POST(req: Request) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const body = await req.json();
  const { company_id, report_type, content, summary, sources } = body;
  if (!company_id || !report_type || !content) {
    return err("company_id, report_type, and content required");
  }

  const sql = getDb();

  // Upsert: one report per type per company
  const [report] = await sql`
    INSERT INTO research_reports (company_id, report_type, content, summary, sources)
    VALUES (${company_id}, ${report_type}, ${JSON.stringify(content)}, ${summary || null}, ${sources ? JSON.stringify(sources) : null})
    ON CONFLICT (company_id, report_type) DO UPDATE SET
      content = ${JSON.stringify(content)},
      summary = ${summary || null},
      sources = ${sources ? JSON.stringify(sources) : null},
      updated_at = now()
    RETURNING *
  `;

  return json(report, 201);
}
