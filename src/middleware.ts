import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";

export default auth((req) => {
  // Allow cron-authenticated requests to assess endpoint
  const path = req.nextUrl.pathname;
  if (path.match(/^\/api\/companies\/[^/]+\/assess$/)) {
    return NextResponse.next();
  }

  if (!req.auth) {
    const loginUrl = new URL("/login", req.url);
    return NextResponse.redirect(loginUrl);
  }
  return NextResponse.next();
});

export const config = {
  matcher: [
    // Protect everything except: login, auth API, webhooks, cron, health, agents, static files
    "/((?!login|monitoring|api/auth|api/webhooks|api/cron|api/health|api/agents|api/notify|api/backlog|api/dispatch|api/setup|api/settings|api/roadmap|_next/static|_next/image|favicon.ico).*)",
  ],
};
