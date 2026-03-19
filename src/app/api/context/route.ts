import { NextRequest } from "next/server";
import { getDb, json, err } from "@/lib/db";

export async function GET(req: NextRequest) {
  const sql = getDb();
  const url = new URL(req.url);
  const source = url.searchParams.get("source");
  const category = url.searchParams.get("category");
  const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 100);

  let rows;
  if (source && category) {
    rows = await sql`SELECT * FROM context_log WHERE source = ${source} AND category = ${category} ORDER BY created_at DESC LIMIT ${limit}`;
  } else if (source) {
    rows = await sql`SELECT * FROM context_log WHERE source = ${source} ORDER BY created_at DESC LIMIT ${limit}`;
  } else if (category) {
    rows = await sql`SELECT * FROM context_log WHERE category = ${category} ORDER BY created_at DESC LIMIT ${limit}`;
  } else {
    rows = await sql`SELECT * FROM context_log ORDER BY created_at DESC LIMIT ${limit}`;
  }
  return json(rows);
}

export async function POST(req: NextRequest) {
  // Require bearer token to prevent unauthorized writes
  const token = process.env.HIVE_CONTEXT_TOKEN;
  if (token) {
    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${token}`) {
      return err("Unauthorized — provide Bearer token in Authorization header", 401);
    }
  }

  const sql = getDb();
  const body = await req.json();
  const { source, category, summary, detail, related_adr, related_file, tags } = body;

  if (!source || !category || !summary) {
    return err("source, category, and summary are required");
  }
  if (!["chat", "code", "orch", "carlos"].includes(source)) {
    return err("source must be: chat, code, orch, carlos");
  }
  if (!["decision", "learning", "brainstorm", "blocker", "milestone", "question"].includes(category)) {
    return err("category must be: decision, learning, brainstorm, blocker, milestone, question");
  }

  const [row] = await sql`
    INSERT INTO context_log (source, category, summary, detail, related_adr, related_file, tags)
    VALUES (${source}, ${category}, ${summary}, ${detail || null}, ${related_adr || null}, ${related_file || null}, ${tags || []})
    RETURNING *
  `;
  return json(row);
}
