import { getDb } from "@/lib/db";
import { createHmac, timingSafeEqual } from "crypto";
import { dispatchEvent } from "@/lib/dispatch";

// Receives Sentry webhook events from Internal Integration
// Auth: HMAC-SHA256 signature verification via SENTRY_CLIENT_SECRET
// Handles: Issue alerts (new issues, error spikes) → triggers Healer/urgent dispatch

function verifySentrySignature(payload: string, signature: string | null, secret: string): boolean {
  if (!signature) return false;

  // Sentry uses format: signature without prefix
  const expected = createHmac("sha256", secret).update(payload).digest("hex");

  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  const rawBody = await req.text();
  const signature = req.headers.get("sentry-hook-signature");
  const sentryResource = req.headers.get("sentry-hook-resource");

  // Verify webhook signature
  const secret = process.env.SENTRY_CLIENT_SECRET;
  if (secret && !verifySentrySignature(rawBody, signature, secret)) {
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const sql = getDb();

  // Handle different Sentry webhook resources
  switch (sentryResource) {
    case "issue": {
      const action = body.action;
      const issue = body.data?.issue;

      if (!issue) break;

      const issueId = issue.id;
      const issueTitle = issue.title || "Unknown error";
      const issueLevel = issue.level || "error";
      const project = issue.project?.name || "unknown";
      const culprit = issue.culprit || "";
      const eventCount = issue.count || 0;
      const firstSeen = issue.firstSeen;
      const lastSeen = issue.lastSeen;
      const permalink = issue.permalink || "";

      // Extract error details
      const errorType = issue.metadata?.type || "";
      const errorValue = issue.metadata?.value || issueTitle;

      // Log the Sentry event
      await sql`
        INSERT INTO agent_actions (company_id, agent, action_type, description, status, output, started_at, finished_at)
        VALUES (
          null, 'sentry', 'issue_webhook',
          ${`Sentry ${action}: ${issueTitle} (${project})`},
          'success',
          ${JSON.stringify({
            issue_id: issueId,
            action,
            title: issueTitle,
            level: issueLevel,
            project,
            culprit,
            event_count: eventCount,
            error_type: errorType,
            error_value: errorValue,
            permalink,
            first_seen: firstSeen,
            last_seen: lastSeen
          })}::jsonb,
          now(), now()
        )
      `;

      // Route based on action type
      switch (action) {
        case "created": {
          // New Issue alert - trigger Healer evaluation
          console.log(`[sentry] New issue detected: ${issueTitle} in ${project}`);

          await dispatchEvent("healer_trigger", {
            source: "sentry_webhook",
            trigger_type: "new_issue",
            issue_id: issueId,
            error_type: errorType,
            error_message: errorValue,
            project,
            permalink,
            company: "_hive" // Sentry monitors Hive itself
          });

          // Send Telegram notification for new issues
          import("@/lib/telegram").then(({ notifyHive }) =>
            notifyHive({
              agent: "sentry",
              action: "new_issue",
              company: "_hive",
              status: "started",
              summary: `New error detected: ${issueTitle} in ${project}`,
            })
          ).catch(() => {});

          break;
        }

        case "updated": {
          // Check if this is an error spike (rapid increase in events)
          const recentEventCount = eventCount || 0;

          // Parse timestamps to calculate event rate
          let isSpike = false;
          if (firstSeen && lastSeen) {
            const firstTime = new Date(firstSeen).getTime();
            const lastTime = new Date(lastSeen).getTime();
            const timeDiffMinutes = (lastTime - firstTime) / (1000 * 60);

            // Error spike: >5 events in 5 minutes (configurable threshold)
            if (timeDiffMinutes <= 5 && recentEventCount >= 5) {
              isSpike = true;
            }
          }

          if (isSpike) {
            console.log(`[sentry] Error spike detected: ${recentEventCount} events in 5min for ${issueTitle}`);

            // Error spike - trigger urgent dispatch
            await dispatchEvent("ops_escalation", {
              source: "sentry_webhook",
              trigger_type: "error_spike",
              issue_id: issueId,
              error_type: errorType,
              error_message: errorValue,
              event_count: recentEventCount,
              project,
              permalink,
              company: "_hive",
              urgency: "high"
            });

            // Send urgent Telegram notification
            import("@/lib/telegram").then(({ notifyHive }) =>
              notifyHive({
                agent: "sentry",
                action: "error_spike",
                company: "_hive",
                status: "failed",
                summary: `🚨 Error spike: ${recentEventCount} events in 5min - ${issueTitle}`,
              })
            ).catch(() => {});
          }

          break;
        }

        default:
          // Log other actions (resolved, ignored, etc.) for monitoring
          console.log(`[sentry] Issue ${action}: ${issueTitle} in ${project}`);
          break;
      }

      break;
    }

    default:
      console.log(`[sentry] Unhandled webhook resource: ${sentryResource}`);
      break;
  }

  return Response.json({ received: true });
}