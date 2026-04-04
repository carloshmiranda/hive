import { Client, Receiver } from "@upstash/qstash";

let _client: Client | null = null;
let _receiver: Receiver | null = null;

export function getQStashClient(): Client {
  if (!_client) {
    const token = process.env.QSTASH_TOKEN;
    if (!token) throw new Error("QSTASH_TOKEN not set");
    _client = new Client({ token });
  }
  return _client;
}

function getReceiver(): Receiver | null {
  if (!_receiver) {
    const current = process.env.QSTASH_CURRENT_SIGNING_KEY;
    const next = process.env.QSTASH_NEXT_SIGNING_KEY;
    if (!current) return null;
    _receiver = new Receiver({
      currentSigningKey: current,
      nextSigningKey: next || current,
    });
  }
  return _receiver;
}

/**
 * Dual-mode cron auth: accepts EITHER QStash signature (POST) OR CRON_SECRET (GET/POST).
 * During migration both work. After removing Vercel crons, QStash is primary
 * and CRON_SECRET remains for internal server-to-server calls (e.g. sentinel → company-health).
 */
/**
 * Publish a message to an internal Hive endpoint via QStash for guaranteed delivery.
 * Falls back to direct fetch if QSTASH_TOKEN is not configured.
 * Use for fire-and-forget dispatches where retry + delivery guarantee matters.
 */
export async function qstashPublish(
  path: string,
  body: Record<string, unknown>,
  options?: {
    retries?: number;
    deduplicationId?: string;
    delay?: number;
    /** If true, QStash will POST to /api/dispatch/qstash-failure when all retries are exhausted. */
    failureCallback?: boolean;
    /**
     * QStash Flow Control: limits concurrent messages delivered for a given key.
     * Use to enforce at-most-N parallelism for a specific agent or work type
     * without DB polling. QStash queues excess messages and delivers them as
     * in-flight messages complete.
     */
    flowControl?: { key: string; parallelism: number };
  }
): Promise<{ messageId: string } | null> {
  const baseUrl = process.env.NEXT_PUBLIC_URL || "https://hive-phi.vercel.app";
  const cronSecret = process.env.CRON_SECRET;

  // If QStash not configured, fall back to direct fetch (fire-and-forget)
  const token = process.env.QSTASH_TOKEN;
  if (!token) {
    console.warn(`[qstash] QSTASH_TOKEN not set — falling back to direct fetch for ${path}. No retry, no delivery guarantee.`);
    await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        ...(cronSecret && { Authorization: `Bearer ${cronSecret}` }),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    }).catch(() => null);
    return null;
  }

  const client = getQStashClient();
  const result = await client.publishJSON({
    url: `${baseUrl}${path}`,
    body,
    retries: options?.retries ?? 3,
    headers: {
      ...(cronSecret && { Authorization: `Bearer ${cronSecret}` }),
    },
    ...(options?.deduplicationId && { deduplicationId: options.deduplicationId }),
    ...(options?.delay && { delay: options.delay }),
    ...(options?.failureCallback && {
      failureCallback: `${baseUrl}/api/dispatch/qstash-failure`,
    }),
    ...(options?.flowControl && { flowControl: options.flowControl }),
  });

  return { messageId: result.messageId };
}

export async function verifyCronAuth(
  req: Request
): Promise<{ authorized: true; source: string } | { authorized: false; error: string }> {
  // Path 1: QStash signature (POST from QStash schedules)
  const signature = req.headers.get("upstash-signature");
  if (signature) {
    const receiver = getReceiver();
    if (receiver) {
      try {
        const body = await req.clone().text();
        const isValid = await receiver.verify({ signature, body });
        if (isValid) return { authorized: true, source: "qstash" };
      } catch {
        // Signature invalid — fall through to CRON_SECRET
      }
    }
  }

  // Path 2: CRON_SECRET (Vercel cron or internal server-to-server calls)
  const authHeader = req.headers.get("authorization");
  if (authHeader === `Bearer ${process.env.CRON_SECRET}`) {
    return { authorized: true, source: "cron_secret" };
  }

  return { authorized: false, error: "Unauthorized" };
}
