import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

// POST /api/pricing-intent — records a click on a pricing CTA
// Used for fake-door validation: track who clicks "Buy" before the product exists
// The frontend pricing page calls this when a user clicks a tier CTA
export async function POST(req: Request) {
  const { tier, source_path = "/pricing" } = await req.json().catch(() => ({
    tier: "unknown",
    source_path: "/pricing",
  }));

  const sql = getDb();

  await sql`
    INSERT INTO pricing_clicks (date, tier, source_path)
    VALUES (CURRENT_DATE, ${tier}, ${source_path})
  `;

  return Response.json({ ok: true });
}

// GET /api/pricing-intent — returns daily click summary (last 14 days)
export async function GET() {
  const sql = getDb();

  const rows = await sql`
    SELECT date, tier, COUNT(*)::int as clicks
    FROM pricing_clicks
    WHERE date >= CURRENT_DATE - INTERVAL '14 days'
    GROUP BY date, tier
    ORDER BY date DESC, clicks DESC
  `.catch(() => []);

  return Response.json({ ok: true, data: rows });
}
