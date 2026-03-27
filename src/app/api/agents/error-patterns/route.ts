import { NextRequest } from "next/server";
import { validateOIDC } from "@/lib/oidc";
import { getDb, json, err } from "@/lib/db";
import { normalizeError, errorSimilarity } from "@/lib/error-normalize";
import { setSentryTags } from "@/lib/sentry-tags";

const SIMILARITY_THRESHOLD = 0.6;

/**
 * POST /api/agents/error-patterns
 *
 * Two operations:
 *   { action: "learn" }  — record an error→fix pattern after a successful fix
 *   { action: "lookup" } — find known fixes for a given error before attempting a fix
 *
 * Auth: OIDC (GitHub Actions) or Bearer CRON_SECRET (Sentinel/internal)
 */
export async function POST(req: NextRequest) {
  setSentryTags({
    action_type: "agent_api",
    route: "/api/agents/error-patterns",
  });

  // Auth: try OIDC first, fall back to CRON_SECRET
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  const isCronAuth = cronSecret && authHeader === `Bearer ${cronSecret}`;

  if (!isCronAuth) {
    const oidcResult = await validateOIDC(req);
    if (oidcResult instanceof Response) return oidcResult;
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return err("Invalid JSON body", 400);
  }

  const { action } = body;

  if (action === "learn") {
    return handleLearn(body);
  } else if (action === "lookup") {
    return handleLookup(body);
  }

  return err("Invalid action. Must be 'learn' or 'lookup'.", 400);
}

async function handleLearn(body: {
  error_text?: string;
  agent?: string;
  fix_summary?: string;
  fix_detail?: string;
  source_action_id?: string;
  auto_fixable?: boolean;
}) {
  const { error_text, agent, fix_summary, fix_detail, source_action_id, auto_fixable } = body;

  if (!error_text || !agent || !fix_summary) {
    return err("Missing required fields: error_text, agent, fix_summary", 400);
  }

  const normalized = normalizeError(error_text);
  if (!normalized) {
    return err("Error text normalizes to empty string", 400);
  }

  const sql = getDb();

  // Check for existing pattern with high similarity
  const existing = await sql`
    SELECT id, pattern, occurrences FROM error_patterns
    WHERE agent = ${agent} AND resolved = true
    ORDER BY last_seen_at DESC LIMIT 50
  `;

  let matchedId: string | null = null;
  let bestSimilarity = 0;

  for (const row of existing) {
    const sim = errorSimilarity(normalized, row.pattern as string);
    if (sim >= SIMILARITY_THRESHOLD && sim > bestSimilarity) {
      matchedId = row.id as string;
      bestSimilarity = sim;
    }
  }

  if (matchedId) {
    // Update existing pattern: increment occurrences, update fix if provided
    await sql`
      UPDATE error_patterns
      SET occurrences = occurrences + 1,
          last_seen_at = NOW(),
          fix_summary = ${fix_summary},
          fix_detail = COALESCE(${fix_detail || null}, fix_detail),
          auto_fixable = COALESCE(${auto_fixable ?? null}, auto_fixable)
      WHERE id = ${matchedId}
    `;

    return json({ matched: true, pattern_id: matchedId, similarity: bestSimilarity });
  }

  // Create new pattern
  const [created] = await sql`
    INSERT INTO error_patterns (pattern, agent, fix_summary, fix_detail, source_action_id, resolved, auto_fixable)
    VALUES (
      ${normalized},
      ${agent},
      ${fix_summary},
      ${fix_detail || null},
      ${source_action_id || null},
      true,
      ${auto_fixable ?? false}
    )
    RETURNING id
  `;

  return json({ matched: false, pattern_id: created.id, created: true });
}

async function handleLookup(body: {
  error_text?: string;
  agent?: string;
}) {
  const { error_text, agent } = body;

  if (!error_text) {
    return err("Missing required field: error_text", 400);
  }

  const normalized = normalizeError(error_text);
  if (!normalized) {
    return json({ matches: [] });
  }

  const sql = getDb();

  // First try full-text search for fast filtering, then refine with Jaccard similarity
  const candidates = await sql`
    SELECT id, pattern, agent, fix_summary, fix_detail, occurrences, auto_fixable, last_seen_at
    FROM error_patterns
    WHERE resolved = true
      ${agent ? sql`AND agent = ${agent}` : sql``}
    ORDER BY occurrences DESC, last_seen_at DESC
    LIMIT 100
  `;

  type Match = {
    pattern_id: string;
    pattern: string;
    agent: string;
    fix_summary: string;
    fix_detail: string | null;
    occurrences: number;
    auto_fixable: boolean;
    similarity: number;
    last_seen_at: string;
  };

  const matches: Match[] = [];

  for (const row of candidates) {
    const sim = errorSimilarity(normalized, row.pattern as string);
    if (sim >= SIMILARITY_THRESHOLD) {
      matches.push({
        pattern_id: row.id as string,
        pattern: row.pattern as string,
        agent: row.agent as string,
        fix_summary: row.fix_summary as string,
        fix_detail: (row.fix_detail as string) || null,
        occurrences: row.occurrences as number,
        auto_fixable: row.auto_fixable as boolean,
        similarity: Math.round(sim * 100) / 100,
        last_seen_at: row.last_seen_at as string,
      });
    }
  }

  // Sort by similarity DESC, then occurrences DESC
  matches.sort((a, b) => b.similarity - a.similarity || b.occurrences - a.occurrences);

  // Update last_seen_at for top matches and increment occurrences for unresolved lookups
  if (matches.length > 0) {
    const topId = matches[0].pattern_id;
    await sql`
      UPDATE error_patterns
      SET last_seen_at = NOW(), occurrences = occurrences + 1
      WHERE id = ${topId}
    `.catch(() => {});
  }

  return json({ matches: matches.slice(0, 5), normalized_query: normalized });
}
