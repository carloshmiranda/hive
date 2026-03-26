import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV || "development",

  // Sample 10% of page loads for performance
  tracesSampleRate: 0.1,

  // Only report errors in production
  enabled: process.env.NODE_ENV === "production",

  // Replay is Pro-only, skip it
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,
});
