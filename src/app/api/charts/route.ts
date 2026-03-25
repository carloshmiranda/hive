import { getDb, json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

export async function GET(req: Request) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const { searchParams } = new URL(req.url);
  const metric = searchParams.get("metric") || "mrr";
  const days = parseInt(searchParams.get("days") || "30");
  const chartType = searchParams.get("type") || "timeseries"; // timeseries | comparison

  const sql = getDb();

  if (chartType === "comparison") {
    // Company comparison chart - latest values for each company
    const data = await sql`
      SELECT DISTINCT ON (m.company_id)
        c.name as company_name,
        c.slug as company_slug,
        c.status,
        m.${sql(metric)},
        m.revenue,
        m.mrr,
        m.customers,
        m.page_views,
        m.date
      FROM metrics m
      JOIN companies c ON c.id = m.company_id
      WHERE c.status IN ('active', 'mvp')
      ORDER BY m.company_id, m.date DESC
    `;
    return json({ type: "comparison", metric, data });
  }

  // Time-series chart - data over time
  if (searchParams.get("company_id")) {
    // Single company time-series
    const companyId = searchParams.get("company_id");
    const data = await sql`
      SELECT
        date,
        revenue,
        mrr,
        customers,
        page_views,
        signups,
        waitlist_signups
      FROM metrics
      WHERE company_id = ${companyId}
        AND date >= CURRENT_DATE - ${days} * INTERVAL '1 day'
      ORDER BY date ASC
    `;
    return json({ type: "timeseries", metric, data, company_id: companyId });
  }

  // Portfolio-wide time-series (aggregated)
  const data = await sql`
    SELECT
      date,
      SUM(revenue) as revenue,
      SUM(mrr) as mrr,
      SUM(customers) as customers,
      SUM(page_views) as page_views,
      SUM(signups) as signups,
      SUM(waitlist_signups) as waitlist_signups,
      COUNT(DISTINCT company_id) as active_companies
    FROM metrics m
    JOIN companies c ON c.id = m.company_id
    WHERE c.status IN ('active', 'mvp')
      AND date >= CURRENT_DATE - ${days} * INTERVAL '1 day'
    GROUP BY date
    ORDER BY date ASC
  `;

  // Fill gaps for consistent chart display
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const filledData = [];
  const dataMap = new Map(data.map((row: any) => [row.date, row]));

  for (let d = new Date(startDate); d <= new Date(); d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split('T')[0];
    const existing = dataMap.get(dateStr);
    if (existing) {
      filledData.push(existing);
    } else {
      filledData.push({
        date: dateStr,
        revenue: 0,
        mrr: 0,
        customers: 0,
        page_views: 0,
        signups: 0,
        waitlist_signups: 0,
        active_companies: 0
      });
    }
  }

  return json({ type: "timeseries", metric, data: filledData });
}