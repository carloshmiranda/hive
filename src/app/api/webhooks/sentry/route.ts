import { getDb } from "@/lib/db";
import { createHmac, timingSafeEqual } from "crypto";
import { getSettingValue } from "@/lib/settings";
import { setSentryTags } from "@/lib/sentry-tags";

// Sentry webhook endpoint
// Auth: HMAC-SHA256 signature verification via SENTRY_CLIENT_SECRET
// Handles issue and metric_alert payloads
// Must respond within 1 second (Sentry timeout)

function verifySentrySignature(payload: string, signature: string | null, secret: string): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  setSentryTags({
    action_type: "webhook",
    route: "/api/webhooks/sentry",
  });

  const startTime = Date.now();
  const rawBody = await req.text();
  const signature = req.headers.get("sentry-hook-signature");

  // Verify webhook signature
  const secret = await getSettingValue("sentry_client_secret").catch(() => null);
  if (!secret) {
    return Response.json({ error: "Sentry client secret not configured" }, { status: 500 });
  }

  if (!verifySentrySignature(rawBody, signature, secret)) {
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch (error) {
    return Response.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const sql = getDb();

  try {
    if (body.action === "created" || body.action === "triggered") {
      // Handle issue events (errors, crashes) and metric alerts
      const isIssue = body.data && body.data.issue;
      const isMetricAlert = body.data && body.data.metric_alert;

      if (isIssue) {
        const issue = body.data.issue;
        const issueId = issue.id;
        const fingerprint = Array.isArray(issue.metadata?.fingerprint)
          ? issue.metadata.fingerprint.join(", ")
          : issue.metadata?.fingerprint || issue.id;
        const title = issue.metadata?.title || issue.culprit || issue.title || "Unknown error";
        const culprit = issue.culprit || "Unknown";
        const tags = issue.tags || {};

        // Check if we've already processed this issue ID to avoid duplication
        const [existing] = await sql`
          SELECT id FROM agent_actions
          WHERE action_type = 'sentry_event'
          AND output->>'issue_id' = ${String(issueId)}
          AND output->>'action' = ${body.action}
          AND started_at > now() - INTERVAL '1 hour'
          LIMIT 1
        `;

        if (existing) {
          // Already processed recently, skip to avoid duplicate processing
          return Response.json({ received: true, skipped: "duplicate" });
        }

        // Extract company context from Sentry tags if available
        let companyId: string | null = null;
        if (tags.company || tags.environment) {
          const companySlug = tags.company || tags.environment;
          const [company] = await sql`SELECT id FROM companies WHERE slug = ${companySlug}`.catch(() => []);
          companyId = company?.id || null;
        }

        // Store in agent_actions table
        await sql`
          INSERT INTO agent_actions (
            company_id, agent, action_type, description, status,
            output, started_at, finished_at
          )
          VALUES (
            ${companyId},
            'webhook',
            'sentry_event',
            ${`Error: ${title.slice(0, 200)}`},
            'success',
            ${JSON.stringify({
              issue_id: String(issueId),
              action: body.action,
              fingerprint,
              title,
              culprit,
              tags,
              level: issue.level,
              platform: issue.platform,
              environment: issue.metadata?.environment || tags.environment,
              release: issue.metadata?.release || tags.release,
              url: issue.permalink || `https://sentry.io/organizations/${body.data?.organization?.slug}/issues/${issueId}/`,
              first_seen: issue.firstSeen,
              last_seen: issue.lastSeen,
              count: issue.count,
              user_count: issue.userCount,
              project: body.data?.project?.name || body.data?.project?.slug
            })}::jsonb,
            now(),
            now()
          )
        `;

      } else if (isMetricAlert) {
        const alert = body.data.metric_alert;
        const alertId = alert.id;
        const title = alert.title || alert.query || "Metric Alert";

        // Check for duplication
        const [existing] = await sql`
          SELECT id FROM agent_actions
          WHERE action_type = 'sentry_metric_alert'
          AND output->>'alert_id' = ${String(alertId)}
          AND output->>'action' = ${body.action}
          AND started_at > now() - INTERVAL '1 hour'
          LIMIT 1
        `;

        if (existing) {
          return Response.json({ received: true, skipped: "duplicate" });
        }

        // Extract company context from alert data
        let companyId: string | null = null;
        if (body.data?.project?.slug) {
          const [company] = await sql`SELECT id FROM companies WHERE slug = ${body.data.project.slug}`.catch(() => []);
          companyId = company?.id || null;
        }

        await sql`
          INSERT INTO agent_actions (
            company_id, agent, action_type, description, status,
            output, started_at, finished_at
          )
          VALUES (
            ${companyId},
            'webhook',
            'sentry_metric_alert',
            ${`Metric Alert: ${title.slice(0, 200)}`},
            'success',
            ${JSON.stringify({
              alert_id: String(alertId),
              action: body.action,
              title,
              query: alert.query,
              status: alert.status,
              threshold_type: alert.thresholdType,
              threshold_value: alert.thresholdValue,
              resolved_threshold: alert.resolvedThreshold,
              environment: alert.environment,
              url: `https://sentry.io/organizations/${body.data?.organization?.slug}/alerts/rules/${alertId}/`,
              project: body.data?.project?.name || body.data?.project?.slug
            })}::jsonb,
            now(),
            now()
          )
        `;
      }
    }

    // Ensure we respond quickly (under 1 second)
    const duration = Date.now() - startTime;
    if (duration > 900) { // 900ms warning threshold
      console.warn(`Sentry webhook processing took ${duration}ms - close to 1s timeout`);
    }

    return Response.json({ received: true, processed_in_ms: duration });

  } catch (error) {
    // Log error but don't fail the webhook - Sentry will retry on 5xx
    console.error('Sentry webhook processing error:', error);

    await sql`
      INSERT INTO agent_actions (
        company_id, agent, action_type, description, status, error, started_at, finished_at
      )
      VALUES (
        NULL, 'webhook', 'sentry_event', 'Failed to process Sentry webhook', 'failed',
        ${String(error)}, now(), now()
      )
    `.catch(() => {}); // Don't fail on logging failure

    return Response.json({ error: "Internal processing error" }, { status: 500 });
  }
}