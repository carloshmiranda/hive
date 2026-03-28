import { NextRequest } from "next/server";
import { getDb, json, err } from "@/lib/db";
import { setSentryTags } from "@/lib/sentry-tags";

// Returns active company slugs — used by GitHub Actions to build dispatch matrix
// Auth: CRON_SECRET bearer token

export async function GET(req: NextRequest) {
  // Set Sentry tags for error triage and filtering
  setSentryTags({
    action_type: "company_list",
    route: "/api/agents/companies"
  });

  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return err("Unauthorized", 401);
  }

  const sql = getDb();
  const companies = await sql`
    SELECT slug, name, status FROM companies 
    WHERE status IN ('mvp', 'active') 
    ORDER BY created_at ASC
  `;

  return json(companies.map((c: any) => c.slug));
}
