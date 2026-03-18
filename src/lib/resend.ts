import { getSettingValue } from "./settings";

interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  from?: string;
}

export async function sendEmail(opts: EmailOptions): Promise<{ success: boolean; id?: string; error?: string }> {
  const apiKey = await getSettingValue("resend_api_key");
  if (!apiKey) return { success: false, error: "Resend API key not configured" };

  const fromAddress = opts.from || await getSettingValue("digest_email") || "Hive <noreply@hive.local>";

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: fromAddress,
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
      }),
    });
    const data = await res.json();
    if (!res.ok) return { success: false, error: data.message || `HTTP ${res.status}` };
    return { success: true, id: data.id };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// === DIGEST EMAIL ===

interface CompanyResult {
  name: string;
  slug: string;
  status: string;
  cycleScore?: number;
  wins: string[];
  misses: string[];
  metrics?: Record<string, string | number>;
}

interface DigestData {
  date: string;
  totalDuration: string;
  companies: CompanyResult[];
  approvalsPending: Array<{ title: string; gateType: string; companyName?: string }>;
  scoutProposal?: { name: string; description: string; confidence: number };
  errors: string[];
  portfolioMrr: number;
  portfolioCustomers: number;
}

export function renderDigestHtml(data: DigestData): string {
  const companyRows = data.companies.map(c => {
    const scoreColor = (c.cycleScore || 0) >= 7 ? "#1D9E75" : (c.cycleScore || 0) >= 4 ? "#BA7517" : "#E24B4A";
    const winsHtml = c.wins.length ? c.wins.map(w => `<li style="color:#1D9E75">✓ ${w}</li>`).join("") : "";
    const missesHtml = c.misses.length ? c.misses.map(m => `<li style="color:#E24B4A">✗ ${m}</li>`).join("") : "";
    return `
      <tr>
        <td style="padding:12px 16px;border-bottom:1px solid #2C2C2A">
          <strong style="color:#F0F0EC">${c.name}</strong>
          <span style="color:#888780;font-size:13px"> (${c.slug})</span>
          <span style="display:inline-block;margin-left:8px;padding:2px 8px;border-radius:10px;font-size:12px;background:${scoreColor};color:#fff">${c.cycleScore || "—"}/10</span>
          <ul style="margin:6px 0 0;padding-left:18px;font-size:13px">${winsHtml}${missesHtml}</ul>
        </td>
      </tr>`;
  }).join("");

  const approvalsHtml = data.approvalsPending.length
    ? data.approvalsPending.map(a =>
        `<tr><td style="padding:8px 16px;border-bottom:1px solid #2C2C2A;color:#F0F0EC;font-size:14px">
          <span style="padding:2px 8px;border-radius:4px;background:#534AB7;color:#fff;font-size:12px;margin-right:8px">${a.gateType}</span>
          ${a.title}${a.companyName ? ` <span style="color:#888780">(${a.companyName})</span>` : ""}
        </td></tr>`
      ).join("")
    : `<tr><td style="padding:8px 16px;color:#888780;font-size:14px">No pending approvals</td></tr>`;

  const scoutHtml = data.scoutProposal
    ? `<div style="margin:16px 0;padding:12px 16px;border-left:3px solid #EF9F27;background:#1a1a18">
        <strong style="color:#EF9F27">💡 Idea Scout proposed:</strong>
        <span style="color:#F0F0EC"> ${data.scoutProposal.name}</span>
        <div style="color:#888780;font-size:13px;margin-top:4px">${data.scoutProposal.description} (${Math.round(data.scoutProposal.confidence * 100)}% confidence)</div>
      </div>`
    : "";

  const errorsHtml = data.errors.length
    ? `<div style="margin:16px 0;padding:12px 16px;border-left:3px solid #E24B4A;background:#1a1a18">
        <strong style="color:#E24B4A">⚠ Errors:</strong>
        <ul style="margin:4px 0 0;padding-left:18px;font-size:13px;color:#F09595">${data.errors.map(e => `<li>${e}</li>`).join("")}</ul>
      </div>`
    : "";

  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#0a0a09;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#B4B2A9">
  <div style="max-width:600px;margin:0 auto;padding:24px">
    
    <div style="text-align:center;margin-bottom:24px">
      <span style="font-size:28px">🐝</span>
      <h1 style="color:#EF9F27;font-size:20px;margin:8px 0 0;font-weight:500">Hive nightly digest</h1>
      <div style="color:#888780;font-size:13px">${data.date} · ${data.totalDuration}</div>
    </div>

    <div style="display:flex;gap:16px;margin-bottom:20px;text-align:center">
      <div style="flex:1;padding:12px;background:#1a1a18;border-radius:8px">
        <div style="color:#EF9F27;font-size:22px;font-weight:600">€${data.portfolioMrr}</div>
        <div style="color:#888780;font-size:12px">Portfolio MRR</div>
      </div>
      <div style="flex:1;padding:12px;background:#1a1a18;border-radius:8px">
        <div style="color:#5DCAA5;font-size:22px;font-weight:600">${data.portfolioCustomers}</div>
        <div style="color:#888780;font-size:12px">Total customers</div>
      </div>
      <div style="flex:1;padding:12px;background:#1a1a18;border-radius:8px">
        <div style="color:#AFA9EC;font-size:22px;font-weight:600">${data.companies.length}</div>
        <div style="color:#888780;font-size:12px">Active companies</div>
      </div>
    </div>

    ${scoutHtml}

    <h2 style="color:#F0F0EC;font-size:16px;margin:20px 0 8px;font-weight:500">Company results</h2>
    <table style="width:100%;border-collapse:collapse;background:#111110;border-radius:8px;overflow:hidden">
      ${companyRows || `<tr><td style="padding:12px 16px;color:#888780;font-size:14px">No active companies</td></tr>`}
    </table>

    <h2 style="color:#F0F0EC;font-size:16px;margin:20px 0 8px;font-weight:500">Awaiting your decision</h2>
    <table style="width:100%;border-collapse:collapse;background:#111110;border-radius:8px;overflow:hidden">
      ${approvalsHtml}
    </table>

    ${errorsHtml}

    <div style="text-align:center;margin-top:24px;padding-top:16px;border-top:1px solid #2C2C2A">
      <div style="color:#888780;font-size:12px">Open the <a href="{{DASHBOARD_URL}}" style="color:#EF9F27;text-decoration:none">Hive dashboard</a> to approve, reject, or send directives.</div>
    </div>
  </div>
</body>
</html>`;
}

// === TRANSACTIONAL EMAIL TEMPLATES ===
// Used by company boilerplates for customer-facing emails

function emailShell(companyName: string, content: string, accentColor = "#EF9F27"): string {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f8f8f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#333">
    <div style="max-width:560px;margin:0 auto;padding:32px 16px">
      <div style="background:#fff;border-radius:12px;padding:32px;border:1px solid #e8e8e4">
        <div style="font-size:18px;font-weight:600;color:#1a1a1a;margin-bottom:24px">${companyName}</div>
        ${content}
      </div>
      <div style="text-align:center;margin-top:16px;font-size:11px;color:#999">
        Sent by ${companyName} · Powered by Hive
      </div>
    </div>
  </body></html>`;
}

export function renderWelcomeEmail(opts: {
  companyName: string;
  customerName: string;
  loginUrl: string;
  accentColor?: string;
}): string {
  return emailShell(opts.companyName, `
    <p style="font-size:16px;line-height:1.6;color:#333;margin:0 0 16px">
      Hey ${opts.customerName},
    </p>
    <p style="font-size:15px;line-height:1.6;color:#555;margin:0 0 24px">
      Welcome to ${opts.companyName}! Your account is ready. Here's what to do next:
    </p>
    <a href="${opts.loginUrl}" style="display:inline-block;padding:12px 28px;background:${opts.accentColor || "#EF9F27"};color:#fff;text-decoration:none;border-radius:8px;font-weight:500;font-size:15px">
      Get started
    </a>
    <p style="font-size:13px;color:#999;margin:24px 0 0">
      If you have questions, just reply to this email.
    </p>
  `, opts.accentColor);
}

export function renderReceiptEmail(opts: {
  companyName: string;
  customerName: string;
  amount: string;
  currency: string;
  plan: string;
  invoiceUrl?: string;
  accentColor?: string;
}): string {
  return emailShell(opts.companyName, `
    <p style="font-size:16px;line-height:1.6;color:#333;margin:0 0 16px">
      Hey ${opts.customerName},
    </p>
    <p style="font-size:15px;line-height:1.6;color:#555;margin:0 0 24px">
      Thanks for your payment. Here's your receipt:
    </p>
    <div style="background:#f8f8f6;border-radius:8px;padding:20px;margin-bottom:24px">
      <table style="width:100%;font-size:14px;color:#555">
        <tr><td style="padding:6px 0">Plan</td><td style="text-align:right;font-weight:500;color:#1a1a1a">${opts.plan}</td></tr>
        <tr><td style="padding:6px 0">Amount</td><td style="text-align:right;font-weight:500;color:#1a1a1a">${opts.currency}${opts.amount}</td></tr>
        <tr><td style="padding:6px 0">Date</td><td style="text-align:right;color:#1a1a1a">${new Date().toLocaleDateString("en-GB", { year: "numeric", month: "long", day: "numeric" })}</td></tr>
      </table>
    </div>
    ${opts.invoiceUrl ? `<a href="${opts.invoiceUrl}" style="color:${opts.accentColor || "#EF9F27"};text-decoration:none;font-size:14px">View full invoice →</a>` : ""}
  `, opts.accentColor);
}

export function renderPasswordResetEmail(opts: {
  companyName: string;
  resetUrl: string;
  expiresIn?: string;
  accentColor?: string;
}): string {
  return emailShell(opts.companyName, `
    <p style="font-size:15px;line-height:1.6;color:#555;margin:0 0 24px">
      Someone requested a password reset for your account. If this was you, click the button below:
    </p>
    <a href="${opts.resetUrl}" style="display:inline-block;padding:12px 28px;background:${opts.accentColor || "#EF9F27"};color:#fff;text-decoration:none;border-radius:8px;font-weight:500;font-size:15px">
      Reset password
    </a>
    <p style="font-size:13px;color:#999;margin:24px 0 0">
      This link expires in ${opts.expiresIn || "1 hour"}. If you didn't request this, you can safely ignore this email.
    </p>
  `, opts.accentColor);
}

