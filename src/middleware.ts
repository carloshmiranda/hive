import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";

export default auth((req) => {
  if (!req.auth) {
    const loginUrl = new URL("/login", req.url);
    return NextResponse.redirect(loginUrl);
  }
  return NextResponse.next();
});

export const config = {
  matcher: [
    // Protect everything except login page, auth API, webhooks, cron, static files
    "/((?!login|api/auth|api/webhooks|api/cron|_next/static|_next/image|favicon.ico).*)",
  ],
};
