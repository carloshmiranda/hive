import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { neon } from "@neondatabase/serverless";
import { z } from "zod";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// Load DATABASE_URL from .env.local if not set
if (!process.env.DATABASE_URL) {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  try {
    const envFile = readFileSync(resolve(__dirname, "../.env.local"), "utf-8");
    for (const line of envFile.split("\n")) {
      if (line.startsWith("DATABASE_URL=")) {
        process.env.DATABASE_URL = line.slice("DATABASE_URL=".length).replace(/^"|"$/g, "");
        break;
      }
    }
  } catch { /* env file not found — DATABASE_URL must be set externally */ }
}

const sql = neon(process.env.DATABASE_URL);

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
      category: z.enum(["feature", "bug", "refactor", "infra", "docs", "research"]).default("feature").describe("Category"),
      source: z.string().default("brainstorm").describe("Origin (brainstorm, sentinel, evolver, manual)"),
      theme: z.string().optional().describe("Roadmap theme (e.g. 'zero_intervention', 'dispatch_chain')"),
    },
  },
  async ({ title, description, priority, category, source, theme }) => {
    // Dedup check
    const prefix = title.slice(0, 50);
    const [existing] = await sql.query(
      `SELECT id, title, status FROM hive_backlog WHERE status IN ('ready','approved','dispatched','in_progress') AND title ILIKE $1 LIMIT 1`,
      [prefix + "%"]
    );
    if (existing) {
      return { content: [{ type: "text", text: `Duplicate: "${existing.title}" (${existing.status}, id: ${existing.id})` }] };
    }
    const [item] = await sql.query(
      `INSERT INTO hive_backlog (priority, title, description, category, source, theme) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, priority, title, status, theme`,
      [priority, title, description, category, source, theme || null]
    );
    return { content: [{ type: "text", text: JSON.stringify(item, null, 2) }] };
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
    description: "Query company tasks (company_tasks table). View pending work for companies.",
    inputSchema: {
      company_slug: z.string().optional().describe("Filter by company slug"),
      status: z.enum(["proposed", "approved", "in_progress", "done", "dismissed", "all"]).default("all").describe("Filter by status"),
      limit: z.number().default(50).describe("Max rows"),
    },
  },
  async ({ company_slug, status, limit }) => {
    const params = [];
    const conditions = [];
    if (company_slug) { params.push(company_slug); conditions.push(`c.slug = $${params.length}`); }
    if (status && status !== "all") { params.push(status); conditions.push(`t.status = $${params.length}`); }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit);
    const rows = await sql.query(`
      SELECT t.id, c.slug as company, t.category, t.title, t.status, t.priority, t.source,
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

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[hive-mcp] Server started");
