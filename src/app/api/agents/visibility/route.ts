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
      const citations = await checkLLMCitations(company.name, company.vercel_url, keywords);

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

  return json({ company: company.slug, results });
}
