import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { neon } from "@neondatabase/serverless";
import { z } from "zod";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// Load env vars from .env.local if not set
const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_KEYS = ["DATABASE_URL", "CRON_SECRET", "NEXT_PUBLIC_URL", "GH_PAT"];
for (const envKey of ENV_KEYS) {
  if (!process.env[envKey]) {
    try {
      const envFile = readFileSync(resolve(__dirname, "../.env.local"), "utf-8");
      for (const line of envFile.split("\n")) {
        if (line.startsWith(`${envKey}=`)) {
          process.env[envKey] = line.slice(`${envKey}=`.length).replace(/^"|"$/g, "").replace(/^'|'$/g, "");
        }
      }
    } catch { /* env file not found — must be set externally */ }
  }
}

const HIVE_URL = process.env.NEXT_PUBLIC_URL || "https://hive-phi.vercel.app";
const CRON_SECRET = process.env.CRON_SECRET || "";
const GH_PAT = process.env.GH_PAT || "";

const sql = neon(process.env.DATABASE_URL);

// Import deduplication logic
import { deduplicateTask, extractAffectedCompanies, isCrossCompanyPattern } from "../src/lib/task-deduplication.js";

// GitHub Issue creation helper — creates issue directly via GitHub API
// Uses github_token from settings table (same token used by github-app.ts fallback)
const HIVE_REPO = "carloshmiranda/hive";

async function createGitHubIssueForBacklog(item) {
  try {
    // Token priority: GH_PAT env var > github_token from settings DB > gh auth token CLI
    let token = GH_PAT;
    if (!token) {
      const rows = await sql.query(
        `SELECT value FROM settings WHERE key = 'github_token' LIMIT 1`
      );
      token = rows?.[0]?.value;
    }
    if (!token) {
      try {
        const { execSync } = await import("child_process");
        token = execSync("gh auth token", { encoding: "utf-8", timeout: 3000 }).trim();
      } catch { /* gh CLI not available */ }
    }
    if (!token) {
      console.error("[mcp] No GitHub token available (set GH_PAT or github_token in settings)");
      return;
    }

    // Create GitHub Issue
    const body = [
      `## ${item.title}`,
      "",
      item.description || item.title,
      "",
      "---",
      `**Priority:** ${item.priority} | **Category:** ${item.category}${item.theme ? ` | **Theme:** ${item.theme}` : ""}`,
      `**Backlog ID:** \`${item.id}\``,
      "",
      "*Auto-created by Hive work tracker*",
    ].join("\n");

    const res = await fetch(`https://api.github.com/repos/${HIVE_REPO}/issues`, {
      method: "POST",
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: `${item.priority}: ${item.title}`,
        body,
        labels: ["hive-backlog"],
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      console.error(`[mcp] GitHub issue creation failed: ${res.status} ${res.statusText}`);
      return;
    }

    const data = await res.json();
    // Update backlog item with GitHub issue link
    await sql.query(
      `UPDATE hive_backlog SET github_issue_number = $1, github_issue_url = $2 WHERE id = $3`,
      [data.number, data.html_url, item.id]
    );
    console.error(`[mcp] Created GitHub issue #${data.number} for backlog ${item.id}`);
  } catch (e) {
    console.error(`[mcp] GitHub issue creation error: ${e?.message || e}`);
  }
}

const server = new McpServer({
  name: "hive",
  version: "1.0.0",
});

// ── Backlog ─────────────────────────────────────────────────────────────

server.registerTool(
  "hive_backlog",
  {
    description: "Query the hive_backlog table. Returns items filtered by status and/or priority.",
    inputSchema: {
      status: z.enum(["ready", "approved", "planning", "dispatched", "in_progress", "pr_open", "done", "blocked", "rejected", "all"]).default("all").describe("Filter by status, or 'all'"),
      priority: z.enum(["P0", "P1", "P2", "P3", "all"]).default("all").describe("Filter by priority, or 'all'"),
      theme: z.string().optional().describe("Filter by roadmap theme (e.g. 'dispatch_chain', 'self_improving')"),
      limit: z.number().default(50).describe("Max rows to return"),
    },
  },
  async ({ status, priority, theme, limit }) => {
    const params = [];
    const conditions = [];
    if (status !== "all") { params.push(status); conditions.push(`status = $${params.length}`); }
    if (priority !== "all") { params.push(priority); conditions.push(`priority = $${params.length}`); }
    if (theme) { params.push(theme); conditions.push(`theme = $${params.length}`); }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit);
    const rows = await sql.query(`
      SELECT id, priority, title, category, status, source, theme, notes, pr_number,
             created_at::date as created, dispatched_at, completed_at
      FROM hive_backlog ${where}
      ORDER BY CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END, created_at
      LIMIT $${params.length}
    `, params);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }
);

server.registerTool(
  "hive_backlog_stats",
  {
    description: "Get summary statistics for the hive_backlog: counts by status and priority.",
    inputSchema: {},
  },
  async () => {
    const byStatus = await sql`SELECT status, count(*)::int as count FROM hive_backlog GROUP BY status ORDER BY count DESC`;
    const byPriority = await sql`SELECT priority, status, count(*)::int as count FROM hive_backlog WHERE status NOT IN ('done','rejected') GROUP BY priority, status ORDER BY priority, status`;
    const byTheme = await sql`SELECT COALESCE(theme, 'untagged') as theme, count(*)::int as total, count(*) FILTER (WHERE status = 'done')::int as done FROM hive_backlog GROUP BY theme ORDER BY total DESC`;
    const total = await sql`SELECT count(*)::int as total FROM hive_backlog`;
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ total: total[0].total, by_status: byStatus, by_priority: byPriority, by_theme: byTheme }, null, 2),
      }],
    };
  }
);

server.registerTool(
  "hive_backlog_create",
  {
    description: "Create a new backlog item. Deduplicates by title prefix.",
    inputSchema: {
      title: z.string().describe("Short title for the backlog item"),
      description: z.string().describe("Detailed description of the work"),
      priority: z.enum(["P0", "P1", "P2", "P3"]).default("P2").describe("Priority level"),
      category: z.enum(["feature", "bugfix", "refactor", "infra", "quality", "research"]).default("feature").describe("Category (bugfix, feature, refactor, infra, quality, research)"),
      source: z.string().default("brainstorm").describe("Origin (brainstorm, sentinel, evolver, manual)"),
      theme: z.string().optional().describe("Roadmap theme (e.g. 'zero_intervention', 'dispatch_chain')"),
    },
  },
  async ({ title, description, priority, category, source, theme }) => {
    // Auto-prioritize when caller uses default P2 — infer from category + content signals
    if (priority === "P2") {
      const text = `${title} ${description}`.toLowerCase();
      const isBlocking = /block|break|crash|fail|can't|cannot|prevent|stop/i.test(text);
      const isSecurityOrAuth = /secret|auth|token|credential|inject|xss|sql.inject/i.test(text);
      if (category === "bugfix" && (isBlocking || isSecurityOrAuth)) priority = "P0";
      else if (category === "bugfix") priority = "P1";
      else if (category === "infra" && isBlocking) priority = "P0";
      else if (category === "infra") priority = "P1";
      else if (category === "quality") priority = "P2";
      else if (category === "research") priority = "P3";
      // feature and refactor stay at P2
    }

    // Cross-company task deduplication via playbook
    let finalTitle = title;
    let finalDescription = description;
    let finalCategory = category;
    let finalPriority = priority;

    try {
      // Check if this is a cross-company pattern
      const affectedCompanies = extractAffectedCompanies(description);
      if (isCrossCompanyPattern(description) && source === 'sentinel') {
        console.log(`[task-dedup] Checking cross-company pattern: "${title}" (${affectedCompanies.length} companies)`);

        const deduped = await deduplicateTask(sql, title, description, affectedCompanies);
        finalTitle = deduped.title;
        finalDescription = deduped.description;
        finalCategory = deduped.category;
        finalPriority = deduped.priority;

        // If playbook entry exists, tag this for the deduplication theme
        if (deduped.playbookReference) {
          theme = theme || 'work_tracking';
          console.log(`[task-dedup] ${deduped.playbookReference ? 'Referenced' : 'Created'} playbook pattern for cross-company issue`);
        }
      }
    } catch (error) {
      console.warn('[task-dedup] Deduplication failed, proceeding with original task:', error);
    }

    // Dedup check against existing tasks
    const prefix = finalTitle.slice(0, 50);
    const [existing] = await sql.query(
      `SELECT id, title, status FROM hive_backlog WHERE status IN ('ready','approved','dispatched','in_progress') AND title ILIKE $1 LIMIT 1`,
      [prefix + "%"]
    );
    if (existing) {
      return { content: [{ type: "text", text: `Duplicate: "${existing.title}" (${existing.status}, id: ${existing.id})` }] };
    }

    const [item] = await sql.query(
      `INSERT INTO hive_backlog (priority, title, description, category, source, theme) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, priority, title, status, theme, description, category`,
      [finalPriority, finalTitle, finalDescription, finalCategory, source, theme || null]
    );

    // Fire-and-forget: create GitHub Issue for visibility
    createGitHubIssueForBacklog({ ...item, theme }).catch(() => {});
    return { content: [{ type: "text", text: JSON.stringify(item, null, 2) }] };
  }
);

server.registerTool(
  "hive_cross_company_tasks",
  {
    description: "Create consolidated tasks for cross-company issues via playbook deduplication. Use when the same issue affects multiple companies.",
    inputSchema: {
      pattern: z.string().describe("The common pattern (e.g., 'Fix /api/stats endpoint')"),
      companies: z.array(z.string()).describe("List of affected company slugs"),
      description: z.string().describe("Description of the issue"),
      evidence: z.record(z.any()).optional().describe("Supporting evidence (metrics, errors, etc.)"),
    },
  },
  async ({ pattern, companies, description, evidence }) => {
    if (companies.length < 2) {
      return { content: [{ type: "text", text: "Cross-company tasks require at least 2 companies" }] };
    }

    try {
      console.log(`[cross-company] Creating consolidated task for pattern: "${pattern}" across ${companies.join(', ')}`);

      // Build enhanced description with company list
      const enhancedDescription = `${description}\n\n**Affected Companies**: ${companies.join(', ')}\n\nThis issue was detected across multiple companies and may indicate a systemic problem that requires a common solution.`;

      // Use deduplication logic to create playbook-aware task
      const deduped = await deduplicateTask(sql, pattern, enhancedDescription, companies);

      // Create the consolidated task
      const [item] = await sql.query(
        `INSERT INTO hive_backlog (priority, title, description, category, source, theme) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, priority, title, status, theme, description, category`,
        [deduped.priority, deduped.title, deduped.description, deduped.category, 'sentinel', 'work_tracking']
      );

      // Create GitHub Issue
      createGitHubIssueForBacklog({ ...item, theme: 'work_tracking' }).catch(() => {});

      // If we have a playbook reference, create individual company tasks that reference the main task
      if (deduped.playbookReference) {
        const individualTasks = [];
        for (const company of companies) {
          const companyTitle = `${pattern} for ${company}`;
          const companyDescription = `Company-specific implementation of #${item.id}\n\n**See Main Task**: #${item.id}\n**Playbook Reference**: ${deduped.playbookReference.insight}\n\nImplement the solution for ${company} following the pattern established in the playbook.`;

          const [companyTask] = await sql.query(
            `INSERT INTO hive_backlog (priority, title, description, category, source, theme) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, title`,
            ['P1', companyTitle, companyDescription, 'bugfix', 'sentinel', 'work_tracking']
          );

          individualTasks.push(companyTask);
          createGitHubIssueForBacklog({ ...companyTask, theme: 'work_tracking' }).catch(() => {});
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              main_task: item,
              individual_tasks: individualTasks,
              playbook_reference: deduped.playbookReference,
              companies_affected: companies.length
            }, null, 2)
          }]
        };
      }

      return { content: [{ type: "text", text: JSON.stringify(item, null, 2) }] };
    } catch (error) {
      console.error('[cross-company] Failed to create consolidated task:', error);
      return { content: [{ type: "text", text: `Error: ${error.message}` }] };
    }
  }
);

server.registerTool(
  "hive_backlog_update",
  {
    description: "Update a backlog item's status, priority, or notes. Use for triage, dedup, reprioritization.",
    inputSchema: {
      id: z.string().describe("Backlog item ID"),
      status: z.enum(["ready", "approved", "planning", "dispatched", "in_progress", "pr_open", "done", "blocked", "rejected"]).optional().describe("New status"),
      priority: z.enum(["P0", "P1", "P2", "P3"]).optional().describe("New priority"),
      theme: z.string().optional().describe("Roadmap theme (e.g. 'dispatch_chain', 'self_improving')"),
      notes: z.string().optional().describe("Append to notes"),
    },
  },
  async ({ id, status, priority, theme, notes }) => {
    const params = [];
    const sets = [];
    if (status) { params.push(status); sets.push(`status = $${params.length}`); }
    if (priority) { params.push(priority); sets.push(`priority = $${params.length}`); }
    if (theme) { params.push(theme); sets.push(`theme = $${params.length}`); }
    if (notes) { params.push(notes); sets.push(`notes = COALESCE(notes, '') || ' ' || $${params.length}`); }
    if (status === "done") sets.push(`completed_at = NOW()`);
    if (sets.length === 0) return { content: [{ type: "text", text: "No updates specified" }] };
    params.push(id);
    const [row] = await sql.query(`UPDATE hive_backlog SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING id, title, status, priority, theme, notes`, params);
    return { content: [{ type: "text", text: row ? JSON.stringify(row, null, 2) : `Item ${id} not found` }] };
  }
);

server.registerTool(
  "hive_backlog_bulk_update",
  {
    description: "Bulk update multiple backlog items. Takes an array of {id, status?, priority?, notes?} objects.",
    inputSchema: {
      updates: z.array(z.object({
        id: z.string(),
        status: z.enum(["ready", "approved", "planning", "dispatched", "in_progress", "pr_open", "done", "blocked", "rejected"]).optional(),
        priority: z.enum(["P0", "P1", "P2", "P3"]).optional(),
        notes: z.string().optional(),
      })).describe("Array of updates to apply"),
    },
  },
  async ({ updates }) => {
    const results = [];
    for (const { id, status, priority, notes } of updates) {
      const params = [];
      const sets = [];
      if (status) { params.push(status); sets.push(`status = $${params.length}`); }
      if (priority) { params.push(priority); sets.push(`priority = $${params.length}`); }
      if (notes) { params.push(notes); sets.push(`notes = COALESCE(notes, '') || ' ' || $${params.length}`); }
      if (status === "done") sets.push(`completed_at = NOW()`);
      if (sets.length === 0) continue;
      params.push(id);
      const [row] = await sql.query(`UPDATE hive_backlog SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING id, title, status, priority`, params);
      if (row) results.push(row);
    }
    return { content: [{ type: "text", text: JSON.stringify({ updated: results.length, items: results }, null, 2) }] };
  }
);

server.registerTool(
  "hive_backlog_delete",
  {
    description: "Delete a backlog item by ID. Use for deduplication.",
    inputSchema: {
      id: z.string().describe("Backlog item ID to delete"),
    },
  },
  async ({ id }) => {
    const [row] = await sql.query(`DELETE FROM hive_backlog WHERE id = $1 RETURNING id, title`, [id]);
    return { content: [{ type: "text", text: row ? `Deleted: ${row.title}` : `Item ${id} not found` }] };
  }
);

// ── Companies ───────────────────────────────────────────────────────────

server.registerTool(
  "hive_companies",
  {
    description: "List companies with their current status, type, and key metrics.",
    inputSchema: {
      status: z.string().optional().describe("Filter by status (idea, approved, mvp, active, killed)"),
    },
  },
  async ({ status }) => {
    const params = [];
    let where = "";
    if (status) { params.push(status); where = `WHERE c.status = $${params.length}`; }
    const rows = await sql.query(`
      SELECT c.id, c.name, c.slug, c.status, c.company_type,
             c.market, c.content_language,
             (SELECT count(*) FROM cycles WHERE company_id = c.id) as cycle_count,
             (SELECT (ceo_review->'review'->>'score')::int FROM cycles WHERE company_id = c.id ORDER BY started_at DESC LIMIT 1) as last_score,
             c.created_at::date as created
      FROM companies c ${where}
      ORDER BY c.status, c.name
    `, params);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }
);

// ── Agent Actions ───────────────────────────────────────────────────────

server.registerTool(
  "hive_actions",
  {
    description: "Query recent agent actions. Shows what agents have been doing.",
    inputSchema: {
      agent: z.string().optional().describe("Filter by agent name"),
      status: z.string().optional().describe("Filter by status (success, failed, running)"),
      hours: z.number().default(24).describe("Look back N hours"),
      limit: z.number().default(20).describe("Max rows"),
    },
  },
  async ({ agent, status, hours, limit }) => {
    const params = [];
    params.push(hours);
    const conditions = [`started_at > NOW() - INTERVAL '1 hour' * $${params.length}`];
    if (agent) { params.push(agent); conditions.push(`agent = $${params.length}`); }
    if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
    params.push(limit);
    const rows = await sql.query(`
      SELECT id, agent, action_type, company_id, status,
             substring(description from 1 for 120) as description,
             substring(error from 1 for 120) as error,
             started_at, finished_at,
             EXTRACT(EPOCH FROM (COALESCE(finished_at, NOW()) - started_at))::int as duration_s
      FROM agent_actions
      WHERE ${conditions.join(" AND ")}
      ORDER BY started_at DESC
      LIMIT $${params.length}
    `, params);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }
);

server.registerTool(
  "hive_failure_summary",
  {
    description: "Summarize agent failures: error patterns, frequency, which agents fail most.",
    inputSchema: {
      hours: z.number().default(48).describe("Look back N hours"),
    },
  },
  async ({ hours }) => {
    const params = [hours];
    const byAgent = await sql.query(`
      SELECT agent, count(*)::int as failures,
             count(CASE WHEN error IS NULL THEN 1 END)::int as null_errors
      FROM agent_actions
      WHERE status = 'failed' AND started_at > NOW() - INTERVAL '1 hour' * $1
      GROUP BY agent ORDER BY failures DESC
    `, params);
    const topErrors = await sql.query(`
      SELECT agent, substring(error from 1 for 150) as error, count(*)::int as count
      FROM agent_actions
      WHERE status = 'failed' AND error IS NOT NULL AND started_at > NOW() - INTERVAL '1 hour' * $1
      GROUP BY agent, substring(error from 1 for 150) ORDER BY count DESC LIMIT 15
    `, params);
    const total = await sql.query(`
      SELECT count(*)::int as total_actions,
             count(CASE WHEN status = 'failed' THEN 1 END)::int as failed,
             count(CASE WHEN status = 'success' THEN 1 END)::int as succeeded
      FROM agent_actions WHERE started_at > NOW() - INTERVAL '1 hour' * $1
    `, params);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ summary: total[0], by_agent: byAgent, top_errors: topErrors }, null, 2),
      }],
    };
  }
);

// ── Approvals ───────────────────────────────────────────────────────────

server.registerTool(
  "hive_approvals",
  {
    description: "List pending approvals waiting for Carlos's decision.",
    inputSchema: {
      status: z.enum(["pending", "approved", "rejected", "all"]).default("pending").describe("Filter by status"),
    },
  },
  async ({ status }) => {
    const params = [];
    let where = "";
    if (status !== "all") { params.push(status); where = `WHERE status = $${params.length}`; }
    const rows = await sql.query(`
      SELECT id, gate_type, title, status,
             substring(description from 1 for 200) as description,
             context, created_at
      FROM approvals ${where}
      ORDER BY created_at DESC LIMIT 30
    `, params);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }
);

// ── Cycles ──────────────────────────────────────────────────────────────

server.registerTool(
  "hive_cycles",
  {
    description: "List recent company cycles with scores and status.",
    inputSchema: {
      company_id: z.string().optional().describe("Filter by company ID"),
      limit: z.number().default(10).describe("Max rows"),
    },
  },
  async ({ company_id, limit }) => {
    const params = [];
    let where = "";
    if (company_id) { params.push(company_id); where = `WHERE c.company_id = $${params.length}`; }
    params.push(limit);
    const rows = await sql.query(`
      SELECT c.id, co.name as company, c.status,
             (c.ceo_review->'review'->>'score')::int as score,
             c.started_at, c.finished_at, c.cycle_number,
             substring(c.ceo_plan::text from 1 for 200) as plan_preview,
             substring(c.ceo_review::text from 1 for 200) as review_preview
      FROM cycles c
      LEFT JOIN companies co ON co.id = c.company_id
      ${where}
      ORDER BY c.started_at DESC
      LIMIT $${params.length}
    `, params);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }
);

// ── Raw SQL ─────────────────────────────────────────────────────────────

server.registerTool(
  "hive_sql",
  {
    description: "Execute a read-only SQL query against the Hive Neon database. For ad-hoc analysis.",
    inputSchema: {
      query: z.string().describe("SQL query (SELECT only — mutations blocked)"),
    },
  },
  async ({ query }) => {
    const normalized = query.trim().toUpperCase();
    if (!normalized.startsWith("SELECT") && !normalized.startsWith("WITH")) {
      return { content: [{ type: "text", text: "Only SELECT/WITH queries allowed. Use specific tools for mutations." }] };
    }
    const rows = await sql.query(query);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }
);

// ── SQL Mutate ──────────────────────────────────────────────────────────

server.registerTool(
  "hive_sql_mutate",
  {
    description: "Execute a mutation SQL query (UPDATE, INSERT, DELETE) against the Hive Neon database. Use for bulk fixes and data corrections.",
    inputSchema: {
      query: z.string().describe("SQL mutation query (UPDATE/INSERT/DELETE)"),
    },
  },
  async ({ query }) => {
    const normalized = query.trim().toUpperCase();
    // Block dangerous operations
    if (normalized.includes("DROP ") || normalized.includes("TRUNCATE ") || normalized.includes("ALTER ")) {
      return { content: [{ type: "text", text: "DDL operations (DROP, TRUNCATE, ALTER) are blocked. Use schema.sql for schema changes." }] };
    }
    if (!normalized.startsWith("UPDATE") && !normalized.startsWith("INSERT") && !normalized.startsWith("DELETE") && !normalized.startsWith("WITH")) {
      return { content: [{ type: "text", text: "Only UPDATE/INSERT/DELETE/WITH queries allowed." }] };
    }
    const rows = await sql.query(query);
    return { content: [{ type: "text", text: JSON.stringify({ affected: rows.length, rows }, null, 2) }] };
  }
);

// ── Company Tasks ───────────────────────────────────────────────────────

server.registerTool(
  "hive_tasks",
  {
    description: "Query company tasks (company_tasks table). View pending work for companies. Includes cycle, PR, and GitHub Issue data.",
    inputSchema: {
      company_slug: z.string().optional().describe("Filter by company slug"),
      status: z.enum(["proposed", "approved", "in_progress", "done", "dismissed", "all"]).default("all").describe("Filter by status"),
      cycle_id: z.string().optional().describe("Filter by cycle ID"),
      limit: z.number().default(50).describe("Max rows"),
    },
  },
  async ({ company_slug, status, cycle_id, limit }) => {
    const params = [];
    const conditions = [];
    if (company_slug) { params.push(company_slug); conditions.push(`c.slug = $${params.length}`); }
    if (status && status !== "all") { params.push(status); conditions.push(`t.status = $${params.length}`); }
    if (cycle_id) { params.push(cycle_id); conditions.push(`t.cycle_id = $${params.length}`); }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit);
    const rows = await sql.query(`
      SELECT t.id, c.slug as company, t.category, t.title, t.description, t.status, t.priority, t.source,
             t.cycle_id, t.pr_number, t.pr_url, t.github_issue_number, t.github_issue_url,
             t.created_at, t.updated_at
      FROM company_tasks t
      JOIN companies c ON c.id = t.company_id
      ${whereClause}
      ORDER BY t.priority ASC, t.created_at DESC
      LIMIT $${params.length}
    `, params);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }
);

// ── Company Tasks: Update ────────────────────────────────────────────────

server.registerTool(
  "hive_tasks_update",
  {
    description: "Update a company task's status, priority, or link a PR. Use for marking work done, dismissed, or in-progress.",
    inputSchema: {
      id: z.string().describe("Task ID"),
      status: z.enum(["proposed", "approved", "in_progress", "done", "dismissed"]).optional().describe("New status"),
      priority: z.number().min(0).max(3).optional().describe("New priority (0-3)"),
      pr_number: z.number().optional().describe("PR number that implements this task"),
      pr_url: z.string().optional().describe("PR URL"),
    },
  },
  async ({ id, status, priority, pr_number, pr_url }) => {
    const sets = [];
    const params = [id];
    if (status) { params.push(status); sets.push(`status = $${params.length}`); }
    if (priority !== undefined) { params.push(priority); sets.push(`priority = $${params.length}`); }
    if (pr_number) { params.push(pr_number); sets.push(`pr_number = $${params.length}`); }
    if (pr_url) { params.push(pr_url); sets.push(`pr_url = $${params.length}`); }
    if (sets.length === 0) return { content: [{ type: "text", text: "No fields to update" }] };
    sets.push("updated_at = NOW()");
    const [updated] = await sql.query(
      `UPDATE company_tasks SET ${sets.join(", ")} WHERE id = $1 RETURNING id, title, status, priority, pr_number`,
      params
    );
    if (!updated) return { content: [{ type: "text", text: `Task ${id} not found` }] };
    return { content: [{ type: "text", text: JSON.stringify(updated, null, 2) }] };
  }
);

// ── PRs ─────────────────────────────────────────────────────────────────

server.registerTool(
  "hive_open_prs",
  {
    description: "List backlog items with pr_open status — PRs awaiting merge.",
    inputSchema: {},
  },
  async () => {
    const rows = await sql`
      SELECT id, priority, title, pr_number, pr_url,
             substring(notes from 1 for 150) as notes,
             dispatched_at
      FROM hive_backlog
      WHERE status = 'pr_open'
      ORDER BY priority, dispatched_at
    `;
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }
);

// ── Portfolio ───────────────────────────────────────────────────────────

server.registerTool(
  "hive_portfolio",
  {
    description: "Portfolio overview: companies, pipeline counts, backlog health, recent activity.",
    inputSchema: {},
  },
  async () => {
    const companies = await sql`SELECT status, count(*)::int as count FROM companies GROUP BY status ORDER BY count DESC`;
    const backlog = await sql`SELECT status, count(*)::int as count FROM hive_backlog GROUP BY status ORDER BY count DESC`;
    const recentActions = await sql`
      SELECT agent, status, count(*)::int as count
      FROM agent_actions WHERE started_at > NOW() - INTERVAL '24 hours'
      GROUP BY agent, status ORDER BY agent, status
    `;
    const pendingApprovals = await sql`SELECT count(*)::int as count FROM approvals WHERE status = 'pending'`;
    const recentCycles = await sql`
      SELECT co.name, (c.ceo_review->'review'->>'score')::int as score, c.status, c.started_at::date as date
      FROM cycles c JOIN companies co ON co.id = c.company_id
      ORDER BY c.started_at DESC LIMIT 5
    `;
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          companies: companies,
          backlog: backlog,
          pending_approvals: pendingApprovals[0].count,
          recent_agent_activity_24h: recentActions,
          recent_cycles: recentCycles,
        }, null, 2),
      }],
    };
  }
);

// ── Playbook ──────────────────────────────────────────────────────────

server.registerTool(
  "hive_playbook",
  {
    description: "Query the playbook table for cross-company learnings.",
    inputSchema: {
      domain: z.string().optional().describe("Filter by domain (e.g. 'seo', 'pricing', 'growth')"),
      company_slug: z.string().optional().describe("Filter by source company slug"),
      min_confidence: z.number().default(0.5).describe("Minimum confidence score"),
      limit: z.number().default(20).describe("Max rows"),
    },
  },
  async ({ domain, company_slug, min_confidence, limit }) => {
    const params = [];
    params.push(min_confidence);
    const conditions = [`p.confidence >= $${params.length}`, `p.superseded_by IS NULL`];
    if (domain) { params.push(domain); conditions.push(`p.domain = $${params.length}`); }
    if (company_slug) { params.push(company_slug); conditions.push(`c.slug = $${params.length}`); }
    params.push(limit);
    const rows = await sql.query(`
      SELECT p.id, p.domain, p.insight, p.confidence, p.content_language,
             c.slug as source_company, p.applied_count, p.reference_count,
             p.created_at
      FROM playbook p
      LEFT JOIN companies c ON c.id = p.company_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY p.confidence DESC, p.created_at DESC
      LIMIT $${params.length}
    `, params);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }
);

// ── Error Patterns ────────────────────────────────────────────────────

server.registerTool(
  "hive_error_patterns",
  {
    description: "Query the error_patterns table for normalized error patterns and their fixes.",
    inputSchema: {
      agent: z.string().optional().describe("Filter by agent name"),
      resolved: z.boolean().optional().describe("Filter by resolved status"),
      limit: z.number().default(20).describe("Max rows"),
    },
  },
  async ({ agent, resolved, limit }) => {
    const params = [];
    const conditions = [];
    if (agent) { params.push(agent); conditions.push(`agent = $${params.length}`); }
    if (resolved !== undefined) { params.push(resolved); conditions.push(`resolved = $${params.length}`); }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit);
    const rows = await sql.query(`
      SELECT id, pattern, agent, fix_summary, fix_detail,
             occurrences, last_seen_at, resolved, auto_fixable
      FROM error_patterns ${where}
      ORDER BY occurrences DESC, last_seen_at DESC
      LIMIT $${params.length}
    `, params);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }
);

// ── Directives ────────────────────────────────────────────────────────

server.registerTool(
  "hive_directives",
  {
    description: "Query directives — instructions from Carlos to agents.",
    inputSchema: {
      status: z.enum(["open", "closed", "all"]).default("open").describe("Filter by status"),
      company_slug: z.string().optional().describe("Filter by company slug"),
      limit: z.number().default(20).describe("Max rows"),
    },
  },
  async ({ status, company_slug, limit }) => {
    const params = [];
    const conditions = [];
    if (status !== "all") { params.push(status); conditions.push(`d.status = $${params.length}`); }
    if (company_slug) { params.push(company_slug); conditions.push(`c.slug = $${params.length}`); }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit);
    const rows = await sql.query(`
      SELECT d.id, c.name as company, c.slug as company_slug,
             d.agent, d.text, d.status, d.resolution,
             d.created_at, d.closed_at
      FROM directives d
      LEFT JOIN companies c ON c.id = d.company_id
      ${where}
      ORDER BY d.created_at DESC
      LIMIT $${params.length}
    `, params);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }
);

// ── Routing Weights ───────────────────────────────────────────────────

server.registerTool(
  "hive_routing_weights",
  {
    description: "Query model routing success rates by agent, computed from agent_actions.",
    inputSchema: {
      hours: z.number().default(168).describe("Look back N hours (default 168 = 7 days)"),
    },
  },
  async ({ hours }) => {
    const rows = await sql.query(`
      SELECT agent,
             output->>'provider' as provider,
             output->>'model' as model,
             COUNT(*)::int as total,
             COUNT(CASE WHEN status = 'success' THEN 1 END)::int as successes,
             COUNT(CASE WHEN status = 'failed' THEN 1 END)::int as failures,
             ROUND(COUNT(CASE WHEN status = 'success' THEN 1 END)::numeric / NULLIF(COUNT(*), 0) * 100, 1) as success_rate
      FROM agent_actions
      WHERE started_at > NOW() - INTERVAL '1 hour' * $1
      GROUP BY agent, output->>'provider', output->>'model'
      HAVING COUNT(*) >= 3
      ORDER BY success_rate ASC
    `, [hours]);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }
);

// ── Settings ────────────────────────────────────────────────────────────

server.registerTool(
  "hive_settings",
  {
    description: "Read or write Hive settings. Secrets are masked in output. Pass key+value to upsert, key-only to read one, or omit both to list all.",
    inputSchema: {
      key: z.string().optional().describe("Setting key to read or write"),
      value: z.string().optional().describe("Value to set (upsert). Omit to read."),
      is_secret: z.boolean().default(false).describe("Mark as secret (encrypted at rest, masked in reads)"),
    },
  },
  async ({ key, value, is_secret }) => {
    // Write mode — ALWAYS route through /api/settings to ensure proper encryption
    if (key && value !== undefined) {
      try {
        const res = await fetch(`${HIVE_URL}/api/settings`, {
          method: "POST",
          headers: { Authorization: `Bearer ${CRON_SECRET}`, "Content-Type": "application/json" },
          body: JSON.stringify({ key, value }),
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) {
          const body = await res.text();
          return { content: [{ type: "text", text: JSON.stringify({ ok: false, key, error: `API returned ${res.status}: ${body}` }) }] };
        }
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, key, written: true, via: "api" }) }] };
      } catch (e) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, key, error: `API call failed: ${e.message}. Write aborted — secrets must go through /api/settings for encryption.` }) }] };
      }
    }
    // Read one
    if (key) {
      const rows = await sql`SELECT key, value, is_secret, updated_at FROM settings WHERE key = ${key}`;
      if (rows.length === 0) return { content: [{ type: "text", text: `Setting "${key}" not found` }] };
      const row = rows[0];
      if (row.is_secret) row.value = "***SECRET***";
      return { content: [{ type: "text", text: JSON.stringify(row, null, 2) }] };
    }
    // List all
    const rows = await sql`SELECT key, CASE WHEN is_secret THEN '***SECRET***' ELSE value END as value, is_secret, updated_at FROM settings ORDER BY key`;
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }
);

// ── Metrics ─────────────────────────────────────────────────────────────

server.registerTool(
  "hive_metrics",
  {
    description: "Query company metrics (revenue, MRR, page views, signups, churn, etc). Filter by company and/or date range.",
    inputSchema: {
      company_id: z.string().uuid().optional().describe("Filter by company UUID"),
      days: z.number().default(30).describe("Look back N days (default 30)"),
      metric: z.string().optional().describe("Filter to specific column (e.g. 'revenue', 'page_views', 'signups')"),
    },
  },
  async ({ company_id, days, metric }) => {
    let query, params;
    if (company_id) {
      query = `
        SELECT m.*, c.name as company_name FROM metrics m
        JOIN companies c ON c.id = m.company_id
        WHERE m.company_id = $1 AND m.date >= CURRENT_DATE - $2
        ORDER BY m.date DESC
      `;
      params = [company_id, days];
    } else {
      query = `
        SELECT m.*, c.name as company_name FROM metrics m
        JOIN companies c ON c.id = m.company_id
        WHERE m.date >= CURRENT_DATE - $1
        ORDER BY c.name, m.date DESC
      `;
      params = [days];
    }
    const rows = await sql.query(query, params);
    // If filtering to a specific metric column, simplify output
    if (metric && rows.length > 0 && metric in rows[0]) {
      const simplified = rows.map(r => ({ company_name: r.company_name, date: r.date, [metric]: r[metric] }));
      return { content: [{ type: "text", text: JSON.stringify(simplified, null, 2) }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }
);

// ── Dispatch Status ─────────────────────────────────────────────────────

server.registerTool(
  "hive_dispatch_status",
  {
    description: "Single-query dispatch health view: budget usage, queue state, recent failures, chain status. Essential for diagnosing why the loop is stalled.",
    inputSchema: {},
  },
  async () => {
    // Budget: turns used in last 5h window
    const [budget] = await sql`
      SELECT COUNT(*)::int as actions_5h,
             COALESCE(SUM((output->>'turns_used')::int), 0)::int as turns_5h,
             225 as budget_limit,
             ROUND(COALESCE(SUM((output->>'turns_used')::int), 0)::numeric / 225 * 100, 1) as budget_pct
      FROM agent_actions
      WHERE agent = 'engineer' AND started_at > NOW() - INTERVAL '5 hours'
    `;

    // Queue state
    const queueRows = await sql`
      SELECT status, COUNT(*)::int as count FROM hive_backlog
      WHERE status IN ('ready', 'dispatched', 'blocked', 'running')
      GROUP BY status
    `;
    const queue = Object.fromEntries(queueRows.map(r => [r.status, r.count]));

    // Recent failures (last 24h)
    const failures = await sql`
      SELECT b.id, b.title, b.priority, b.notes,
             a.status as action_status, a.output->>'error_type' as error_type,
             a.started_at
      FROM agent_actions a
      JOIN hive_backlog b ON b.id::text = a.output->>'backlog_id'
      WHERE a.agent = 'engineer' AND a.status = 'failed'
        AND a.started_at > NOW() - INTERVAL '24 hours'
      ORDER BY a.started_at DESC LIMIT 10
    `;

    // Chain health
    const [chain] = await sql`
      SELECT
        (SELECT MAX(dispatched_at) FROM hive_backlog WHERE dispatched_at IS NOT NULL) as last_dispatch,
        (SELECT COUNT(*)::int FROM hive_backlog WHERE status = 'dispatched') as currently_dispatched,
        (SELECT COUNT(*)::int FROM agent_actions WHERE agent = 'engineer' AND status = 'running') as running_engineers,
        EXTRACT(EPOCH FROM (NOW() - (SELECT MAX(dispatched_at) FROM hive_backlog WHERE dispatched_at IS NOT NULL)))::int as seconds_since_dispatch
    `;

    const result = { budget, queue, recent_failures: failures, chain };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// ── Research Reports ────────────────────────────────────────────────────

server.registerTool(
  "hive_research",
  {
    description: "Query research reports (market research, competitive analysis, lead lists, SEO keywords, etc).",
    inputSchema: {
      company_id: z.string().uuid().optional().describe("Filter by company UUID"),
      report_type: z.string().optional().describe("Filter by type: market_research, competitive_analysis, lead_list, seo_keywords, industry_trends, technology_landscape"),
      limit: z.number().default(10).describe("Max results"),
    },
  },
  async ({ company_id, report_type, limit }) => {
    let query, params;
    if (company_id && report_type) {
      query = `
        SELECT r.*, c.name as company_name FROM research_reports r
        JOIN companies c ON c.id = r.company_id
        WHERE r.company_id = $1 AND r.report_type = $2
        ORDER BY r.created_at DESC LIMIT $3
      `;
      params = [company_id, report_type, limit];
    } else if (company_id) {
      query = `
        SELECT r.*, c.name as company_name FROM research_reports r
        JOIN companies c ON c.id = r.company_id
        WHERE r.company_id = $1
        ORDER BY r.created_at DESC LIMIT $2
      `;
      params = [company_id, limit];
    } else if (report_type) {
      query = `
        SELECT r.*, c.name as company_name FROM research_reports r
        JOIN companies c ON c.id = r.company_id
        WHERE r.report_type = $1
        ORDER BY r.created_at DESC LIMIT $2
      `;
      params = [report_type, limit];
    } else {
      query = `
        SELECT r.id, r.company_id, c.name as company_name, r.report_type, r.summary,
               r.created_at, r.updated_at
        FROM research_reports r
        JOIN companies c ON c.id = r.company_id
        ORDER BY r.created_at DESC LIMIT $1
      `;
      params = [limit];
    }
    const rows = await sql.query(query, params);
    return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }] };
  }
);

// ── Circuit Breaker Reset ─────────────────────────────────────────────

server.registerTool(
  "hive_circuit_reset",
  {
    description: "Reset circuit breakers by marking recent failed agent_actions as 'skipped'. Use when a root cause has been fixed and the circuit breaker is blocking dispatch. Without arguments, shows current breaker status.",
    inputSchema: {
      agent: z.string().optional().describe("Agent name (engineer, ops, growth, healer, ceo, etc). Omit to see status only."),
      company_slug: z.string().optional().describe("Company slug. Omit for systemic (company_id IS NULL) failures."),
      hours: z.number().default(48).describe("How many hours back to look (default 48)"),
    },
  },
  async ({ agent, company_slug, hours }) => {
    // If no agent specified, show circuit breaker status
    if (!agent) {
      const rows = await sql`
        SELECT a.agent, c.slug as company, COUNT(*)::int as failures, MAX(a.started_at) as latest
        FROM agent_actions a
        LEFT JOIN companies c ON c.id = a.company_id
        WHERE a.status = 'failed' AND a.started_at > NOW() - INTERVAL '48 hours'
        GROUP BY a.agent, c.slug
        HAVING COUNT(*) >= 3
        ORDER BY COUNT(*) DESC
      `;
      if (rows.length === 0) {
        return { content: [{ type: "text", text: "No open circuit breakers (no agent has 3+ failures in 48h)." }] };
      }
      return { content: [{ type: "text", text: JSON.stringify({ open_breakers: rows }, null, 2) }] };
    }

    // Use separate queries for company vs systemic to avoid fragment composition
    let result;
    if (company_slug) {
      const [company] = await sql`SELECT id FROM companies WHERE slug = ${company_slug} LIMIT 1`;
      if (!company) return { content: [{ type: "text", text: `Company '${company_slug}' not found.` }] };
      result = await sql`
        UPDATE agent_actions SET status = 'skipped'
        WHERE agent = ${agent} AND status = 'failed'
        AND company_id = ${company.id}
        AND started_at > NOW() - make_interval(hours => ${hours})
      `;
    } else {
      result = await sql`
        UPDATE agent_actions SET status = 'skipped'
        WHERE agent = ${agent} AND status = 'failed'
        AND company_id IS NULL
        AND started_at > NOW() - make_interval(hours => ${hours})
      `;
    }

    const affected = result.count || 0;
    return {
      content: [{
        type: "text",
        text: `Reset ${affected} failed ${agent} actions${company_slug ? ` for ${company_slug}` : ' (systemic)'} in last ${hours}h → status = 'skipped'. Circuit breaker should now be clear.`,
      }],
    };
  }
);

// ── Loop Kick (trigger sentinel dispatch) ────────────────────────────

server.registerTool(
  "hive_loop_kick",
  {
    description: "Trigger sentinel-dispatch to kick the autonomous loop. Use when the loop appears stalled (no recent dispatches). Equivalent to calling /api/cron/sentinel-dispatch.",
    inputSchema: {
      tier: z.enum(["dispatch", "urgent", "janitor"]).default("dispatch").describe("Which sentinel tier to trigger"),
    },
  },
  async ({ tier }) => {
    const endpoint = `/api/cron/sentinel-${tier}`;
    const url = `${HIVE_URL}${endpoint}`;
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${CRON_SECRET}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(120000),
      });
      const data = await res.json().catch(() => res.text());
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ ok: res.ok, tier, data }, null, 2),
        }],
      };
    } catch (e) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ ok: false, error: e.message, url }),
        }],
      };
    }
  }
);

// ── Trigger (call Hive API endpoints as Hive) ─────────────────────────

server.registerTool(
  "hive_trigger",
  {
    description: "Trigger Hive API endpoints as if you were the system. Supports sentinel dispatch, backlog dispatch, company health, and any other internal endpoint. Authenticates with CRON_SECRET.",
    inputSchema: {
      endpoint: z.string().describe("API path, e.g. '/api/cron/sentinel-dispatch', '/api/backlog/dispatch', '/api/cron/sentinel-urgent'"),
      method: z.enum(["GET", "POST"]).default("GET").describe("HTTP method"),
      body: z.record(z.any()).optional().describe("JSON body for POST requests"),
    },
  },
  async ({ endpoint, method, body }) => {
    const url = `${HIVE_URL}${endpoint}`;
    try {
      const options = {
        method,
        headers: {
          Authorization: `Bearer ${CRON_SECRET}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(120000),
      };
      if (method === "POST" && body) {
        options.body = JSON.stringify(body);
      }
      const res = await fetch(url, options);
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text; }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ ok: res.ok, status: res.status, data }, null, 2),
        }],
      };
    } catch (e) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ ok: false, error: e.message, url }),
        }],
      };
    }
  }
);

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[hive-mcp] Server started");
