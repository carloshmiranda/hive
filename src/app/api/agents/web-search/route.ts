import { NextRequest } from "next/server";
import { json, err } from "@/lib/db";

// POST /api/agents/web-search — web search for worker agents (CRON_SECRET auth)
// Body: { query: string, count?: number }
// Returns: { results: Array<{ title, url, snippet }> }
export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (!auth || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return err("Unauthorized", 401);
  }

  let body: { query?: string; count?: number };
  try {
    body = await req.json();
  } catch {
    return err("Invalid JSON body", 400);
  }

  const { query, count = 5 } = body;
  if (!query || typeof query !== "string" || query.trim().length === 0) {
    return err("query is required", 400);
  }

  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    console.warn("[web-search] BRAVE_SEARCH_API_KEY not set — returning empty results");
    return json({ results: [], warning: "Web search not configured (missing BRAVE_SEARCH_API_KEY)" });
  }

  try {
    const safeCount = Math.min(Math.max(1, count), 10);
    const searchUrl = new URL("https://api.search.brave.com/res/v1/web/search");
    searchUrl.searchParams.set("q", query.trim());
    searchUrl.searchParams.set("count", String(safeCount));
    searchUrl.searchParams.set("text_decorations", "false");
    searchUrl.searchParams.set("search_lang", "en");

    const res = await fetch(searchUrl.toString(), {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error(`[web-search] Brave API error ${res.status}: ${errText}`);
      return json({ results: [], error: `Search API returned ${res.status}` });
    }

    const data = await res.json();
    const webResults = data?.web?.results ?? [];

    const results = webResults.slice(0, safeCount).map((r: any) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: r.description ?? "",
    }));

    return json({ results });
  } catch (e: any) {
    console.error(`[web-search] Error: ${e?.message}`);
    return json({ results: [], error: e?.message ?? "Search failed" });
  }
}
