import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import { setSentryTags } from "@/lib/sentry-tags";

export async function GET() {
  // Set Sentry tags for error triage and filtering
  setSentryTags({
    action_type: "cron",
    route: "/api/cron/uptime-monitor"
  });

  return await Sentry.withMonitor(
    "hive-uptime-monitor",
    async () => {
      try {
        // Check the health endpoint from within the app
        const healthUrl = process.env.VERCEL_URL
          ? `https://${process.env.VERCEL_URL}/api/health?public=true`
          : "http://localhost:3000/api/health?public=true";

        const response = await fetch(healthUrl, {
          method: "GET",
          headers: {
            "User-Agent": "Hive-Internal-Uptime-Monitor/1.0",
          },
          // Set a reasonable timeout
          signal: AbortSignal.timeout(30000), // 30 seconds
        });

        if (!response.ok) {
          throw new Error(`Health check failed with status ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();

        if (data.status !== "healthy") {
          throw new Error(`Health check returned unhealthy status: ${JSON.stringify(data)}`);
        }

        console.log("[uptime-monitor] Health check passed:", data);
        return NextResponse.json({
          ok: true,
          status: "healthy",
          checked_url: healthUrl,
          timestamp: new Date().toISOString()
        });

      } catch (error) {
        console.error("[uptime-monitor] Health check failed:", error);
        // Re-throw so Sentry marks this as a failed check-in
        throw error;
      }
    },
    {
      schedule: {
        type: "crontab",
        value: "*/5 * * * *", // Every 5 minutes
      },
      checkinMargin: 2, // 2 minutes grace period
      maxRuntime: 2, // Max 2 minutes to complete
      timezone: "UTC",
      failureIssueThreshold: 3, // Create issue after 3 consecutive failures
      recoveryThreshold: 2, // Resolve issue after 2 consecutive successes
    }
  );
}