import { getDb, json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { validatePluginManifest } from "@/lib/plugin-registry";

/**
 * GET /api/admin/plugins
 * Returns all registered plugins with their enabled state.
 */
export async function GET() {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const sql = getDb();
  const plugins = await sql`
    SELECT id, name, version, enabled, manifest, created_at
    FROM hive_plugins
    ORDER BY created_at ASC
  `;

  return json({ plugins });
}

/**
 * POST /api/admin/plugins
 * Registers a new plugin. Validates manifest shape, rejects duplicates.
 *
 * Body: { id, name, version?, manifest }
 */
export async function POST(req: Request) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err("Invalid JSON body", 400);
  }

  if (!body || typeof body !== "object") return err("Body must be an object", 400);
  const { id, name, version = "1.0.0", manifest } = body as Record<string, unknown>;

  if (typeof id !== "string" || !id.trim()) return err("id is required and must be a non-empty string", 400);
  if (typeof name !== "string" || !name.trim()) return err("name is required and must be a non-empty string", 400);
  if (manifest === undefined || manifest === null) return err("manifest is required", 400);

  const validationError = validatePluginManifest(manifest);
  if (validationError) return err(`Invalid manifest: ${validationError}`, 400);

  const sql = getDb();

  // Check for duplicate
  const existing = await sql`SELECT id FROM hive_plugins WHERE id = ${id}`;
  if (existing.length > 0) return err(`Plugin with id '${id}' already exists`, 409);

  const [plugin] = await sql`
    INSERT INTO hive_plugins (id, name, version, enabled, manifest)
    VALUES (${id}, ${name as string}, ${version as string}, false, ${JSON.stringify(manifest)})
    RETURNING id, name, version, enabled, manifest, created_at
  `;

  return json({ plugin }, 201);
}
