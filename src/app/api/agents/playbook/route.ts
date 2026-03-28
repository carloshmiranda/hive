import { NextRequest } from "next/server";
import { validateOIDC } from "@/lib/oidc";
import { getDb, json, err } from "@/lib/db";
import { invalidatePlaybook } from "@/lib/redis-cache";

// POST /api/agents/playbook — write playbook entry via OIDC auth
// Body: { domain, insight, evidence?, confidence? }
export async function POST(req: NextRequest) {
  const claims = await validateOIDC(req);
  if (claims instanceof Response) return claims;

  let body;
  try {
    body = await req.json();
  } catch {
    return err("Invalid JSON body", 400);
  }

  const { source_company_id, domain, insight, evidence, confidence, content_language } = body;
  if (!domain || !insight) {
    return err("Missing required fields: domain, insight", 400);
  }

  const sql = getDb();

  // Deduplicate: skip if same domain + similar insight already exists for this company
  const [existing] = await sql`
    SELECT id FROM playbook
    WHERE domain = ${domain}
      AND (source_company_id = ${source_company_id || null} OR source_company_id IS NULL)
      AND insight = ${insight}
    LIMIT 1
  `.catch(() => []);

  if (existing) {
    return json({ id: existing.id, deduplicated: true });
  }

  const [entry] = await sql`
    INSERT INTO playbook (source_company_id, domain, insight, evidence, confidence, content_language)
    VALUES (${source_company_id || null}, ${domain}, ${insight}, ${evidence || null}, ${confidence ?? 0.7}, ${content_language || null})
    RETURNING id, domain, insight, confidence, content_language
  `;

  await invalidatePlaybook();
  return json(entry, 201);
}
