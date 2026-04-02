import { json, err, getDb } from "@/lib/db";
import { verifyCronAuth } from "@/lib/qstash";
import { qstashPublish } from "@/lib/qstash";
import { setSentryTags, addDispatchBreadcrumb } from "@/lib/sentry-tags";

// POST /api/dispatch/qstash-failure — QStash failure callback endpoint
// Called by QStash when all delivery retries for a message are exhausted.
// Auth: QStash signature (failure callbacks are signed just like regular messages)
//
// QStash failure callback payload:
//   sourceMessageId, topicName, url (original target URL), method, body (original body),
//   maxRetries, retried, dlqId, responseStatus, responseBody, responseHeaders
export async function POST(req: Request) {
  const auth = await verifyCronAuth(req);
  if (!auth.authorized) return err("Unauthorized", 401);

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return err("Invalid JSON body", 400);
  }

  const {
    sourceMessageId,
    url: originalUrl,
    responseStatus,
    responseBody,
    retried,
    maxRetries,
  } = payload as {
    sourceMessageId?: string;
    url?: string;
    responseStatus?: number;
    responseBody?: string;
    retried?: number;
    maxRetries?: number;
  };

  // Extract the path from the original URL for readable logging
  let targetPath = "(unknown)";
  try {
    if (originalUrl) targetPath = new URL(originalUrl).pathname;
  } catch {
    targetPath = String(originalUrl || "(unknown)");
  }

  const errorDetail = [
    `target: ${targetPath}`,
    responseStatus !== undefined ? `status: ${responseStatus}` : null,
    retried !== undefined && maxRetries !== undefined
      ? `retries: ${retried}/${maxRetries}`
      : null,
    responseBody ? `response: ${String(responseBody).slice(0, 200)}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  setSentryTags({ agent: "dispatch", action_type: "qstash_failure", route: "/api/dispatch/qstash-failure" });
  addDispatchBreadcrumb({
    category: "qstash",
    message: "Dead dispatch — all retries exhausted",
    data: { targetPath, responseStatus, retried, maxRetries, sourceMessageId },
  });

  console.error(`[qstash-failure] Dead dispatch detected — ${errorDetail}`);

  // Log to agent_actions for observability
  try {
    const sql = getDb();
    await sql`
      INSERT INTO agent_actions (agent, action_type, status, error, description, output, started_at)
      VALUES (
        'dispatch',
        'qstash_failure',
        'failed',
        ${errorDetail},
        ${`Dead dispatch: ${targetPath} failed after all retries`},
        ${JSON.stringify({
          source_message_id: sourceMessageId,
          target_path: targetPath,
          response_status: responseStatus,
          retried,
          max_retries: maxRetries,
        })},
        NOW()
      )
    `;
  } catch (e) {
    // Non-fatal — don't block the 200 response to QStash
    console.error("[qstash-failure] Failed to log to agent_actions:", e);
  }

  // Fire Telegram notification (non-blocking)
  qstashPublish("/api/notify", {
    agent: "dispatch",
    action: "qstash_failure",
    status: "failed",
    summary: `Dead dispatch: ${targetPath} failed after all retries`,
    error: errorDetail,
  }).catch(() => null);

  return json({ ok: true });
}
