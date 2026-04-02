import { json } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { getProjectsConsumption } from "@/lib/neon-api";

// Free tier limits per project (Neon Free plan as of 2026)
const FREE_STORAGE_BYTES = 0.5 * 1024 ** 3; // 0.5 GB
const FREE_COMPUTE_SECONDS = 100 * 3600;    // 100 CU-hours

export async function GET() {
  const session = await requireAuth();
  if (!session) return json({ error: "Unauthorized" }, 401);

  try {
    const projects = await getProjectsConsumption();

    const enriched = projects.map(p => ({
      id: p.id,
      name: p.name,
      storage_bytes: p.storage_bytes,
      storage_gb: p.storage_bytes / 1024 ** 3,
      storage_pct: Math.min(100, Math.round((p.storage_bytes / FREE_STORAGE_BYTES) * 100)),
      compute_hours: p.compute_seconds / 3600,
      compute_pct: Math.min(100, Math.round((p.compute_seconds / FREE_COMPUTE_SECONDS) * 100)),
    }));

    const total_storage_bytes = enriched.reduce((s, p) => s + p.storage_bytes, 0);
    const total_compute_seconds = projects.reduce((s, p) => s + p.compute_seconds, 0);

    return json({
      projects: enriched,
      totals: {
        storage_gb: total_storage_bytes / 1024 ** 3,
        compute_hours: total_compute_seconds / 3600,
      },
      limits: {
        storage_gb_per_project: FREE_STORAGE_BYTES / 1024 ** 3,
        compute_hours_per_month: FREE_COMPUTE_SECONDS / 3600,
      },
    });
  } catch (e: any) {
    // Gracefully handle missing API key or connectivity issues
    return json({ error: e.message ?? "Failed to fetch Neon usage" }, 503);
  }
}
