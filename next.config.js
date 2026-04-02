const { withSentryConfig } = require("@sentry/nextjs");

/** @type {import('next').NextConfig} */
const nextConfig = {
  turbopack: {
    root: __dirname,
  },
};

module.exports = withSentryConfig(nextConfig, {
  org: "eidolon",
  project: "sentry-coffee-window",

  // Suppress Sentry CLI logs during build (set to false in CI for build output)
  silent: !process.env.CI,

  // Upload source maps for readable stack traces in production
  // Requires SENTRY_AUTH_TOKEN env var
  sourcemaps: {
    deleteSourcemapsAfterUpload: true,
  },

  // Upload wider set of client files for better stack trace resolution
  widenClientFileUpload: true,

  // Create a proxy route to bypass ad-blockers
  tunnelRoute: "/monitoring",

  // Disable Sentry telemetry
  telemetry: false,
});
