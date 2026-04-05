import { NextRequest } from "next/server";
import { getDb, json, err } from "@/lib/db";
import type { PipelineTemplate } from "@/lib/pipeline-templates";

/**
 * GET /api/agents/pipelines          — list all pipeline templates
 * GET /api/agents/pipelines?slug=X   — fetch a single template by slug
 *
 * POST /api/agents/pipelines         — upsert a template (auth-gated with CRON_SECRET)
 *   Body: { slug, name, description?, stages }
 */

export async function GET(req: NextRequest) {
  const sql = getDb();
  const slug = req.nextUrl.searchParams.get("slug");

  if (slug) {
    const [template] = await sql`
      SELECT id, slug, name, description, stages, created_at, updated_at
      FROM pipeline_templates
      WHERE slug = ${slug}
    `;
    if (!template) return err(`Template '${slug}' not found`, 404);
    return json(template);
  }

  const templates = await sql`
    SELECT id, slug, name, description, stages, created_at, updated_at
    FROM pipeline_templates
    ORDER BY slug
  `;
  return json(templates);
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return err("Unauthorized", 401);
  }

  let body: Partial<PipelineTemplate>;
  try {
    body = await req.json();
  } catch {
    return err("Invalid JSON body", 400);
  }

  const { slug, name, description, stages } = body;
  if (!slug || !name || !stages) {
    return err("slug, name, and stages are required", 400);
  }

  const sql = getDb();

  const [upserted] = await sql`
    INSERT INTO pipeline_templates (slug, name, description, stages, updated_at)
    VALUES (
      ${slug},
      ${name},
      ${description ?? null},
      ${JSON.stringify(stages)}::jsonb,
      now()
    )
    ON CONFLICT (slug) DO UPDATE SET
      name        = EXCLUDED.name,
      description = EXCLUDED.description,
      stages      = EXCLUDED.stages,
      updated_at  = now()
    RETURNING *
  `;

  return json(upserted, 201);
}
