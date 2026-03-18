import { getDb, json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { postToSocial } from "@/lib/social";

export async function GET(req: Request) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("company_id");

  const sql = getDb();
  const accounts = companyId
    ? await sql`
        SELECT sa.*, c.name as company_name, c.slug as company_slug
        FROM social_accounts sa
        JOIN companies c ON c.id = sa.company_id
        WHERE sa.company_id = ${companyId}
        ORDER BY sa.platform ASC
      `
    : await sql`
        SELECT sa.*, c.name as company_name, c.slug as company_slug
        FROM social_accounts sa
        JOIN companies c ON c.id = sa.company_id
        ORDER BY c.slug ASC, sa.platform ASC
      `;

  return json(accounts);
}

// POST: Send a social media post
export async function POST(req: Request) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const body = await req.json();
  const { company_id, platform, text } = body;

  if (!company_id || !platform || !text) {
    return err("company_id, platform, and text required");
  }

  const result = await postToSocial(platform, text, company_id);

  // Log the post attempt
  const sql = getDb();
  await sql`
    INSERT INTO agent_actions (company_id, agent, action_type, description, status, output, started_at, finished_at)
    VALUES (
      ${company_id}, 'growth', 'social_post',
      ${`Posted to ${platform}: ${text.slice(0, 80)}...`},
      ${result.success ? "success" : "failed"},
      ${JSON.stringify(result)},
      now(), now()
    )
  `;

  return json(result, result.success ? 200 : 400);
}
