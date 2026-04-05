import { getDb, json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { validateTaskAgainstPhase } from "@/lib/phase-gate";
import { setSentryTags } from "@/lib/sentry-tags";

export async function GET(req: Request) {
  setSentryTags({
    action_type: "admin",
    route: "/api/tasks",
  });

  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("company_id");
  const status = searchParams.get("status");
  const category = searchParams.get("category");
  const includeDone = searchParams.get("include_done") === "true";

  const sql = getDb();

  if (companyId) {
    const tasks = await sql`
      SELECT t.*, c.slug as company_slug, c.name as company_name
      FROM company_tasks t JOIN companies c ON c.id = t.company_id
      WHERE t.company_id = ${companyId}
        ${status ? sql`AND t.status = ${status}` : includeDone ? sql`` : sql`AND t.status NOT IN ('done', 'dismissed')`}
        ${category ? sql`AND t.category = ${category}` : sql``}
      ORDER BY t.priority ASC, t.created_at DESC
    `;
    return json(tasks);
  }

  // All active tasks across companies
  const tasks = await sql`
    SELECT t.*, c.slug as company_slug, c.name as company_name
    FROM company_tasks t JOIN companies c ON c.id = t.company_id
    WHERE 1=1
      ${status ? sql`AND t.status = ${status}` : includeDone ? sql`` : sql`AND t.status NOT IN ('done', 'dismissed')`}
      ${category ? sql`AND t.category = ${category}` : sql``}
    ORDER BY t.priority ASC, t.created_at DESC
    LIMIT 100
  `;
  return json(tasks);
}

export async function POST(req: Request) {
  setSentryTags({
    action_type: "admin",
    route: "/api/tasks",
  });

  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const body = await req.json();
  const sql = getDb();

  // Support bulk insert (CEO agent sends array)
  const items = Array.isArray(body) ? body : [body];
  const results = [];
  const rejected: { title: string; phase: string | null; violations: string[] }[] = [];

  for (const item of items) {
    const { company_id, category, title, description, priority, source, prerequisites, acceptance,
      // Structured spec fields from CEO engineering_tasks
      files_allowed, files_forbidden, acceptance_criteria, specialist, complexity, approach,
    } = item;
    if (!company_id || !category || !title || !description) {
      continue;
    }

    // Build structured spec from CEO plan fields (if provided)
    const spec = (files_allowed || files_forbidden || acceptance_criteria || specialist || complexity || approach) ? {
      ...(acceptance_criteria ? { acceptance_criteria: Array.isArray(acceptance_criteria) ? acceptance_criteria : [acceptance_criteria] } : {}),
      ...(files_allowed ? { files_allowed: Array.isArray(files_allowed) ? files_allowed : [files_allowed] } : {}),
      ...(files_forbidden ? { files_forbidden: Array.isArray(files_forbidden) ? files_forbidden : [files_forbidden] } : {}),
      ...(approach ? { approach: Array.isArray(approach) ? approach : [approach] } : {}),
      ...(specialist ? { specialist } : {}),
      ...(complexity ? { complexity: complexity === "complex" ? "M" : complexity === "mechanical" ? "S" : complexity } : {}),
    } : null;

    // Phase gate: reject tasks that violate the company's validation phase
    const gate = await validateTaskAgainstPhase(sql, company_id, title, description);
    if (!gate.allowed) {
      rejected.push({
        title,
        phase: gate.phase,
        violations: gate.violations.map((v) => `Phase "${v.phase}" forbids: ${v.rule} (matched "${v.matched_pattern}")`),
      });
      continue;
    }

    // Hard cap: reject new tasks if company already has ≥ 10 open tasks
    const [{ cnt }] = await sql`
      SELECT COUNT(*)::int as cnt FROM company_tasks
      WHERE company_id = ${company_id}
      AND status NOT IN ('done', 'dismissed', 'cancelled')
    `;
    if (cnt >= 10) {
      results.push({ title, skipped: true, reason: `open_task_cap_exceeded (${cnt}/10 open)` });
      continue;
    }

    // Deduplicate: skip if same company + title exists and is not done/dismissed
    const [existing] = await sql`
      SELECT id FROM company_tasks
      WHERE company_id = ${company_id} AND title = ${title}
      AND status NOT IN ('done', 'dismissed')
    `;
    if (existing) continue;

    // CEO-sourced tasks are auto-approved (already validated by phase gate above)
    const taskStatus = (source || "ceo") === "ceo" ? "approved" : "proposed";
    const [task] = await sql`
      INSERT INTO company_tasks (company_id, category, title, description, priority, source, prerequisites, acceptance, status, spec)
      VALUES (
        ${company_id}, ${category}, ${title}, ${description},
        ${priority ?? 2}, ${source || "ceo"},
        ${prerequisites || []}, ${acceptance || null},
        ${taskStatus}, ${spec ? JSON.stringify(spec) : null}::jsonb
      )
      RETURNING *
    `;
    results.push(task);

    // Create GitHub Issue in company repo (fire-and-forget)
    import("@/lib/github-issues")
      .then(async ({ createCompanyTaskIssue }) => {
        const [company] = await sql`SELECT slug, github_repo FROM companies WHERE id = ${company_id}`;
        if (!company?.github_repo) return;
        const issue = await createCompanyTaskIssue(company.github_repo, {
          id: task.id, title, description, priority: priority ?? 2,
          category, source: source || "ceo", acceptance,
        }, company.slug);
        if (issue) {
          await sql`UPDATE company_tasks SET github_issue_number = ${issue.number}, github_issue_url = ${issue.url} WHERE id = ${task.id}`.catch(() => {});
        }
      })
      .catch(() => {});
  }

  // If some tasks were rejected by phase gate, include that info
  if (rejected.length > 0) {
    return json({ created: results, rejected, phase_gated: true }, 201);
  }
  return json(results, 201);
}
