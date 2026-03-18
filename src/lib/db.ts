import { neon, neonConfig } from "@neondatabase/serverless";

neonConfig.fetchConnectionCache = true;

export function getDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  return neon(url);
}

// Standard API response shape
export type ApiResponse<T = unknown> = {
  ok: boolean;
  data?: T;
  error?: string;
};

export function ok<T>(data: T): ApiResponse<T> {
  return { ok: true, data };
}

export function err(message: string, status = 400): Response {
  return Response.json({ ok: false, error: message }, { status });
}

export function json<T>(data: T, status = 200): Response {
  return Response.json({ ok: true, data }, { status });
}
