export { auth as middleware } from "@/lib/auth";

export const config = {
  matcher: [
    // Protect everything except login page, auth API, static files, and _next
    "/((?!login|api/auth|_next/static|_next/image|favicon.ico).*)",
  ],
};
