import { NextRequest } from "next/server";
import { validateOIDC } from "@/lib/oidc";
import { getDb, json, err } from "@/lib/db";

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

  const { domain, insight, evidence, confidence } = body;
  if (!domain || !insight) {
    return err("Missing required fields: domain, insight", 400);
  }

  const sql = getDb();

  // Deduplicate: skip if same domain + insight already exists
  const [existing] = await sql`
    SELECT id FROM playbook
    WHERE domain = ${domain} AND insight = ${insight}
    LIMIT 1
  `.catch(() => []);

  if (existing) {
    return json({ id: existing.id, deduplicated: true });
  }

  const [entry] = await sql`
    INSERT INTO playbook (domain, insight, evidence, confidence)
    VALUES (${domain}, ${insight}, ${evidence || null}, ${confidence ?? 0.7})
    RETURNING id, domain, insight, confidence
  `;

  return json(entry, 201);
}
