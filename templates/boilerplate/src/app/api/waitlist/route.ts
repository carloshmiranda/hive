import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";

function getDb() {
  return neon(process.env.DATABASE_URL!);
}

function json(data: any, status = 200) {
  return NextResponse.json(data, { status });
}

// POST /api/waitlist — join the waitlist
export async function POST(req: NextRequest) {
  const sql = getDb();
  try {
    const body = await req.json();
    const { email, name, ref } = body as { email?: string; name?: string; ref?: string };

    if (!email || !email.includes("@")) {
      return json({ ok: false, error: "Valid email is required" }, 400);
    }

    // Check for existing signup
    const [existing] = await sql`SELECT id, referral_code, position FROM waitlist WHERE email = ${email}`;
    if (existing) {
      return json({
        ok: true,
        already_signed_up: true,
        referral_code: existing.referral_code,
        position: existing.position,
      });
    }

    // Generate a short referral code
    const referralCode = Math.random().toString(36).substring(2, 8).toUpperCase();

    // Get next position
    const [{ count }] = await sql`SELECT COUNT(*) as count FROM waitlist`;
    const position = Number(count) + 1;

    // Extract UTM params from referrer or body
    const utmSource = body.utm_source || null;
    const utmMedium = body.utm_medium || null;
    const utmCampaign = body.utm_campaign || null;

    // Determine source
    let source = "organic";
    let referredBy = null;
    if (ref) {
      const [referrer] = await sql`SELECT id FROM waitlist WHERE referral_code = ${ref}`;
      if (referrer) {
        referredBy = referrer.id;
        source = "referral";
        // Increment referrer's count
        await sql`UPDATE waitlist SET referral_count = referral_count + 1 WHERE id = ${referrer.id}`;
      }
    }

    const [entry] = await sql`
      INSERT INTO waitlist (email, name, referral_code, referred_by, position, source, utm_source, utm_medium, utm_campaign)
      VALUES (${email}, ${name || null}, ${referralCode}, ${referredBy}, ${position}, ${source}, ${utmSource}, ${utmMedium}, ${utmCampaign})
      RETURNING id, referral_code, position
    `;

    // Send confirmation email if Resend is configured
    const resendKey = process.env.RESEND_API_KEY;
    if (resendKey) {
      try {
        const [welcomeEmail] = await sql`
          SELECT subject, body_html, body_text FROM email_sequences
          WHERE sequence = 'waitlist_welcome' AND step = 1 AND variant = 'a' AND is_active = true
        `;
        if (welcomeEmail) {
          const subject = welcomeEmail.subject.replace("{{POSITION}}", String(position));
          const bodyHtml = welcomeEmail.body_html
            .replace(/\{\{NAME\}\}/g, name || "there")
            .replace(/\{\{POSITION\}\}/g, String(position))
            .replace(/\{\{REFERRAL_CODE\}\}/g, referralCode)
            .replace(/\{\{REFERRAL_LINK\}\}/g, `${process.env.NEXT_PUBLIC_URL}?ref=${referralCode}`);

          const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              from: `{{COMPANY_NAME}} <hello@${process.env.SENDING_DOMAIN || "resend.dev"}>`,
              to: email,
              subject,
              html: bodyHtml,
              text: welcomeEmail.body_text || undefined,
            }),
          });
          if (res.ok) {
            const { id: resendId } = await res.json();
            await sql`
              INSERT INTO email_log (recipient, sequence_id, subject, resend_id)
              VALUES (${email}, ${welcomeEmail.id || null}, ${subject}, ${resendId})
            `;
            // Increment send count
            await sql`UPDATE email_sequences SET send_count = send_count + 1 WHERE sequence = 'waitlist_welcome' AND step = 1 AND variant = 'a'`;
          }
        }
      } catch (e) {
        console.error("Waitlist email failed (non-blocking):", e);
      }
    }

    return json({
      ok: true,
      referral_code: entry.referral_code,
      position: entry.position,
    });
  } catch (error: any) {
    console.error("Waitlist signup error:", error);
    return json({ ok: false, error: "Failed to join waitlist" }, 500);
  }
}

// GET /api/waitlist?email=... — check position
export async function GET(req: NextRequest) {
  const sql = getDb();
  const email = req.nextUrl.searchParams.get("email");
  if (!email) return json({ ok: false, error: "email param required" }, 400);

  const [entry] = await sql`
    SELECT position, referral_code, referral_count, status, created_at
    FROM waitlist WHERE email = ${email}
  `;
  if (!entry) return json({ ok: false, error: "Not found" }, 404);

  const [{ count }] = await sql`SELECT COUNT(*) as count FROM waitlist WHERE status = 'waiting'`;

  return json({
    ok: true,
    position: entry.position,
    referral_code: entry.referral_code,
    referral_count: entry.referral_count,
    total_waiting: Number(count),
    status: entry.status,
  });
}
