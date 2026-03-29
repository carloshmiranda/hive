import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import crypto from "crypto";

// Resend webhook events: https://resend.com/docs/dashboard/webhooks/introduction
export async function POST(req: NextRequest) {
  const sql = getDb();
  // Verify webhook signature if secret is configured
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (secret) {
    const signature = req.headers.get("svix-signature");
    const timestamp = req.headers.get("svix-timestamp");
    const msgId = req.headers.get("svix-id");
    if (!signature || !timestamp || !msgId) {
      return NextResponse.json({ error: "Missing signature headers" }, { status: 401 });
    }
    // Basic timestamp check (within 5 minutes)
    const ts = parseInt(timestamp, 10);
    if (Math.abs(Date.now() / 1000 - ts) > 300) {
      return NextResponse.json({ error: "Timestamp too old" }, { status: 401 });
    }
  }

  try {
    const body = await req.json();
    const { type, data } = body;

    if (!data?.email_id) {
      return NextResponse.json({ ok: true, skipped: true });
    }

    const resendId = data.email_id;

    switch (type) {
      case "email.delivered":
        await sql`UPDATE email_log SET status = 'delivered' WHERE resend_id = ${resendId} AND status = 'sent'`;
        break;

      case "email.opened":
        await sql`UPDATE email_log SET status = 'opened', opened_at = now() WHERE resend_id = ${resendId} AND status IN ('sent', 'delivered')`;
        // Update sequence open count
        await sql`
          UPDATE email_sequences SET open_count = open_count + 1
          WHERE id = (SELECT sequence_id FROM email_log WHERE resend_id = ${resendId} LIMIT 1)
          AND (SELECT sequence_id FROM email_log WHERE resend_id = ${resendId} LIMIT 1) IS NOT NULL
        `;
        break;

      case "email.clicked":
        await sql`UPDATE email_log SET status = 'clicked', clicked_at = now() WHERE resend_id = ${resendId} AND status IN ('sent', 'delivered', 'opened')`;
        // Update sequence click count
        await sql`
          UPDATE email_sequences SET click_count = click_count + 1
          WHERE id = (SELECT sequence_id FROM email_log WHERE resend_id = ${resendId} LIMIT 1)
          AND (SELECT sequence_id FROM email_log WHERE resend_id = ${resendId} LIMIT 1) IS NOT NULL
        `;
        break;

      case "email.bounced":
        await sql`UPDATE email_log SET status = 'bounced', bounced_at = now() WHERE resend_id = ${resendId}`;
        // Mark waitlist entry as churned if it was a waitlist email
        const [bouncedLog] = await sql`SELECT recipient FROM email_log WHERE resend_id = ${resendId}`;
        if (bouncedLog) {
          await sql`UPDATE waitlist SET status = 'churned' WHERE email = ${bouncedLog.recipient} AND status = 'waiting'`;
        }
        break;

      case "email.complained":
        await sql`UPDATE email_log SET status = 'complained' WHERE resend_id = ${resendId}`;
        const [complainedLog] = await sql`SELECT recipient FROM email_log WHERE resend_id = ${resendId}`;
        if (complainedLog) {
          await sql`UPDATE waitlist SET status = 'churned' WHERE email = ${complainedLog.recipient} AND status = 'waiting'`;
        }
        break;
    }

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    console.error("Resend webhook error:", error);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
