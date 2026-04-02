import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.VERCEL_ENV || "development",

  sendDefaultPii: true,

  // Sample 10% of transactions for performance monitoring (free tier: 10K/month)
  tracesSampleRate: process.env.NODE_ENV === "development" ? 1.0 : 0.1,

  // Attach local variable values to stack frames for easier debugging
  includeLocalVariables: true,

  enableLogs: true,

  // Capture 100% of errors (free tier: 5K/month — plenty for Hive's scale)
  // Reduce if we start hitting limits
  beforeSend(event) {
    // Filter out known non-actionable errors
    if (event.exception?.values?.[0]?.value?.includes("NEXT_NOT_FOUND")) {
      return null;
    }
    return event;
  },
});
