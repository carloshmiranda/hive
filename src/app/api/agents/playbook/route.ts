import { NextRequest } from "next/server";
import { validateOIDC } from "@/lib/oidc";
import { getDb, json, err } from "@/lib/db";
import { invalidatePlaybook } from "@/lib/redis-cache";
import { normalizePlaybookDomain } from "@/lib/playbook-domains";


// Map domain to relevant agent roles for auto-tagging
function deriveAgentsFromDomain(domain: string): string[] {
  const domainToAgents: Record<string, string[]> = {
    engineering: ['build', 'fix'],
    infrastructure: ['build', 'fix'],
    operations: ['build', 'fix'],
    payments: ['build', 'fix'],
    auth: ['build', 'fix'],
    deployment: ['build', 'fix'],
    growth: ['growth'],
    seo: ['growth'],
    email_marketing: ['growth'],
    content: ['growth'],
    social: ['growth'],
    pricing: ['growth', 'ceo'],
    onboarding: ['build', 'growth'],
  };
  return domainToAgents[domain] || [];
}

// POST /api/agents/playbook — write playbook entry via OIDC auth
// Body: { domain, insight, evidence?, confidence?, relevant_agents? }
export async function POST(req: NextRequest) {
  const claims = await validateOIDC(req);
  if (claims instanceof Response) return claims;

  let body;
  try {
    body = await req.json();
  } catch {
    return err("Invalid JSON body", 400);
  }

  const { source_company_id, domain: rawDomain, insight, evidence, confidence, content_language, relevant_agents } = body;
  if (!rawDomain || !insight) {
    return err("Missing required fields: domain, insight", 400);
  }

  const domain = normalizePlaybookDomain(rawDomain);

  // Use provided relevant_agents or auto-derive from domain
  const agents: string[] = Array.isArray(relevant_agents) && relevant_agents.length > 0
    ? relevant_agents
    : deriveAgentsFromDomain(domain);

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
    INSERT INTO playbook (source_company_id, domain, insight, evidence, confidence, content_language, relevant_agents)
    VALUES (${source_company_id || null}, ${domain}, ${insight}, ${evidence || null}, ${confidence ?? 0.7}, ${content_language || null}, ${agents})
    RETURNING id, domain, insight, confidence, content_language, relevant_agents
  `;

  await invalidatePlaybook();
  return json(entry, 201);
}
