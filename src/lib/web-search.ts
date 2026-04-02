import { getSettingValue } from "./settings";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchResponse {
  results: SearchResult[];
  provider?: string;
  query?: string;
  warning?: string;
  error?: string;
}

/**
 * Resolve the active web search provider and API key.
 * Priority: settings table > environment variables.
 * Supports Brave Search and Tavily.
 */
async function resolveSearchProvider(): Promise<{ provider: "brave" | "tavily"; key: string } | null> {
  // Brave — settings first, then env
  const braveKey =
    (await getSettingValue("brave_api_key")) ||
    process.env.BRAVE_SEARCH_API_KEY ||
    null;
  if (braveKey) return { provider: "brave", key: braveKey };

  // Tavily — settings first, then env
  const tavilyKey =
    (await getSettingValue("tavily_api_key")) ||
    process.env.TAVILY_API_KEY ||
    null;
  if (tavilyKey) return { provider: "tavily", key: tavilyKey };

  return null;
}

async function searchBrave(key: string, query: string, count: number): Promise<SearchResult[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(count));
  url.searchParams.set("text_decorations", "false");
  url.searchParams.set("search_lang", "en");

  const res = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": key,
    },
  });

  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`Brave Search API returned ${res.status}: ${msg}`);
  }

  const data = await res.json();
  return (data?.web?.results ?? []).slice(0, count).map((r: any) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.description ?? "",
  }));
}

async function searchTavily(key: string, query: string, count: number): Promise<SearchResult[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      api_key: key,
      query,
      max_results: count,
      search_depth: "basic",
      include_answer: false,
      include_raw_content: false,
    }),
  });

  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`Tavily API returned ${res.status}: ${msg}`);
  }

  const data = await res.json();
  return (data?.results ?? []).slice(0, count).map((r: any) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.content ?? "",
  }));
}

/**
 * Execute a web search using the configured provider.
 * Falls back gracefully if no provider is configured.
 */
export async function webSearch(query: string, count = 5): Promise<SearchResponse> {
  const safeCount = Math.min(Math.max(1, count), 10);
  const q = query.trim();

  const provider = await resolveSearchProvider();

  if (!provider) {
    console.warn("[web-search] No provider configured (set brave_api_key or tavily_api_key in settings)");
    return {
      results: [],
      warning: "Web search not configured — add brave_api_key or tavily_api_key in Settings",
    };
  }

  try {
    const results =
      provider.provider === "brave"
        ? await searchBrave(provider.key, q, safeCount)
        : await searchTavily(provider.key, q, safeCount);

    console.log(`[web-search] ${provider.provider}: "${q}" → ${results.length} results`);
    return { results, provider: provider.provider, query: q };
  } catch (e: any) {
    console.error(`[web-search] ${provider.provider} error: ${e.message}`);
    return { results: [], provider: provider.provider, error: e.message };
  }
}
