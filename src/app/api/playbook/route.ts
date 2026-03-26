import { getDb, json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { upsertPlaybookEntry, getEffectivePlaybookEntries, getPlaybookStats } from "@/lib/convergent";
import { invalidatePlaybook } from "@/lib/redis-cache";

export async function GET(req: Request) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const { searchParams } = new URL(req.url);
  const domain = searchParams.get("domain");
  const ranked = searchParams.get("ranked") === "true";
  const stats = searchParams.get("stats") === "true";

  if (stats) {
    const statistics = await getPlaybookStats();
    return json(statistics);
  }

  if (ranked) {
    const limit = parseInt(searchParams.get("limit") || "10");
    const entries = await getEffectivePlaybookEntries(domain || undefined, limit);
    return json(entries);
  }

  // Legacy behavior for compatibility
  const sql = getDb();
  const playbook = domain
    ? await sql`
        SELECT p.*, c.name as source_company,
               COALESCE(p.success_rate, 0.5) * ln(GREATEST(p.usage_count + 1, 1)) as effectiveness_score
        FROM playbook p
        LEFT JOIN companies c ON c.id = p.source_company_id
        WHERE p.domain = ${domain} AND p.superseded_by IS NULL
        ORDER BY p.confidence DESC
      `
    : await sql`
        SELECT p.*, c.name as source_company,
               COALESCE(p.success_rate, 0.5) * ln(GREATEST(p.usage_count + 1, 1)) as effectiveness_score
        FROM playbook p
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

  // Use convergent playbook entry to handle conflicts and highest-confidence-wins
  const entryId = await upsertPlaybookEntry({
    source_company_id,
    domain,
    insight,
    evidence,
    confidence: confidence || 0.5
  });

  const sql = getDb();
  const [entry] = await sql`
    SELECT * FROM playbook WHERE id = ${entryId}
  `;

  await invalidatePlaybook();

  return json(entry, 201);
}
