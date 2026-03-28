import { getDb, json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { setSentryTags } from "@/lib/sentry-tags";

export async function GET(req: Request) {
  // Set Sentry tags for error triage and filtering
  setSentryTags({
    action_type: "approval_list",
    route: "/api/approvals"
  });

  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status") || "pending";
  const companyId = searchParams.get("company_id");

  const sql = getDb();
  let approvals;

  if (companyId && status === "all") {
    approvals = await sql`
      SELECT a.*, c.name as company_name, c.slug as company_slug
      FROM approvals a LEFT JOIN companies c ON c.id = a.company_id
      WHERE (a.company_id = ${companyId} OR a.company_id IS NULL)
      ORDER BY a.created_at DESC LIMIT 50
    `;
  } else if (companyId) {
    approvals = await sql`
      SELECT a.*, c.name as company_name, c.slug as company_slug
      FROM approvals a LEFT JOIN companies c ON c.id = a.company_id
      WHERE a.status = ${status} AND (a.company_id = ${companyId} OR a.company_id IS NULL)
      ORDER BY a.created_at ASC
    `;
  } else {
    approvals = await sql`
      SELECT a.*, c.name as company_name, c.slug as company_slug
      FROM approvals a LEFT JOIN companies c ON c.id = a.company_id
      WHERE a.status = ${status}
      ORDER BY a.created_at ASC
    `;
  }

  return json(approvals);
}

export async function POST(req: Request) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const body = await req.json();
  const { company_id, gate_type, title, description, context } = body;

  if (!gate_type || !title || !description) {
    return err("gate_type, title, and description required");
  }

  const sql = getDb();
  const [approval] = await sql`
    INSERT INTO approvals (company_id, gate_type, title, description, context)
    VALUES (${company_id || null}, ${gate_type}, ${title}, ${description}, ${context ? JSON.stringify(context) : null})
    RETURNING *
  `;

  // Send Telegram notification with approve/reject buttons (fire-and-forget)
  (async () => {
    try {
      const { notifyApproval } = await import("@/lib/telegram");
      let companySlug: string | undefined;
      if (company_id) {
        const [c] = await sql`SELECT slug FROM companies WHERE id = ${company_id}`;
        companySlug = c?.slug;
      }
      await notifyApproval({ id: approval.id, gate_type, title, company: companySlug, details: description });
    } catch { /* Telegram not configured */ }
  })();

  return json(approval, 201);
}
