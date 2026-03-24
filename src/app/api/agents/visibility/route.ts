import { NextRequest } from "next/server";
import { getDb, json, err } from "@/lib/db";
import { getGSCPerformance, getTopKeywords, getStrikingDistanceKeywords, getLowCTRPages } from "@/lib/gsc";
import { checkLLMCitations } from "@/lib/llm-tracker";

// Hobby-safe: GSC call ~5s, LLM checks ~25s (10 keywords × 2s each + overhead)
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return err("Unauthorized", 401);
  }

  const body = await req.json();
  const { company_slug } = body;
  if (!company_slug) return err("company_slug required");

  const sql = getDb();
  const [company] = await sql`
    SELECT id, name, slug, vercel_url FROM companies
    WHERE slug = ${company_slug} AND status IN ('mvp', 'active')
  `;
  if (!company) return err("Company not found");

  const today = new Date().toISOString().split("T")[0];
  const results: Record<string, any> = { gsc: null, llm: null };

  // 1. Pull GSC data
  if (company.vercel_url) {
    const gscRows = await getGSCPerformance(company.vercel_url, 7);

    if (gscRows.length > 0) {
      // Store individual keyword metrics (top 200)
      for (const row of gscRows.slice(0, 200)) {
        const [query, page] = row.keys;
        await sql`
          INSERT INTO visibility_metrics (company_id, date, source, keyword, url, impressions, clicks, position, ctr)
          VALUES (${company.id}, ${today}, 'gsc', ${query}, ${page}, ${row.impressions}, ${row.clicks}, ${row.position}, ${row.ctr})
          ON CONFLICT (company_id, date, source, keyword, url) DO UPDATE SET
            impressions = EXCLUDED.impressions, clicks = EXCLUDED.clicks,
            position = EXCLUDED.position, ctr = EXCLUDED.ctr
        `;
      }

      // Store aggregated snapshot
      const striking = getStrikingDistanceKeywords(gscRows);
      const lowCtr = getLowCTRPages(gscRows);

      await sql`
        INSERT INTO research_reports (company_id, report_type, content, summary)
        VALUES (${company.id}, 'visibility_snapshot', ${JSON.stringify({
          date: today,
          total_keywords: gscRows.length,
          total_impressions: gscRows.reduce((s, r) => s + r.impressions, 0),
          total_clicks: gscRows.reduce((s, r) => s + r.clicks, 0),
          striking_distance: striking.slice(0, 10).map(r => ({ keyword: r.keys[0], position: r.position, impressions: r.impressions })),
          low_ctr_pages: lowCtr.slice(0, 10).map(r => ({ url: r.keys[1], keyword: r.keys[0], impressions: r.impressions, ctr: r.ctr })),
        })}, ${`${gscRows.length} keywords tracked, ${striking.length} striking distance, ${lowCtr.length} low CTR`})
        ON CONFLICT (company_id, report_type) DO UPDATE SET
          content = EXCLUDED.content, summary = EXCLUDED.summary, updated_at = now()
      `;

      results.gsc = { keywords: gscRows.length, striking: striking.length, low_ctr: lowCtr.length };
    }
  }

  // 2. LLM citation check (every 3rd call — check last run)
  const [lastLlmCheck] = await sql`
    SELECT created_at FROM research_reports
    WHERE company_id = ${company.id} AND report_type = 'llm_visibility'
    ORDER BY updated_at DESC LIMIT 1
  `;

  const hoursSinceLastCheck = lastLlmCheck
    ? (Date.now() - new Date(lastLlmCheck.created_at).getTime()) / (3600 * 1000)
    : 999;

  // Run LLM check if >12h since last check (roughly every 3 sentinel cycles)
  if (hoursSinceLastCheck >= 12 && company.vercel_url) {
    let keywords: string[] = [];

    // Get top keywords from GSC, or fall back to stored seo_keywords report
    const gscRows = await getGSCPerformance(company.vercel_url, 28);
    if (gscRows.length > 0) {
      keywords = getTopKeywords(gscRows, 10);
    } else {
      const [seoReport] = await sql`
        SELECT content FROM research_reports
        WHERE company_id = ${company.id} AND report_type = 'seo_keywords'
      `;
      if (seoReport?.content?.primary_keywords) {
        keywords = seoReport.content.primary_keywords.slice(0, 10).map((k: any) => k.keyword || k);
      }
    }

    if (keywords.length > 0) {
      const citations = await checkLLMCitations(company.name, company.vercel_url, keywords, sql);

      // Store individual citation results
      for (const c of citations) {
        await sql`
          INSERT INTO visibility_metrics (company_id, date, source, keyword, url, cited, mentioned, competitors)
          VALUES (${company.id}, ${today}, 'llm_gemini', ${c.keyword}, ${company.vercel_url}, ${c.cited}, ${c.mentioned}, ${JSON.stringify(c.competitors)})
          ON CONFLICT (company_id, date, source, keyword, url) DO UPDATE SET
            cited = EXCLUDED.cited, mentioned = EXCLUDED.mentioned, competitors = EXCLUDED.competitors
        `;
      }

      // Store aggregated LLM visibility report
      const citedCount = citations.filter(c => c.cited).length;
      const mentionedCount = citations.filter(c => c.mentioned).length;
      const allCompetitors = [...new Set(citations.flatMap(c => c.competitors))];

      await sql`
        INSERT INTO research_reports (company_id, report_type, content, summary)
        VALUES (${company.id}, 'llm_visibility', ${JSON.stringify({
          date: today,
          keywords_checked: citations.length,
          cited_count: citedCount,
          mentioned_count: mentionedCount,
          citation_rate: citations.length > 0 ? citedCount / citations.length : 0,
          mention_rate: citations.length > 0 ? mentionedCount / citations.length : 0,
          top_competitors: allCompetitors.slice(0, 15),
          details: citations,
        })}, ${`Cited in ${citedCount}/${citations.length} queries, mentioned in ${mentionedCount}. Top competitors: ${allCompetitors.slice(0, 5).join(', ')}`})
        ON CONFLICT (company_id, report_type) DO UPDATE SET
          content = EXCLUDED.content, summary = EXCLUDED.summary, updated_at = now()
      `;

      results.llm = { checked: citations.length, cited: citedCount, mentioned: mentionedCount };
    }
  }

  // 3. Content performance analysis — compare current vs prior period per URL
  // Runs when we have at least 7 days of visibility data
  const [dataAge] = await sql`
    SELECT MIN(date) as earliest FROM visibility_metrics
    WHERE company_id = ${company.id} AND source = 'gsc'
  `;
  const hasEnoughData = dataAge?.earliest &&
    (Date.now() - new Date(dataAge.earliest).getTime()) > 7 * 24 * 3600 * 1000;

  if (hasEnoughData) {
    // Compare last 7 days vs prior 7 days, grouped by URL
    const urlTrends = await sql`
      WITH current_period AS (
        SELECT url,
          SUM(impressions) as impressions,
          SUM(clicks) as clicks,
          AVG(position) as avg_position,
          CASE WHEN SUM(impressions) > 0 THEN SUM(clicks)::float / SUM(impressions) ELSE 0 END as ctr,
          COUNT(DISTINCT keyword) as keywords
        FROM visibility_metrics
        WHERE company_id = ${company.id} AND source = 'gsc'
          AND date >= CURRENT_DATE - INTERVAL '7 days'
        GROUP BY url
      ),
      prior_period AS (
        SELECT url,
          SUM(impressions) as impressions,
          SUM(clicks) as clicks,
          AVG(position) as avg_position,
          CASE WHEN SUM(impressions) > 0 THEN SUM(clicks)::float / SUM(impressions) ELSE 0 END as ctr
        FROM visibility_metrics
        WHERE company_id = ${company.id} AND source = 'gsc'
          AND date >= CURRENT_DATE - INTERVAL '14 days'
          AND date < CURRENT_DATE - INTERVAL '7 days'
        GROUP BY url
      )
      SELECT
        c.url,
        c.impressions as cur_impressions,
        c.clicks as cur_clicks,
        ROUND(c.avg_position::numeric, 1) as cur_position,
        ROUND((c.ctr * 100)::numeric, 2) as cur_ctr_pct,
        c.keywords,
        COALESCE(p.impressions, 0) as prev_impressions,
        COALESCE(p.clicks, 0) as prev_clicks,
        ROUND(COALESCE(p.avg_position, 0)::numeric, 1) as prev_position,
        ROUND((COALESCE(p.ctr, 0) * 100)::numeric, 2) as prev_ctr_pct,
        CASE
          WHEN COALESCE(p.impressions, 0) > 0
          THEN ROUND(((c.impressions - p.impressions)::float / p.impressions * 100)::numeric, 1)
          ELSE NULL
        END as impressions_change_pct,
        ROUND((c.avg_position - COALESCE(p.avg_position, c.avg_position))::numeric, 1) as position_change
      FROM current_period c
      LEFT JOIN prior_period p ON p.url = c.url
      WHERE c.impressions >= 5
      ORDER BY c.impressions DESC
      LIMIT 50
    `;

    type ContentItem = {
      url: string;
      impressions: number;
      clicks: number;
      position: number;
      ctr_pct: number;
      keywords: number;
      impressions_change_pct: number | null;
      position_change: number;
      refresh_recommended: boolean;
      refresh_reason: string | null;
      priority: string;
    };

    const contentItems: ContentItem[] = [];
    let refreshCount = 0;

    for (const r of urlTrends) {
      const impChange = r.impressions_change_pct !== null ? Number(r.impressions_change_pct) : null;
      const posChange = Number(r.position_change) || 0;
      const curCtr = Number(r.cur_ctr_pct) || 0;
      const prevCtr = Number(r.prev_ctr_pct) || 0;
      const curImpressions = Number(r.cur_impressions) || 0;

      let refreshReason: string | null = null;
      let priority = "ok";

      // Flag for refresh based on decay signals
      if (impChange !== null && impChange < -30 && curImpressions >= 10) {
        refreshReason = `Impressions dropped ${impChange}% week-over-week`;
        priority = "high";
      } else if (posChange > 3) {
        refreshReason = `Position dropped by ${posChange} (getting pushed down)`;
        priority = "high";
      } else if (prevCtr > 0 && curCtr < prevCtr * 0.6 && curImpressions >= 20) {
        refreshReason = `CTR dropped from ${prevCtr}% to ${curCtr}% (stale title/description)`;
        priority = "medium";
      } else if (curImpressions >= 50 && curCtr < 2) {
        refreshReason = `High impressions (${curImpressions}) but very low CTR (${curCtr}%) — meta needs rewrite`;
        priority = "medium";
      } else if (Number(r.cur_position) >= 4 && Number(r.cur_position) <= 10 && curImpressions >= 20) {
        refreshReason = `Striking distance (position ${r.cur_position}) — content refresh could push to top 3`;
        priority = "low";
      }

      if (refreshReason) refreshCount++;

      contentItems.push({
        url: r.url as string,
        impressions: curImpressions,
        clicks: Number(r.cur_clicks) || 0,
        position: Number(r.cur_position) || 0,
        ctr_pct: curCtr,
        keywords: Number(r.keywords) || 0,
        impressions_change_pct: impChange,
        position_change: posChange,
        refresh_recommended: refreshReason !== null,
        refresh_reason: refreshReason,
        priority,
      });
    }

    // Sort: high priority first, then medium, then by impressions
    const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2, ok: 3 };
    contentItems.sort((a, b) =>
      (priorityOrder[a.priority] ?? 3) - (priorityOrder[b.priority] ?? 3) || b.impressions - a.impressions
    );

    const refreshItems = contentItems.filter(c => c.refresh_recommended);
    const topPerformers = contentItems.filter(c => !c.refresh_recommended).slice(0, 5);

    await sql`
      INSERT INTO research_reports (company_id, report_type, content, summary)
      VALUES (${company.id}, 'content_performance', ${JSON.stringify({
        date: today,
        total_urls_tracked: contentItems.length,
        refresh_needed: refreshCount,
        refresh_items: refreshItems.slice(0, 15),
        top_performers: topPerformers,
        all_urls: contentItems.slice(0, 30),
      })}, ${`${contentItems.length} URLs tracked, ${refreshCount} need refresh (${refreshItems.filter(c => c.priority === 'high').length} high, ${refreshItems.filter(c => c.priority === 'medium').length} medium)`})
      ON CONFLICT (company_id, report_type) DO UPDATE SET
        content = EXCLUDED.content, summary = EXCLUDED.summary, updated_at = now()
    `;

    results.content_performance = {
      urls_tracked: contentItems.length,
      refresh_needed: refreshCount,
      high_priority: refreshItems.filter(c => c.priority === "high").length,
    };
  }

  return json({ company: company.slug, results });
}
