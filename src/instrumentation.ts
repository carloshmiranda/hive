export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("../sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }
}

// Export request error hook for server-side error instrumentation
export function onRequestError(err: unknown, request: Request, context: any) {
  const Sentry = require("@sentry/nextjs");
  Sentry.captureRequestError(err, request, context);
}
