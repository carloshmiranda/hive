import { getDb, json, err } from "@/lib/db";
import { jaccardSimilarity } from "@/lib/sentinel-helpers";

export async function GET(req: Request) {
  // Auth: CRON_SECRET bearer token
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return err("Unauthorized", 401);
  }

  const sql = getDb();

  try {
    // Query 1: Total counts by status
    const statusCounts = await sql`
      SELECT status, COUNT(*)::int as count
      FROM hive_backlog
      GROUP BY status
      ORDER BY status
    `;

    const counts: Record<string, number> = {};
    for (const row of statusCounts) {
      counts[row.status] = row.count;
    }

    // Query 2: Duplicate detection — items with similar titles (Jaccard similarity > 0.7)
    // Compare all ready/approved items pairwise
    const activeItems = await sql`
      SELECT id, title
      FROM hive_backlog
      WHERE status IN ('ready', 'approved')
      ORDER BY id
    `;

    const duplicates: Array<{
      id1: string;
      id2: string;
      title1: string;
      title2: string;
      similarity: number;
    }> = [];

    for (let i = 0; i < activeItems.length; i++) {
      for (let j = i + 1; j < activeItems.length; j++) {
        const item1 = activeItems[i];
        const item2 = activeItems[j];
        const similarity = jaccardSimilarity(item1.title, item2.title);

        if (similarity > 0.7) {
          duplicates.push({
            id1: item1.id,
            id2: item2.id,
            title1: item1.title,
            title2: item2.title,
            similarity: Math.round(similarity * 100) / 100, // Round to 2 decimal places
          });
        }
      }
    }

    // Query 3: Stale items — ready items not dispatched in 7+ days
    const staleItems = await sql`
      SELECT id, title, created_at,
             EXTRACT(days FROM NOW() - created_at)::int as age_days
      FROM hive_backlog
      WHERE status = 'ready'
      AND created_at < NOW() - INTERVAL '7 days'
      AND dispatched_at IS NULL
      ORDER BY created_at ASC
    `;

    const stale = staleItems.map((item: any) => ({
      id: item.id,
      title: item.title,
      age_days: item.age_days,
    }));

    // Query 4: Circular items — items that were decomposed but sub-tasks also failed
    const circularItems = await sql`
      SELECT id, title
      FROM hive_backlog
      WHERE source = 'auto_decompose'
      AND status IN ('blocked', 'rejected')
      ORDER BY created_at DESC
    `;

    const circular = circularItems.map((item: any) => ({
      id: item.id,
      title: item.title,
    }));

    return json({
      counts,
      duplicates,
      stale,
      circular,
      timestamp: new Date().toISOString(),
    });

  } catch (error: any) {
    console.error("[backlog-health] Error fetching health stats:", error);
    return err(`Failed to fetch backlog health stats: ${error.message}`, 500);
  }
}