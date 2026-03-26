import { json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { markPlaybookEntryUsed, prunePlaybookEntries } from "@/lib/convergent";
import { invalidatePlaybook } from "@/lib/redis-cache";

/**
 * Record an outcome for a playbook entry
 */
export async function POST(req: Request) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const body = await req.json();
  const { entry_id, success, context } = body;

  if (!entry_id) {
    return err("entry_id required", 400);
  }

  if (typeof success !== "boolean") {
    return err("success must be a boolean", 400);
  }

  try {
    await markPlaybookEntryUsed(entry_id, success, context);
    await invalidatePlaybook();
    return json({ ok: true, message: "Outcome recorded successfully" });
  } catch (error) {
    console.error("Error recording playbook outcome:", error);
    return err("Failed to record outcome", 500);
  }
}

/**
 * Trigger pruning of low-performing playbook entries
 */
export async function DELETE(req: Request) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const { searchParams } = new URL(req.url);
  const maxEntries = parseInt(searchParams.get("max_entries") || "1000");

  try {
    const pruned = await prunePlaybookEntries(maxEntries);
    await invalidatePlaybook();
    return json({
      ok: true,
      message: `Pruned ${pruned} entries`,
      pruned_count: pruned
    });
  } catch (error) {
    console.error("Error pruning playbook entries:", error);
    return err("Failed to prune entries", 500);
  }
}