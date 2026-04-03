import { getDb, json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { uploadIfLarge, isBlobMarker, deleteBlob } from "@/lib/blob-storage";

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
  // Content is JSONB — pass stringified JSON so Neon stores it as JSONB, not as a text string
  const contentStr = typeof content === "string" ? content : JSON.stringify(content);
  const sourcesStr = sources ? (typeof sources === "string" ? sources : JSON.stringify(sources)) : null;

  // If content exceeds 100KB, upload to Vercel Blob and store a marker instead
  const blobUrl = await uploadIfLarge(contentStr, `research/${company_id}/${report_type}`);
  const storedContent = blobUrl ? JSON.stringify({ _blob_url: blobUrl }) : contentStr;

  // If replacing an existing blob, delete the old one to avoid orphans
  const [existing] = await sql`
    SELECT content FROM research_reports WHERE company_id = ${company_id} AND report_type = ${report_type}
  `;
  if (existing && isBlobMarker(existing.content) && blobUrl && existing.content._blob_url !== blobUrl) {
    await deleteBlob(existing.content._blob_url);
  }

  const [report] = await sql`
    INSERT INTO research_reports (company_id, report_type, content, summary, sources)
    VALUES (${company_id}, ${report_type}, ${storedContent}::jsonb, ${summary || null}, ${sourcesStr}::jsonb)
    ON CONFLICT (company_id, report_type) DO UPDATE SET
      content = ${storedContent}::jsonb,
      summary = ${summary || null},
      sources = ${sourcesStr}::jsonb,
      updated_at = now()
    RETURNING *
  `;

  return json(report, 201);
}
