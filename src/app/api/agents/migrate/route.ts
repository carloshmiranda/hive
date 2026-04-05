import { NextRequest } from "next/server";
import { getDb, json, err } from "@/lib/db";

/**
 * POST /api/agents/migrate — run idempotent DB schema migrations for Hive tables.
 *
 * Auth-gated with CRON_SECRET. Each migration is idempotent (CREATE TABLE IF NOT EXISTS,
 * IF NOT EXISTS for indexes/columns). Safe to call multiple times.
 *
 * Returns a summary of which migrations ran and their outcomes.
 */
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return err("Unauthorized", 401);
  }

  const sql = getDb();
  const results: Record<string, string> = {};

  // ── pipeline_templates ──────────────────────────────────────────────────────
  // Stores JSON pipeline templates for agent chains. Stages are JSONB so the
  // schema remains flexible as dispatch wiring evolves.
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS pipeline_templates (
        id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        slug        TEXT NOT NULL UNIQUE,
        name        TEXT NOT NULL,
        description TEXT,
        stages      JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS idx_pipeline_templates_slug
        ON pipeline_templates(slug)
    `;
    results.pipeline_templates = "ok";
  } catch (e: unknown) {
    results.pipeline_templates = `error: ${e instanceof Error ? e.message : String(e)}`;
  }

  return json({ migrations: results });
}
