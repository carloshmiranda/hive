import { NextRequest } from "next/server";
import { validateOIDC } from "@/lib/oidc";
import { requireAuth } from "@/lib/auth";
import { getDb, json, err } from "@/lib/db";
import { invalidatePlaybook } from "@/lib/redis-cache";

/**
 * POST /api/playbook/consolidate
 *
 * CONSOLIDATE step of the 4-step playbook lifecycle.
 *
 * Scans the playbook for near-duplicate entries within the same domain
 * (vector similarity > 0.85) and merges them using highest-confidence-wins.
 * Lower-confidence duplicates are marked superseded_by the winning entry.
 *
 * Callable from:
 * - Sentinel janitor cron (OIDC auth)
 * - Dashboard manually (session auth)
 *
 * Body: { dry_run?: boolean, similarity_threshold?: number }
 * Returns: { merged, skipped, duration_ms }
 */
export async function POST(req: NextRequest) {
  // Accept both OIDC (cron/agent) and session (dashboard) auth
  const claims = await validateOIDC(req).catch(() => null);
  if (!claims || claims instanceof Response) {
    const session = await requireAuth();
    if (!session) return err("Unauthorized", 401);
  }

  let body: { dry_run?: boolean; similarity_threshold?: number } = {};
  try {
    body = await req.json();
  } catch {
    // Body is optional
  }

  const { dry_run = false, similarity_threshold = 0.85 } = body;

  if (similarity_threshold < 0.7 || similarity_threshold > 1.0) {
    return err("similarity_threshold must be between 0.7 and 1.0", 400);
  }

  const start = Date.now();
  const sql = getDb();

  // Find pairs of active entries in the same domain with high vector similarity.
  // p1.id < p2.id ensures each pair appears only once.
  const duplicatePairs = await sql`
    SELECT
      p1.id        AS id_a,
      p2.id        AS id_b,
      p1.domain,
      p1.insight   AS insight_a,
      p2.insight   AS insight_b,
      p1.confidence AS confidence_a,
      p2.confidence AS confidence_b,
      1 - (p1.embedding <=> p2.embedding) AS similarity
    FROM playbook p1
    JOIN playbook p2
      ON  p1.domain = p2.domain
      AND p1.id < p2.id
    WHERE
      p1.superseded_by IS NULL
      AND p2.superseded_by IS NULL
      AND p1.embedding IS NOT NULL
      AND p2.embedding IS NOT NULL
      AND 1 - (p1.embedding <=> p2.embedding) >= ${similarity_threshold}
    ORDER BY similarity DESC
    LIMIT 200
  ` as Array<{
    id_a: string;
    id_b: string;
    domain: string;
    insight_a: string;
    insight_b: string;
    confidence_a: number;
    confidence_b: number;
    similarity: number;
  }>;

  const merged: Array<{
    winner_id: string;
    loser_id: string;
    domain: string;
    similarity: number;
    confidence_winner: number;
    confidence_loser: number;
  }> = [];
  const skipped: Array<{ id_a: string; id_b: string; reason: string }> = [];

  // Track IDs already processed this run to avoid double-merging within a batch
  const processedIds = new Set<string>();

  for (const pair of duplicatePairs) {
    if (processedIds.has(pair.id_a) || processedIds.has(pair.id_b)) {
      skipped.push({ id_a: pair.id_a, id_b: pair.id_b, reason: "already_processed_this_run" });
      continue;
    }

    const confA = Number(pair.confidence_a);
    const confB = Number(pair.confidence_b);

    // Highest confidence wins; on tie, keep id_a (arbitrary stable choice)
    const winner_id = confA >= confB ? pair.id_a : pair.id_b;
    const loser_id  = confA >= confB ? pair.id_b : pair.id_a;
    const confidence_winner = confA >= confB ? confA : confB;
    const confidence_loser  = confA >= confB ? confB : confA;

    if (!dry_run) {
      // Re-check that neither entry has been superseded mid-run
      const [loserCheck] = await sql`
        SELECT id FROM playbook WHERE id = ${loser_id} AND superseded_by IS NULL LIMIT 1
      `;
      if (!loserCheck) {
        skipped.push({ id_a: pair.id_a, id_b: pair.id_b, reason: "already_superseded" });
        continue;
      }

      await sql`
        UPDATE playbook SET superseded_by = ${winner_id} WHERE id = ${loser_id}
      `;
    }

    merged.push({
      winner_id,
      loser_id,
      domain: pair.domain,
      similarity: Number(Number(pair.similarity).toFixed(4)),
      confidence_winner,
      confidence_loser,
    });

    processedIds.add(pair.id_a);
    processedIds.add(pair.id_b);
  }

  if (!dry_run && merged.length > 0) {
    await invalidatePlaybook().catch(() => null);
  }

  return json({
    dry_run,
    similarity_threshold,
    merged_count: merged.length,
    skipped_count: skipped.length,
    merged,
    skipped,
    duration_ms: Date.now() - start,
  });
}
