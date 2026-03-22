import { neon } from "@neondatabase/serverless";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

// POST /api/affiliate-click — records an outbound affiliate link click
// Called by the frontend when a user clicks an affiliate/referral link
export async function POST(req: Request) {
  const { link_id, destination_url, source_path = "/" } = await req.json().catch(() => ({
    link_id: "unknown",
    destination_url: null,
    source_path: "/",
  }));

  const sql = neon(process.env.DATABASE_URL!);

  await sql`
    INSERT INTO affiliate_clicks (date, link_id, destination_url, source_path)
    VALUES (CURRENT_DATE, ${link_id}, ${destination_url}, ${source_path})
  `;

  return Response.json({ ok: true });
}

// GET /api/affiliate-click?days=14 — returns click summary
export async function GET(req: NextRequest) {
  const days = Number(req.nextUrl.searchParams.get("days") || "14");
  const sql = neon(process.env.DATABASE_URL!);

  const rows = await sql`
    SELECT date, link_id, COUNT(*)::int as clicks
    FROM affiliate_clicks
    WHERE date >= CURRENT_DATE - INTERVAL '1 day' * ${days}
    GROUP BY date, link_id
    ORDER BY date DESC, clicks DESC
  `.catch(() => []);

  return Response.json({ ok: true, data: rows });
}
