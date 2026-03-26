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
