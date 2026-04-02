import { NextRequest } from "next/server";
import { validateOIDC } from "@/lib/oidc";
import { getDb, json, err } from "@/lib/db";
import { generateEmbedding } from "@/lib/embeddings";

/**
 * POST /api/playbook/retrieve
 *
 * Combined RETRIEVE → JUDGE → DISTILL pipeline for agent use.
 *
 * RETRIEVE: semantic search via pgvector embedding
 * JUDGE:    compute judge_score = similarity × confidence
 * DISTILL:  rank by judge_score, format as prompt-injectable context string
 *
 * Body: { query, domain?, agent?, limit?, threshold? }
 * Returns: { results, formatted_context, count }
 */
export async function POST(req: NextRequest) {
  const claims = await validateOIDC(req);
  if (claims instanceof Response) return claims;

  let body: {
    query?: string;
    domain?: string | null;
    agent?: string | null;
    limit?: number;
    threshold?: number;
  };
  try {
    body = await req.json();
  } catch {
    return err("Invalid JSON body", 400);
  }

  const { query, domain = null, agent = null, limit = 8, threshold = 0.65 } = body;

  if (!query?.trim()) {
    return err("query is required", 400);
  }
  if (limit > 50) {
    return err("limit cannot exceed 50", 400);
  }

  const queryEmbedding = await generateEmbedding(query.trim()).catch((e: Error) => {
    throw new Error(`Embedding failed: ${e.message}`);
  });
  const embeddingVector = `[${queryEmbedding.join(",")}]`;

  const sql = getDb();

  // RETRIEVE — pgvector cosine similarity search
  // Optional filters: domain, agent (via relevant_agents array)
  const rows = await sql`
    SELECT
      p.id,
      p.domain,
      p.insight,
      p.evidence,
      p.confidence,
      p.relevant_agents,
      p.content_language,
      p.created_at,
      c.name  AS source_company,
      1 - (p.embedding <=> ${embeddingVector}::vector) AS similarity
    FROM playbook p
    LEFT JOIN companies c ON c.id = p.source_company_id
    WHERE
      p.superseded_by IS NULL
      AND p.embedding IS NOT NULL
      AND (1 - (p.embedding <=> ${embeddingVector}::vector)) >= ${threshold}
      AND (${domain}::text IS NULL OR p.domain = ${domain})
      AND (${agent}::text IS NULL OR ${agent} = ANY(p.relevant_agents))
    ORDER BY p.embedding <=> ${embeddingVector}::vector
    LIMIT ${limit * 2}
  ` as Array<{
    id: string;
    domain: string;
    insight: string;
    evidence: any;
    confidence: number;
    relevant_agents: string[];
    content_language: string | null;
    created_at: string;
    source_company: string | null;
    similarity: number;
  }>;

  // JUDGE — combined score: similarity × confidence
  // This surfaces entries that are both topically relevant AND battle-tested.
  const judged = rows
    .map((r) => ({
      ...r,
      similarity: Number(Number(r.similarity).toFixed(4)),
      confidence: Number(r.confidence),
      judge_score: Number((Number(r.similarity) * Number(r.confidence)).toFixed(4)),
    }))
    .sort((a, b) => b.judge_score - a.judge_score)
    .slice(0, limit);

  // DISTILL — format as prompt-injectable context block
  const sections = judged.map((r) => {
    const sourceTag = r.source_company ? ` · ${r.source_company}` : "";
    const langTag = r.content_language ? ` · lang:${r.content_language}` : "";
    const header = `[${r.domain}${sourceTag}${langTag} · confidence:${r.confidence} · score:${r.judge_score}]`;
    const evidenceLines =
      r.evidence && typeof r.evidence === "object" && Object.keys(r.evidence).length > 0
        ? Object.entries(r.evidence)
            .slice(0, 3)
            .map(([k, v]) => `  ${k}: ${String(v).slice(0, 120)}`)
            .join("\n")
        : null;
    return evidenceLines
      ? `${header}\n${r.insight}\n${evidenceLines}`
      : `${header}\n${r.insight}`;
  });

  const formatted_context =
    judged.length === 0
      ? "No relevant playbook entries found."
      : `PLAYBOOK CONTEXT (${judged.length} entries, ranked by relevance × confidence):\n\n${sections.join("\n\n")}`;

  return json({
    query,
    results: judged,
    formatted_context,
    count: judged.length,
    filters: { domain, agent, threshold },
  });
}
