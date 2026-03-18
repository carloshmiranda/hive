import { getDb, json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { getSettingValue } from "@/lib/settings";

// Parse directive text to extract company and agent hints
// Format: "pawly: add free trial to checkout" → { company: "pawly", text: "add free trial to checkout" }
// Format: "@engineer fix the mobile layout" → { agent: "engineer", text: "fix the mobile layout" }
// Format: "all companies should use dark mode" → { company: null, text: "all companies should use dark mode" }
function parseDirective(input: string): { companySlug: string | null; agent: string | null; text: string } {
  let companySlug: string | null = null;
  let agent: string | null = null;
  let text = input.trim();

  // Check for "company: directive" pattern
  const companyMatch = text.match(/^(\w[\w-]+):\s+(.+)$/);
  if (companyMatch) {
    companySlug = companyMatch[1].toLowerCase();
    text = companyMatch[2];
  }

  // Check for "@agent" pattern
  const agentMatch = text.match(/^@(\w+)\s+(.+)$/);
  if (agentMatch) {
    const agents = ["ceo", "engineer", "growth", "ops"];
    if (agents.includes(agentMatch[1].toLowerCase())) {
      agent = agentMatch[1].toLowerCase();
      text = agentMatch[2];
    }
  }

  return { companySlug, agent, text };
}

// Create a GitHub Issue from a directive
async function createGitHubIssue(parsed: { companySlug: string | null; agent: string | null; text: string }) {
  const token = await getSettingValue("github_token");
  const owner = await getSettingValue("github_owner");
  if (!token || !owner) return null;

  const labels: string[] = ["hive-directive"];
  if (parsed.companySlug) labels.push(`company:${parsed.companySlug}`);
  if (parsed.agent) labels.push(`agent:${parsed.agent}`);

  const title = parsed.text.length > 80 ? parsed.text.slice(0, 77) + "..." : parsed.text;

  const body = [
    `## Directive`,
    ``,
    parsed.text,
    ``,
    `---`,
    `*Created from Hive dashboard*`,
    parsed.companySlug ? `**Company:** ${parsed.companySlug}` : `**Scope:** Portfolio-wide`,
    parsed.agent ? `**Target agent:** ${parsed.agent}` : `**Target agent:** CEO (will delegate)`,
  ].join("\n");

  try {
    const res = await fetch(`https://api.github.com/repos/${owner}/hive/issues`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title, body, labels }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("GitHub issue creation failed:", errText);
      return null;
    }

    return await res.json();
  } catch (e) {
    console.error("GitHub issue creation error:", e);
    return null;
  }
}

// POST: Create a new directive from the command bar
export async function POST(req: Request) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const body = await req.json();
  const { text } = body;
  if (!text?.trim()) return err("Directive text is required");

  const parsed = parseDirective(text);

  // Resolve company ID if slug provided
  let companyId: string | null = null;
  if (parsed.companySlug) {
    const sql = getDb();
    const [company] = await sql`SELECT id FROM companies WHERE slug = ${parsed.companySlug}`;
    companyId = company?.id || null;
  }

  // Create GitHub Issue
  const issue = await createGitHubIssue(parsed);

  // Also store in Neon for the orchestrator to read (in case GitHub API fails)
  const sql = getDb();
  await sql`
    INSERT INTO directives (company_id, agent, text, github_issue_number, github_issue_url, status)
    VALUES (${companyId}, ${parsed.agent}, ${parsed.text}, ${issue?.number || null}, ${issue?.html_url || null}, 'open')
  `;

  return json({
    directive: parsed,
    github_issue: issue ? { number: issue.number, url: issue.html_url } : null,
  }, 201);
}

// GET: List open directives (for the orchestrator to read)
export async function GET(req: Request) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("company_id");
  const status = searchParams.get("status") || "open";

  const sql = getDb();

  const directives = companyId
    ? await sql`
        SELECT d.*, c.slug as company_slug FROM directives d
        LEFT JOIN companies c ON c.id = d.company_id
        WHERE d.status = ${status} AND (d.company_id = ${companyId} OR d.company_id IS NULL)
        ORDER BY d.created_at ASC
      `
    : await sql`
        SELECT d.*, c.slug as company_slug FROM directives d
        LEFT JOIN companies c ON c.id = d.company_id
        WHERE d.status = ${status}
        ORDER BY d.created_at ASC
      `;

  return json(directives);
}
