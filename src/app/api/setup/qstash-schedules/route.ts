import { getQStashClient } from "@/lib/qstash";

export const dynamic = "force-dynamic";

const SCHEDULES = [
  { path: "/api/cron/sentinel", cron: "0 * * * *", id: "sentinel" },
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
  const existingDests = new Set(existing.map((s) => s.destination));

  const results = [];
  for (const sched of SCHEDULES) {
    const url = `${baseUrl}${sched.path}`;
    if (existingDests.has(url)) {
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

  return Response.json({ ok: true, schedules: results });
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
