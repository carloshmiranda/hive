import { getDb, json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { generateEmbedding } from "@/lib/embeddings";
import { NextRequest } from "next/server";

interface PlaybookEntry {
  id: string;
  domain: string;
  insight: string;
  evidence: any;
  confidence: number;
  source_company_id: string;
  source_company: string;
  similarity: number;
  created_at: string;
  content_language: string;
  relevant_agents: string[];
}

export async function POST(req: NextRequest) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  try {
    const body = await req.json();
    const { query, limit = 10, threshold = 0.7, domain = null } = body;

    if (!query?.trim()) {
      return err("Query is required", 400);
    }

    if (limit > 100) {
      return err("Limit cannot exceed 100", 400);
    }

    // Generate embedding for the search query
    const queryEmbedding = await generateEmbedding(query.trim());

    // Convert embedding to pgvector format
    const embeddingVector = `[${queryEmbedding.join(',')}]`;

    const sql = getDb();

    // Build semantic search query with optional domain filtering
    let searchQuery;
    if (domain) {
      searchQuery = sql`
        SELECT
          p.id,
          p.domain,
          p.insight,
          p.evidence,
          p.confidence,
          p.source_company_id,
          p.created_at,
          p.content_language,
          p.relevant_agents,
          c.name as source_company,
          1 - (p.embedding <=> ${embeddingVector}::vector) as similarity
        FROM playbook p
        LEFT JOIN companies c ON c.id = p.source_company_id
        WHERE
          p.superseded_by IS NULL
          AND p.embedding IS NOT NULL
          AND p.domain = ${domain}
          AND (1 - (p.embedding <=> ${embeddingVector}::vector)) >= ${threshold}
        ORDER BY p.embedding <=> ${embeddingVector}::vector
        LIMIT ${limit}
      `;
    } else {
      searchQuery = sql`
        SELECT
          p.id,
          p.domain,
          p.insight,
          p.evidence,
          p.confidence,
          p.source_company_id,
          p.created_at,
          p.content_language,
          p.relevant_agents,
          c.name as source_company,
          1 - (p.embedding <=> ${embeddingVector}::vector) as similarity
        FROM playbook p
        LEFT JOIN companies c ON c.id = p.source_company_id
        WHERE
          p.superseded_by IS NULL
          AND p.embedding IS NOT NULL
          AND (1 - (p.embedding <=> ${embeddingVector}::vector)) >= ${threshold}
        ORDER BY p.embedding <=> ${embeddingVector}::vector
        LIMIT ${limit}
      `;
    }

    const results = await searchQuery as PlaybookEntry[];

    // Format results
    const formattedResults = results.map(result => ({
      id: result.id,
      domain: result.domain,
      insight: result.insight,
      evidence: result.evidence,
      confidence: result.confidence,
      source_company_id: result.source_company_id,
      source_company: result.source_company,
      similarity: Number(result.similarity.toFixed(4)),
      created_at: result.created_at,
      content_language: result.content_language,
      relevant_agents: result.relevant_agents
    }));

    return json({
      query,
      results: formattedResults,
      count: formattedResults.length,
      threshold,
      domain: domain || "all"
    });

  } catch (error) {
    console.error("Semantic search error:", error);

    if (error instanceof Error) {
      // Handle specific embedding generation errors
      if (error.message.includes("openrouter_api_key")) {
        return err("OpenRouter API key not configured", 500);
      }
      if (error.message.includes("Embedding generation failed")) {
        return err("Failed to generate embeddings for query", 500);
      }
    }

    return err("Internal server error during semantic search", 500);
  }
}

export async function GET(req: NextRequest) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const { searchParams } = new URL(req.url);
  const query = searchParams.get("q");
  const limit = parseInt(searchParams.get("limit") || "10");
  const threshold = parseFloat(searchParams.get("threshold") || "0.7");
  const domain = searchParams.get("domain");

  if (!query?.trim()) {
    return err("Query parameter 'q' is required", 400);
  }

  // Reuse POST logic by creating a request body
  const requestBody = {
    query,
    limit,
    threshold,
    domain
  };

  try {
    // Create a new request with the body for internal processing
    const mockRequest = new NextRequest(req.url, {
      method: "POST",
      headers: req.headers,
      body: JSON.stringify(requestBody)
    });

    return await POST(mockRequest);
  } catch (error) {
    console.error("GET semantic search error:", error);
    return err("Internal server error", 500);
  }
}