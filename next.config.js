const { withSentryConfig } = require("@sentry/nextjs");

/** @type {import('next').NextConfig} */
const nextConfig = {
  turbopack: {
    root: __dirname,
  },
};

module.exports = withSentryConfig(nextConfig, {
  // Suppress Sentry CLI logs during build
  silent: true,

  // Upload source maps for better stack traces
  // Requires SENTRY_AUTH_TOKEN env var (auto-set by Vercel Marketplace)
  sourcemaps: {
    deleteSourcemapsAfterUpload: true,
  },

  // Disable Sentry telemetry
  telemetry: false,

  // Don't widen the Next.js bundle with performance monitoring
  // We use tracesSampleRate for selective monitoring
  tunnelRoute: undefined,

  // Disable widenClientFileUpload to keep build fast
  widenClientFileUpload: false,
});
