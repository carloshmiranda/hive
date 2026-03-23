import { getDb, json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { addDomain, getDomains, removeDomain } from "@/lib/vercel";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const { id } = await params;
  const sql = getDb();

  const [company] = await sql`
    SELECT c.slug, c.domain, c.vercel_url, i.resource_id as vercel_project_id
    FROM companies c
    LEFT JOIN infra i ON i.company_id = c.id AND i.service = 'vercel' AND i.status = 'active'
    WHERE c.id = ${id} OR c.slug = ${id}
    LIMIT 1
  `;
  if (!company) return err("Company not found", 404);

  if (!company.vercel_project_id) {
    return json({ domain: company.domain, vercel_domains: [], error: "No Vercel project linked" });
  }

  try {
    const domains = await getDomains(company.vercel_project_id);
    return json({ domain: company.domain, vercel_domains: domains });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "unknown";
    return json({ domain: company.domain, vercel_domains: [], error: msg });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const { id } = await params;
  const body = await req.json();
  const { domain } = body;

  if (!domain || typeof domain !== "string") {
    return err("domain is required");
  }

  const cleaned = domain.toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");

  const sql = getDb();

  const [company] = await sql`
    SELECT c.id, c.slug, i.resource_id as vercel_project_id
    FROM companies c
    LEFT JOIN infra i ON i.company_id = c.id AND i.service = 'vercel' AND i.status = 'active'
    WHERE c.id = ${id} OR c.slug = ${id}
    LIMIT 1
  `;
  if (!company) return err("Company not found", 404);
  if (!company.vercel_project_id) return err("No Vercel project linked", 400);

  try {
    // Add domain to Vercel project
    const result = await addDomain(company.vercel_project_id, cleaned);

    // Update company record
    await sql`UPDATE companies SET domain = ${cleaned}, updated_at = NOW() WHERE id = ${company.id}`;

    return json({
      domain: cleaned,
      vercel_response: result,
      message: `Domain ${cleaned} added to Vercel project. Configure DNS to point to Vercel.`,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "unknown";
    return err(`Failed to add domain: ${msg}`, 500);
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const { id } = await params;
  const sql = getDb();

  const [company] = await sql`
    SELECT c.id, c.slug, c.domain, i.resource_id as vercel_project_id
    FROM companies c
    LEFT JOIN infra i ON i.company_id = c.id AND i.service = 'vercel' AND i.status = 'active'
    WHERE c.id = ${id} OR c.slug = ${id}
    LIMIT 1
  `;
  if (!company) return err("Company not found", 404);
  if (!company.vercel_project_id || !company.domain) return err("No custom domain to remove", 400);

  try {
    await removeDomain(company.vercel_project_id, company.domain);
    await sql`UPDATE companies SET domain = NULL, updated_at = NOW() WHERE id = ${company.id}`;
    return json({ removed: company.domain });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "unknown";
    return err(`Failed to remove domain: ${msg}`, 500);
  }
}
