import { getDb, json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

export async function GET(req: Request) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const { searchParams } = new URL(req.url);
  const domain = searchParams.get("domain");

  const sql = getDb();
  const playbook = domain
    ? await sql`
        SELECT p.*, c.name as source_company FROM playbook p 
        LEFT JOIN companies c ON c.id = p.source_company_id
        WHERE p.domain = ${domain} AND p.superseded_by IS NULL
        ORDER BY p.confidence DESC
      `
    : await sql`
        SELECT p.*, c.name as source_company FROM playbook p
        LEFT JOIN companies c ON c.id = p.source_company_id
        WHERE p.superseded_by IS NULL
        ORDER BY p.confidence DESC LIMIT 50
      `;
  return json(playbook);
}

export async function POST(req: Request) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const body = await req.json();
  const { source_company_id, domain, insight, evidence, confidence } = body;
  if (!domain || !insight) return err("domain and insight required");

  const sql = getDb();
  const [entry] = await sql`
    INSERT INTO playbook (source_company_id, domain, insight, evidence, confidence)
    VALUES (${source_company_id || null}, ${domain}, ${insight}, ${evidence ? JSON.stringify(evidence) : null}, ${confidence || 0.5})
    RETURNING *
  `;
  return json(entry, 201);
}
