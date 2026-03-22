import { NextResponse, type NextRequest } from "next/server";

// Lightweight pageview tracking — fires-and-forgets a POST to /api/stats
// Only counts HTML page navigations, not API calls or static assets
export function middleware(req: NextRequest) {
  const res = NextResponse.next();

  // Only count GET requests for pages (not API, _next, or static files)
  if (req.method !== "GET") return res;

  const path = req.nextUrl.pathname;
  if (path.startsWith("/api/") || path.startsWith("/_next/") || path.includes(".")) {
    return res;
  }

  // Fire-and-forget: don't await, don't block the response
  const statsUrl = new URL("/api/stats", req.url);
  fetch(statsUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  }).catch(() => {}); // silently ignore errors

  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
