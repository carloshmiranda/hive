import { getDb, json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

/**
 * PATCH /api/admin/plugins/[id]
 * Toggles the enabled/disabled state of a plugin.
 *
 * Body: { enabled: boolean }
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return err("Invalid JSON body", 400);
  }

  if (!body || typeof body !== "object") return err("Body must be an object", 400);
  const { enabled } = body as Record<string, unknown>;

  if (typeof enabled !== "boolean") return err("enabled must be a boolean", 400);

  const sql = getDb();

  const [plugin] = await sql`
    UPDATE hive_plugins
    SET enabled = ${enabled}
    WHERE id = ${id}
    RETURNING id, name, version, enabled, manifest, created_at
  `;

  if (!plugin) return err(`Plugin '${id}' not found`, 404);

  return json({ plugin });
}
