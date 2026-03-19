import { getDb, json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { getSettingValue } from "@/lib/settings";

// Dynamic todo detection — queries system state and returns actionable items.
// Each todo has: id (deterministic from source), severity, title, detail, action (url or null), dismissable

interface Todo {
  id: string;
  severity: "blocker" | "warning" | "info";
  category: "setup" | "manual_action" | "health" | "agent";
  title: string;
  detail: string;
  action_url: string | null;
  action_label: string | null;
  company_slug: string | null;
  dismissable: boolean;
}

export async function GET() {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const sql = getDb();
  const todos: Todo[] = [];

  // === 1. MISSING SETTINGS (setup blockers) ===

  const settings = await sql`SELECT key FROM settings WHERE value IS NOT NULL AND value != ''`;
  const configured = new Set(settings.map((s: any) => s.key));

  // Get dismissed todos (expire after 30 days)
  let dismissedIds = new Set<string>();
  try {
    const dismissed = await sql`
      SELECT todo_id FROM dismissed_todos WHERE dismissed_at > now() - interval '30 days'
    `;
    dismissedIds = new Set(dismissed.map((d: any) => d.todo_id));
  } catch {
    // Table may not exist yet — that's fine, no dismissals
  }

  const settingChecks: Array<{
    key: string;
    severity: "blocker" | "warning";
    title: string;
    detail: string;
  }> = [
    {
      key: "resend_api_key",
      severity: "blocker",
      title: "Resend API key not configured",
      detail: "Digest emails, outreach, and transactional emails are all disabled. Growth and Outreach agents can't send anything.",
    },
    {
      key: "sending_domain",
      severity: "blocker",
      title: "No verified sending domain",
      detail: "Outreach emails are skipped entirely without a verified domain. Digest works in test mode (only reaches your Resend account email). Buy a cheap domain and verify it in Resend.",
    },
    {
      key: "digest_email",
      severity: "warning",
      title: "No digest email address set",
      detail: "You won't receive nightly digest summaries. Add your email in settings.",
    },
    {
      key: "google_search_console_key",
      severity: "warning",
      title: "Google Search Console not connected",
      detail: "Growth agent is creating content without ranking data. It can't see which keywords rank, which pages have low CTR, or what's dropping. Set up a GSC service account and add the JSON key.",
    },
    {
      key: "stripe_secret_key",
      severity: "blocker",
      title: "Stripe not configured",
      detail: "No payment processing. Revenue tracking, customer counting, and subscription management are all disabled.",
    },
    {
      key: "github_token",
      severity: "blocker",
      title: "GitHub PAT not configured",
      detail: "Agents can't create repos, push code, open PRs, or manage GitHub issues. The entire Engineer workflow is blocked.",
    },
    {
      key: "vercel_token",
      severity: "warning",
      title: "Vercel token not configured",
      detail: "Can't provision new Vercel projects or check deploy status programmatically. Provisioner and Ops agents are limited.",
    },
  ];

  for (const check of settingChecks) {
    if (!configured.has(check.key)) {
      const id = `setting:${check.key}`;
      if (!dismissedIds.has(id)) {
        todos.push({
          id,
          severity: check.severity,
          category: "setup",
          title: check.title,
          detail: check.detail,
          action_url: "/settings",
          action_label: "Open settings",
          company_slug: null,
          dismissable: check.severity !== "blocker",
        });
      }
    }
  }

  // === 2. MANUAL ACTIONS (from escalated approvals and agent logs) ===

  const manualActions = await sql`
    SELECT aa.id, aa.description, aa.output, aa.company_id, c.slug as company_slug, c.name as company_name, aa.finished_at
    FROM agent_actions aa
    LEFT JOIN companies c ON c.id = aa.company_id
    WHERE aa.status = 'pending_manual'
    ORDER BY aa.finished_at DESC
    LIMIT 10
  `;

  for (const action of manualActions) {
    const id = `manual:${action.id}`;
    if (!dismissedIds.has(id)) {
      todos.push({
        id,
        severity: "warning",
        category: "manual_action",
        title: action.description?.slice(0, 120) || "Manual action required",
        detail: typeof action.output === "string" ? action.output : JSON.stringify(action.output)?.slice(0, 300) || "",
        action_url: action.company_slug ? `/company/${action.company_slug}` : null,
        action_label: action.company_slug ? `View ${action.company_name || action.company_slug}` : null,
        company_slug: action.company_slug,
        dismissable: true,
      });
    }
  }

  // Escalated approvals (agent failures needing investigation)
  const escalations = await sql`
    SELECT a.id, a.title, a.description, a.company_id, c.slug as company_slug, a.created_at
    FROM approvals a
    LEFT JOIN companies c ON c.id = a.company_id
    WHERE a.gate_type = 'escalation' AND a.status = 'pending'
    ORDER BY a.created_at DESC
    LIMIT 10
  `;

  for (const esc of escalations) {
    const id = `escalation:${esc.id}`;
    if (!dismissedIds.has(id)) {
      todos.push({
        id,
        severity: "warning",
        category: "agent",
        title: esc.title,
        detail: esc.description?.slice(0, 300) || "",
        action_url: esc.company_slug ? `/company/${esc.company_slug}` : null,
        action_label: "Investigate",
        company_slug: esc.company_slug,
        dismissable: false,
      });
    }
  }

  // === 3. SYSTEM HEALTH GAPS ===

  // Companies imported but never processed (0 cycles)
  const unprocessed = await sql`
    SELECT c.id, c.name, c.slug, c.created_at FROM companies c
    WHERE c.status IN ('mvp', 'active')
    AND NOT EXISTS (SELECT 1 FROM cycles WHERE company_id = c.id)
  `;

  for (const comp of unprocessed) {
    const id = `no_cycles:${comp.slug}`;
    if (!dismissedIds.has(id)) {
      todos.push({
        id,
        severity: "info",
        category: "health",
        title: `${comp.name} has never been processed`,
        detail: "This company has 0 cycles. Trigger the CEO workflow manually or wait for the next event to start the first cycle.",
        action_url: `/company/${comp.slug}`,
        action_label: `View ${comp.name}`,
        company_slug: comp.slug,
        dismissable: true,
      });
    }
  }

  // High agent failure rate in last 48h
  const [failStats] = await sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'failed') as failed,
      COUNT(*) as total
    FROM agent_actions
    WHERE finished_at > now() - interval '48 hours'
  `;

  if (Number(failStats.total) >= 5) {
    const failRate = Number(failStats.failed) / Number(failStats.total);
    if (failRate > 0.3) {
      const id = "health:high_failure_rate";
      if (!dismissedIds.has(id)) {
        todos.push({
          id,
          severity: "warning",
          category: "health",
          title: `Agent failure rate is ${Math.round(failRate * 100)}% (last 48h)`,
          detail: `${failStats.failed} of ${failStats.total} agent actions failed. Check the Activity tab for details.`,
          action_url: null,
          action_label: null,
          company_slug: null,
          dismissable: true,
        });
      }
    }
  }

  // Companies with no research reports (Growth is blind)
  const blindCompanies = await sql`
    SELECT c.name, c.slug FROM companies c
    WHERE c.status IN ('mvp', 'active')
    AND NOT EXISTS (
      SELECT 1 FROM research_reports WHERE company_id = c.id AND report_type = 'seo_keywords'
    )
  `;

  for (const comp of blindCompanies) {
    const id = `no_research:${comp.slug}`;
    if (!dismissedIds.has(id)) {
      todos.push({
        id,
        severity: "info",
        category: "health",
        title: `${comp.name} has no research data`,
        detail: "Scout hasn't run research for this company yet. Growth and Outreach are operating without market data.",
        action_url: `/company/${comp.slug}`,
        action_label: `View ${comp.name}`,
        company_slug: comp.slug,
        dismissable: true,
      });
    }
  }

  // Pending evolver proposals with critical/high severity
  try {
    const criticalProposals = await sql`
      SELECT id, title, severity, gap_type, created_at
      FROM evolver_proposals
      WHERE status = 'pending' AND severity IN ('critical', 'high')
      ORDER BY CASE severity WHEN 'critical' THEN 0 ELSE 1 END, created_at ASC
      LIMIT 5
    `;

    for (const p of criticalProposals) {
      const id = `evolver:${p.id}`;
      if (!dismissedIds.has(id)) {
        todos.push({
          id,
          severity: p.severity === "critical" ? "blocker" : "warning",
          category: "agent",
          title: `Evolver: ${p.title}`,
          detail: `${p.gap_type} gap detected. Review in the Inbox tab.`,
          action_url: null,
          action_label: null,
          company_slug: null,
          dismissable: false,
        });
      }
    }
  } catch { /* evolver_proposals table may not exist yet */ }

  // Deploy drift: is the latest main SHA deployed on Vercel?
  try {
    const vercelToken = await getSettingValue("vercel_token");
    const githubToken = await getSettingValue("github_token");

    if (vercelToken && githubToken) {
      const [ghRes, vRes] = await Promise.all([
        fetch("https://api.github.com/repos/carloshmiranda/hive/commits/main", {
          headers: { Authorization: `Bearer ${githubToken}`, Accept: "application/vnd.github+json" },
        }).then(r => r.json()),
        fetch("https://api.vercel.com/v6/deployments?projectId=prj_n9JaPbWmRv0SKoHgkdXYOEGQtjRv&teamId=team_Z4AsGtjfy6pAjCOtvJqzMT8d&target=production&limit=1", {
          headers: { Authorization: `Bearer ${vercelToken}` },
        }).then(r => r.json()),
      ]);

      const mainSha = ghRes.sha;
      const deploySha = vRes.deployments?.[0]?.meta?.githubCommitSha;

      if (mainSha && deploySha && mainSha !== deploySha) {
        const mainShort = mainSha.slice(0, 7);
        const deployShort = deploySha.slice(0, 7);
        const id = `health:deploy_drift:${mainShort}`;
        if (!dismissedIds.has(id)) {
          todos.push({
            id,
            severity: "warning",
            category: "health",
            title: `Deploy drift: main (${mainShort}) ≠ production (${deployShort})`,
            detail: "The latest commit on main has not been deployed to Vercel. Run 'vercel deploy --prod' or push a new commit to trigger a deploy.",
            action_url: "https://vercel.com/eidolons-projects-e72c0917/hive",
            action_label: "Open Vercel",
            company_slug: null,
            dismissable: true,
          });
        }
      }
    }
  } catch {
    // Don't let drift check failure break the todos endpoint
  }

  // Sort: blockers first, then warnings, then info
  const severityOrder: Record<string, number> = { blocker: 0, warning: 1, info: 2 };
  todos.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return json(todos);
}

// POST: dismiss a todo
export async function POST(req: Request) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const body = await req.json();
  const { todo_id } = body;
  if (!todo_id) return err("todo_id required");

  const sql = getDb();

  // Create table if it doesn't exist (first dismiss ever)
  await sql`
    CREATE TABLE IF NOT EXISTS dismissed_todos (
      todo_id     TEXT PRIMARY KEY,
      dismissed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  await sql`
    INSERT INTO dismissed_todos (todo_id, dismissed_at)
    VALUES (${todo_id}, now())
    ON CONFLICT (todo_id) DO UPDATE SET dismissed_at = now()
  `;

  return json({ dismissed: true });
}
