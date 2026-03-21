import { getDb } from "@/lib/db";
import { getSettingValue } from "@/lib/settings";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sql = getDb();

  const digestEmail = await getSettingValue("digest_email");
  const resendApiKey = await getSettingValue("resend_api_key");
  const sendingDomain = await getSettingValue("sending_domain");

  if (!digestEmail || !resendApiKey) {
    return Response.json({
      ok: true,
      skipped: true,
      reason: !digestEmail
        ? "digest_email not configured"
        : "resend_api_key not configured",
    });
  }

  // Portfolio: companies with latest metrics
  const companies = await sql`
    SELECT c.slug, c.status, c.company_type,
      COALESCE(m.mrr, 0) as mrr,
      COALESCE(m.customers, 0) as customers
    FROM companies c
    LEFT JOIN (
      SELECT DISTINCT ON (company_id) company_id, mrr, customers
      FROM metrics ORDER BY company_id, date DESC
    ) m ON m.company_id = c.id
    WHERE c.status IN ('idea','approved','provisioning','mvp','active')
    ORDER BY c.status, c.slug
  `;

  // 24h agent activity
  const actions = await sql`
    SELECT agent, status, COUNT(*) as cnt
    FROM agent_actions
    WHERE finished_at > NOW() - INTERVAL '24 hours'
    GROUP BY agent, status
    ORDER BY agent
  `;

  // Pending approvals
  const approvals = await sql`
    SELECT gate_type, title FROM approvals
    WHERE status = 'pending'
    ORDER BY created_at
  `;

  // Recent errors
  const errors = await sql`
    SELECT agent, error, company_id
    FROM agent_actions
    WHERE status = 'failed'
    AND finished_at > NOW() - INTERVAL '24 hours'
    ORDER BY finished_at DESC
    LIMIT 5
  `;

  const totalMrr = companies.reduce(
    (sum: number, c: Record<string, unknown>) => sum + Number(c.mrr),
    0
  );
  const totalCustomers = companies.reduce(
    (sum: number, c: Record<string, unknown>) => sum + Number(c.customers),
    0
  );

  const html = buildDigestHtml({
    companies: companies as DigestData["companies"],
    actions: actions as DigestData["actions"],
    approvals: approvals as DigestData["approvals"],
    errors: errors as DigestData["errors"],
    totalMrr,
    totalCustomers,
  });

  const fromAddr = sendingDomain
    ? `digest@${sendingDomain}`
    : "onboarding@resend.dev";

  const subject = `Hive Digest — ${companies.length} cos, EUR ${totalMrr.toFixed(2)} MRR, ${approvals.length} pending`;

  const emailRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `Hive <${fromAddr}>`,
      to: [digestEmail],
      subject,
      html,
    }),
  });

  const emailOk = emailRes.ok;
  const emailBody = await emailRes.json();

  // Log to agent_actions
  await sql`
    INSERT INTO agent_actions (agent, action_type, status, description, output, started_at, finished_at)
    VALUES (
      'ops',
      'daily_digest',
      ${emailOk ? "success" : "failed"},
      ${`Digest sent: ${companies.length} companies, EUR ${totalMrr.toFixed(2)} MRR, ${approvals.length} pending approvals`},
      ${JSON.stringify({ email_ok: emailOk, to: digestEmail, companies: companies.length })}::jsonb,
      NOW(),
      NOW()
    )
  `;

  return Response.json({
    ok: emailOk,
    sent_to: digestEmail,
    companies: companies.length,
    total_mrr: totalMrr,
    pending_approvals: approvals.length,
    errors_24h: errors.length,
  });
}

// --- HTML builder ---

interface DigestData {
  companies: Array<{
    slug: string;
    status: string;
    company_type: string | null;
    mrr: number;
    customers: number;
  }>;
  actions: Array<{ agent: string; status: string; cnt: number }>;
  approvals: Array<{ gate_type: string; title: string }>;
  errors: Array<{
    agent: string;
    error: string | null;
    company_id: string | null;
  }>;
  totalMrr: number;
  totalCustomers: number;
}

function buildDigestHtml(d: DigestData): string {
  const now = new Date().toISOString();

  const companyRows = d.companies
    .map(
      (c) =>
        `<tr>
      <td style="padding:4px 12px">${c.slug}</td>
      <td style="padding:4px 12px">${c.status}</td>
      <td style="padding:4px 12px;text-align:right">EUR ${Number(c.mrr).toFixed(2)}</td>
      <td style="padding:4px 12px;text-align:right">${c.customers}</td>
    </tr>`
    )
    .join("");

  const activityRows = d.actions.length
    ? d.actions
        .map(
          (a) =>
            `<tr>
        <td style="padding:4px 12px">${a.agent}</td>
        <td style="padding:4px 12px">${a.status}</td>
        <td style="padding:4px 12px;text-align:right">${a.cnt}</td>
      </tr>`
        )
        .join("")
    : '<tr><td style="padding:4px 12px" colspan="3">No agent activity in the last 24h.</td></tr>';

  const approvalItems = d.approvals.length
    ? d.approvals
        .map((a) => `<li><strong>${a.gate_type}</strong>: ${a.title}</li>`)
        .join("")
    : "<li>None</li>";

  const errorItems = d.errors.length
    ? d.errors
        .map(
          (e) =>
            `<li><strong>${e.agent}</strong>${e.company_id ? ` (${e.company_id})` : ""}: ${e.error || "unknown error"}</li>`
        )
        .join("")
    : "<li>None</li>";

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:0 auto;padding:20px;color:#1a1a1a">
  <h1 style="font-size:20px;margin-bottom:4px">Hive Daily Digest</h1>
  <p style="color:#666;margin-top:0">${d.companies.length} companies &middot; EUR ${d.totalMrr.toFixed(2)} MRR &middot; ${d.totalCustomers} customers</p>

  <h2 style="font-size:16px;border-bottom:1px solid #ddd;padding-bottom:4px">Portfolio</h2>
  <table style="width:100%;border-collapse:collapse;font-size:14px">
    <tr style="background:#f5f5f5">
      <th style="padding:4px 12px;text-align:left">Company</th>
      <th style="padding:4px 12px;text-align:left">Status</th>
      <th style="padding:4px 12px;text-align:right">MRR</th>
      <th style="padding:4px 12px;text-align:right">Customers</th>
    </tr>
    ${companyRows}
  </table>

  <h2 style="font-size:16px;border-bottom:1px solid #ddd;padding-bottom:4px;margin-top:24px">Agent Activity (24h)</h2>
  <table style="width:100%;border-collapse:collapse;font-size:14px">
    <tr style="background:#f5f5f5">
      <th style="padding:4px 12px;text-align:left">Agent</th>
      <th style="padding:4px 12px;text-align:left">Status</th>
      <th style="padding:4px 12px;text-align:right">Count</th>
    </tr>
    ${activityRows}
  </table>

  <h2 style="font-size:16px;border-bottom:1px solid #ddd;padding-bottom:4px;margin-top:24px">Pending Approvals (${d.approvals.length})</h2>
  <ul style="font-size:14px">${approvalItems}</ul>

  <h2 style="font-size:16px;border-bottom:1px solid #ddd;padding-bottom:4px;margin-top:24px">Recent Errors (${d.errors.length})</h2>
  <ul style="font-size:14px">${errorItems}</ul>

  <p style="color:#999;font-size:12px;margin-top:32px;border-top:1px solid #eee;padding-top:8px">
    Generated by Hive at ${now}
  </p>
</body>
</html>`;
}
