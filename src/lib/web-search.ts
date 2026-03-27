import { getSettingValue } from "@/lib/settings";

export interface SearchOptions {
  max_results?: number;         // Number of search results (default: 5)
  search_depth?: "basic" | "advanced"; // Search depth (default: "basic")
  include_answer?: boolean;     // Include AI-generated answer (default: false)
  include_raw_content?: boolean; // Include full HTML content (default: false)
  include_domains?: string[];   // Restrict search to specific domains
  exclude_domains?: string[];   // Exclude specific domains
}

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
  published_date?: string;
}

export interface SearchResponse {
  query: string;
  answer?: string;              // AI-generated answer (if include_answer: true)
  results: SearchResult[];
  images?: string[];           // Image URLs related to query
}

/**
 * Search the web using Tavily API.
 *
 * Returns structured search results optimized for AI agent use.
 * Gracefully degrades when no API key is configured.
 *
 * @param query - Search query string
 * @param options - Search configuration options
 * @returns Promise<SearchResponse | null> - Search results or null if not configured
 */
export async function searchWeb(
  query: string,
  options: SearchOptions = {}
): Promise<SearchResponse | null> {
  const apiKey = await getSettingValue("web_search_api_key");

  if (!apiKey) {
    console.warn("[web-search] No API key configured — web search unavailable. Set web_search_api_key in /settings");
    return null;
  }

  if (!query?.trim()) {
    console.warn("[web-search] Empty query provided");
    return null;
  }

  const {
    max_results = 5,
    search_depth = "basic",
    include_answer = false,
    include_raw_content = false,
    include_domains,
    exclude_domains
  } = options;

  try {
    const requestBody = {
      query: query.trim(),
      max_results,
      search_depth,
      include_answer,
      include_raw_content,
      ...(include_domains && { include_domains }),
      ...(exclude_domains && { exclude_domains })
    };

    console.log(`[web-search] Searching: "${query}" (${max_results} results, ${search_depth} depth)`);

    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[web-search] API error ${response.status}: ${errorText}`);
      return null;
    }

    const data = await response.json();

    // Transform Tavily response to our interface
    const searchResponse: SearchResponse = {
      query,
      ...(data.answer && { answer: data.answer }),
      results: (data.results || []).map((result: any) => ({
        title: result.title || "",
        url: result.url || "",
        content: result.content || "",
        score: result.score || 0,
        ...(result.published_date && { published_date: result.published_date })
      })),
      ...(data.images && { images: data.images })
    };

    console.log(`[web-search] Found ${searchResponse.results.length} results for "${query}"`);
    return searchResponse;

  } catch (error) {
    console.error(`[web-search] Request failed:`, error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * Search for competitor information in a specific market/niche.
 * Optimized for Growth agent competitor analysis.
 */
export async function searchCompetitors(
  market: string,
  product?: string,
  location?: string
): Promise<SearchResponse | null> {
  let query = `competitors ${market}`;
  if (product) query += ` ${product}`;
  if (location) query += ` ${location}`;

  return searchWeb(query, {
    max_results: 8,
    search_depth: "advanced",
    include_answer: true,
  });
}

/**
 * Search for market size and validation data.
 * Optimized for Scout agent market research.
 */
export async function searchMarketData(
  market: string,
  location?: string
): Promise<SearchResponse | null> {
  let query = `"${market}" market size trends statistics`;
  if (location) query += ` ${location}`;

  return searchWeb(query, {
    max_results: 6,
    search_depth: "advanced",
    include_answer: true,
  });
}

/**
 * Search for recent industry trends and news.
 * Generic function for staying current with developments.
 */
export async function searchTrends(
  industry: string,
  timeframe: "week" | "month" | "quarter" = "month"
): Promise<SearchResponse | null> {
  const timeQuery = timeframe === "week" ? "this week" :
                    timeframe === "month" ? "this month" :
                    "recent months";

  return searchWeb(`${industry} trends news developments ${timeQuery}`, {
    max_results: 10,
    search_depth: "basic",
    include_answer: false,
  });
}