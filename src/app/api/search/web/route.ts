import { NextRequest } from "next/server";
import { validateOIDC } from "@/lib/oidc";
import { json, err } from "@/lib/db";
import { searchWeb, searchCompetitors, searchMarketData, searchTrends, type SearchOptions } from "@/lib/web-search";

// POST /api/search/web
export async function POST(req: NextRequest) {
  const result = await validateOIDC(req);
  if (result instanceof Response) return result;

  try {
    const body = await req.json();
    const { query, search_type, options = {}, market, product, location, industry, timeframe } = body;

    if (!query && !market && !industry) {
      return err("Missing required parameter: query, market, or industry", 400);
    }

    let searchResult;

    switch (search_type) {
      case "competitors":
        if (!market) {
          return err("Missing required parameter: market", 400);
        }
        searchResult = await searchCompetitors(market, product, location);
        break;

      case "market_data":
        if (!market) {
          return err("Missing required parameter: market", 400);
        }
        searchResult = await searchMarketData(market, location);
        break;

      case "trends":
        if (!industry) {
          return err("Missing required parameter: industry", 400);
        }
        searchResult = await searchTrends(industry, timeframe);
        break;

      case "general":
      default:
        if (!query) {
          return err("Missing required parameter: query", 400);
        }
        searchResult = await searchWeb(query, options as SearchOptions);
        break;
    }

    if (!searchResult) {
      return json({
        success: false,
        error: "Web search is not configured or failed. Check web_search_api_key in settings.",
        results: []
      });
    }

    return json({
      success: true,
      search_type: search_type || "general",
      query: searchResult.query,
      ...(searchResult.answer && { answer: searchResult.answer }),
      results: searchResult.results,
      ...(searchResult.images && { images: searchResult.images }),
      result_count: searchResult.results.length
    });

  } catch (error) {
    console.error("[search/web] API error:", error instanceof Error ? error.message : error);
    return err("Search request failed", 500);
  }
}

// GET /api/search/web/status - check if web search is configured
export async function GET() {
  const { getSettingValue } = await import("@/lib/settings");
  const apiKey = await getSettingValue("web_search_api_key");

  return json({
    configured: !!apiKey,
    provider: apiKey ? "tavily" : null,
    message: apiKey
      ? "Web search is configured and available"
      : "Web search not configured. Set web_search_api_key in /settings to enable."
  });
}