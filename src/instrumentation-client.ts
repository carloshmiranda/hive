import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV || "development",

  // Sample 10% of page loads for performance
  tracesSampleRate: 0.1,

  // Only report errors in production
  enabled: process.env.NODE_ENV === "production",

  // Capture replays only on errors (50 free/month)
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 1.0,
});

// Export router transition hook for navigation instrumentation
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
