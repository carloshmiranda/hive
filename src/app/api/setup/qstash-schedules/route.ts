import { getQStashClient } from "@/lib/qstash";

export const dynamic = "force-dynamic";

/**
 * QStash is the sole scheduler for Hive (ADR-031 Phase 3).
 * Vercel crons removed — all scheduling via QStash.
 *
 * 5 schedules (of 10 free tier max):
 * - sentinel-urgent: every 2h — stuck cycles, orphaned companies, deploy drift
 * - sentinel-dispatch: every 4h — agent scheduling, company cycle dispatch
 * - sentinel-janitor: daily 2am — maintenance, intelligence, playbook
 * - metrics: 8am + 6pm — scrape Vercel Analytics
 * - digest: daily 8am — portfolio summary email
 */
const SCHEDULES = [
  { path: "/api/cron/sentinel-urgent", cron: "0 */2 * * *", id: "sentinel-urgent" },
  { path: "/api/cron/sentinel-dispatch", cron: "0 */4 * * *", id: "sentinel-dispatch" },
  { path: "/api/cron/sentinel-janitor", cron: "0 2 * * *", id: "sentinel-janitor" },
  { path: "/api/cron/metrics", cron: "0 8,18 * * *", id: "metrics" },
  { path: "/api/cron/digest", cron: "0 8 * * *", id: "digest" },
];

export async function POST(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const client = getQStashClient();
  const baseUrl = process.env.NEXT_PUBLIC_URL || "https://hive-phi.vercel.app";

  const existing = await client.schedules.list();
  const existingByDest = new Map(existing.map((s) => [s.destination, s]));

  // Clean up stale schedules pointing to removed endpoints (e.g. old monolith sentinel)
  const wantedUrls = new Set(SCHEDULES.map((s) => `${baseUrl}${s.path}`));
  const staleRemoved = [];
  for (const [dest, sched] of existingByDest) {
    if (dest.startsWith(baseUrl) && !wantedUrls.has(dest)) {
      await client.schedules.delete(sched.scheduleId);
      staleRemoved.push({ destination: dest, scheduleId: sched.scheduleId });
    }
  }

  // Create or skip each desired schedule
  const results = [];
  for (const sched of SCHEDULES) {
    const url = `${baseUrl}${sched.path}`;
    if (existingByDest.has(url)) {
      results.push({ id: sched.id, status: "exists" });
      continue;
    }
    const created = await client.schedules.create({
      destination: url,
      cron: sched.cron,
      retries: 3,
    });
    results.push({ id: sched.id, scheduleId: created.scheduleId, status: "created" });
  }

  return Response.json({ ok: true, schedules: results, staleRemoved });
}

/** GET: list current QStash schedules */
export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const client = getQStashClient();
  const schedules = await client.schedules.list();
  return Response.json({
    ok: true,
    count: schedules.length,
    schedules: schedules.map((s) => ({
      id: s.scheduleId,
      destination: s.destination,
      cron: s.cron,
    })),
  });
}
