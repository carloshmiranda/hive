import { getDb } from "@/lib/db";
import { getSettingValue } from "@/lib/settings";
import { verifyCronAuth } from "@/lib/qstash";
import { setSentryTags } from "@/lib/sentry-tags";

// Daily cron: fetches RSS feeds, summarizes with OpenRouter/Llama, stores in domain_knowledge
// Triggered by QStash daily at 06:00 UTC — add schedule via QStash dashboard or API

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// RSS feeds by domain
const RSS_FEEDS: { domain: string; source: string; url: string }[] = [
  // SEO
  { domain: "seo", source: "Ahrefs Blog", url: "https://ahrefs.com/blog/rss/" },
  { domain: "seo", source: "Search Engine Journal", url: "https://www.searchenginejournal.com/feed/" },
  { domain: "seo", source: "Google Search Central", url: "https://developers.google.com/search/blog/atom.xml" },
  // Growth
  { domain: "growth", source: "Lenny's Newsletter", url: "https://www.lennysnewsletter.com/feed" },
  { domain: "growth", source: "Reforge Blog", url: "https://www.reforge.com/blog/rss.xml" },
  // Engineering
  { domain: "engineering", source: "Vercel Blog", url: "https://vercel.com/blog/rss.xml" },
  { domain: "engineering", source: "ThoughtWorks Radar", url: "https://www.thoughtworks.com/rss/insights.xml" },
  // Strategy
  { domain: "strategy", source: "Stratechery", url: "https://stratechery.com/feed/" },
  { domain: "strategy", source: "CB Insights", url: "https://www.cbinsights.com/research/feed/" },
];

// Lightweight RSS/Atom XML parser — extracts up to N items from a feed
// Uses regex to avoid DOMParser (not available in edge/Node runtime)
function parseRssItems(xml: string, maxItems: number = 3): Array<{ title: string; description: string; link: string; pubDate: string }> {
  const items: Array<{ title: string; description: string; link: string; pubDate: string }> = [];

  // Support both RSS <item> and Atom <entry> elements
  const itemPattern = /<(?:item|entry)[\s>]([\s\S]*?)<\/(?:item|entry)>/gi;
  let match;

  while ((match = itemPattern.exec(xml)) !== null && items.length < maxItems) {
    const block = match[1];

    const title = extractTag(block, "title") || "";
    const description = extractTag(block, "description") ||
      extractTag(block, "summary") ||
      extractTag(block, "content") || "";
    const link = extractTag(block, "link") ||
      extractAttr(block, "link", "href") || "";
    const pubDate = extractTag(block, "pubDate") ||
      extractTag(block, "published") ||
      extractTag(block, "updated") || "";

    if (title) {
      items.push({
        title: stripHtml(title).slice(0, 200),
        description: stripHtml(description).slice(0, 400),
        link: link.trim(),
        pubDate: pubDate.trim(),
      });
    }
  }

  return items;
}

function extractTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`, "i")) ||
    xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? m[1].trim() : "";
}

function extractAttr(xml: string, tag: string, attr: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*\\s${attr}="([^"]*)"`, "i"));
  return m ? m[1] : "";
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

interface LlmInsight {
  insight: string;
  relevance_score: number;
}

async function summarizeWithOpenRouter(
  apiKey: string,
  items: Array<{ title: string; description: string }>,
  domain: string
): Promise<LlmInsight[]> {
  const prompt = items.map((item, i) =>
    `${i + 1}. Title: ${item.title}\nDescription: ${item.description}`
  ).join("\n\n");

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://hive-phi.vercel.app",
    },
    body: JSON.stringify({
      model: "meta-llama/llama-3.1-8b-instruct:free",
      messages: [
        {
          role: "system",
          content: `You are an expert in ${domain}. For each article, extract a concise actionable insight (≤200 chars) and rate relevance for a startup team (0.0-1.0). Return ONLY a JSON array: [{"insight": "...", "relevance_score": 0.8}, ...]`,
        },
        {
          role: "user",
          content: `Extract insights from these ${domain} articles:\n\n${prompt}`,
        },
      ],
      temperature: 0.3,
      max_tokens: 512,
    }),
    signal: AbortSignal.timeout(20000),
  });

  if (!response.ok) {
    throw new Error(`OpenRouter API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content || "[]";

  const jsonMatch = content.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  const parsed = JSON.parse(jsonMatch[0]) as LlmInsight[];
  return parsed.map((p: LlmInsight) => ({
    insight: String(p.insight || "").slice(0, 200),
    relevance_score: Math.max(0, Math.min(1, Number(p.relevance_score) || 0)),
  }));
}

export async function POST(req: Request) {
  setSentryTags({ action_type: "cron", route: "/api/cron/knowledge" });

  const auth = await verifyCronAuth(req);
  if (!auth.authorized) {
    return Response.json({ error: auth.error }, { status: 401 });
  }

  const apiKey = await getSettingValue("openrouter_api_key");
  if (!apiKey) {
    return Response.json({ ok: false, error: "openrouter_api_key not configured in settings" }, { status: 500 });
  }

  const sql = getDb();

  // Prune entries older than 90 days
  const pruneResult = await sql`
    DELETE FROM domain_knowledge
    WHERE created_at < NOW() - INTERVAL '90 days'
  `.catch(() => ({ count: 0 }));
  const pruned = (pruneResult as any)?.count ?? 0;

  let processed = 0;

  // Process feeds sequentially to respect Groq rate limits (~30 req/min)
  for (const feed of RSS_FEEDS) {
    try {
      // Fetch RSS feed
      const feedResponse = await fetch(feed.url, {
        headers: { "User-Agent": "Hive-KnowledgeCron/1.0" },
        signal: AbortSignal.timeout(10000),
      });

      if (!feedResponse.ok) {
        console.warn(`[knowledge-cron] Failed to fetch ${feed.source}: ${feedResponse.status}`);
        continue;
      }

      const xml = await feedResponse.text();
      const items = parseRssItems(xml, 3);

      if (items.length === 0) {
        console.warn(`[knowledge-cron] No items parsed from ${feed.source}`);
        continue;
      }

      // Summarize with OpenRouter
      const insights = await summarizeWithOpenRouter(apiKey, items, feed.domain);

      // Upsert rows into domain_knowledge
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const insight = insights[i];
        if (!insight) continue;

        const pubDate = item.pubDate ? new Date(item.pubDate) : new Date();
        const validPubDate = isNaN(pubDate.getTime()) ? new Date() : pubDate;

        await sql`
          INSERT INTO domain_knowledge (domain, source, source_url, title, insight, relevance_score, published_at)
          VALUES (
            ${feed.domain},
            ${feed.source},
            ${feed.url},
            ${item.title},
            ${insight.insight},
            ${insight.relevance_score},
            ${validPubDate.toISOString()}
          )
          ON CONFLICT DO NOTHING
        `.catch((e: Error) => {
          console.warn(`[knowledge-cron] Upsert failed for "${item.title}": ${e.message}`);
        });

        processed++;
      }
    } catch (e) {
      // Individual feed failures are non-fatal — continue with remaining feeds
      console.warn(`[knowledge-cron] Error processing ${feed.source}:`, e instanceof Error ? e.message : e);
    }
  }

  return Response.json({ ok: true, processed, pruned });
}
