import { NextRequest } from "next/server";
import { json, err } from "@/lib/db";
import { webSearch } from "@/lib/web-search";

// POST /api/agents/web-search — web search for worker agents (CRON_SECRET auth)
// Body: { query: string, count?: number }
// Returns: { results: Array<{ title, url, snippet }>, provider?, warning? }
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

  const result = await webSearch(query, count);
  return json(result);
}
