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
      limit: z.number().default(50).describe("Max rows to return"),
    },
  },
  async ({ status, priority }) => {
    const conditions = [];
    const params = [];
    if (status !== "all") { conditions.push(`status = '${status}'`); }
    if (priority !== "all") { conditions.push(`priority = '${priority}'`); }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = await sql.query(`
      SELECT id, priority, title, category, status, source, notes, pr_number,
             created_at::date as created, dispatched_at, completed_at
      FROM hive_backlog ${where}
      ORDER BY CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END, created_at
      LIMIT 100
    `);
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
    const total = await sql`SELECT count(*)::int as total FROM hive_backlog`;
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ total: total[0].total, by_status: byStatus, by_priority: byPriority }, null, 2),
      }],
    };
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
      notes: z.string().optional().describe("Append to notes"),
    },
  },
  async ({ id, status, priority, notes }) => {
    const sets = [];
    if (status) sets.push(`status = '${status}'`);
    if (priority) sets.push(`priority = '${priority}'`);
    if (notes) sets.push(`notes = COALESCE(notes, '') || ' ${notes.replace(/'/g, "''")}'`);
    if (status === "done") sets.push(`completed_at = NOW()`);
    if (sets.length === 0) return { content: [{ type: "text", text: "No updates specified" }] };
    const [row] = await sql.query(`UPDATE hive_backlog SET ${sets.join(", ")} WHERE id = '${id}' RETURNING id, title, status, priority, notes`);
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
      const sets = [];
      if (status) sets.push(`status = '${status}'`);
      if (priority) sets.push(`priority = '${priority}'`);
      if (notes) sets.push(`notes = COALESCE(notes, '') || ' ${notes.replace(/'/g, "''")}'`);
      if (status === "done") sets.push(`completed_at = NOW()`);
      if (sets.length === 0) continue;
      const [row] = await sql.query(`UPDATE hive_backlog SET ${sets.join(", ")} WHERE id = '${id}' RETURNING id, title, status, priority`);
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
    const [row] = await sql.query(`DELETE FROM hive_backlog WHERE id = '${id}' RETURNING id, title`);
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
    const where = status ? `WHERE c.status = '${status}'` : "";
    const rows = await sql.query(`
      SELECT c.id, c.name, c.slug, c.status, c.company_type, c.business_model,
             c.market, c.content_language,
             (SELECT count(*) FROM cycles WHERE company_id = c.id) as cycle_count,
             (SELECT score FROM cycles WHERE company_id = c.id ORDER BY started_at DESC LIMIT 1) as last_score,
             c.created_at::date as created
      FROM companies c ${where}
      ORDER BY c.status, c.name
    `);
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
    const conditions = [`started_at > NOW() - INTERVAL '${hours} hours'`];
    if (agent) conditions.push(`agent = '${agent}'`);
    if (status) conditions.push(`status = '${status}'`);
    const rows = await sql.query(`
      SELECT id, agent, action_type, company_id, status,
             substring(description from 1 for 120) as description,
             substring(error from 1 for 120) as error,
             started_at, finished_at,
             EXTRACT(EPOCH FROM (COALESCE(finished_at, NOW()) - started_at))::int as duration_s
      FROM agent_actions
      WHERE ${conditions.join(" AND ")}
      ORDER BY started_at DESC
      LIMIT ${limit}
    `);
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
    const byAgent = await sql.query(`
      SELECT agent, count(*)::int as failures,
             count(CASE WHEN error IS NULL THEN 1 END)::int as null_errors
      FROM agent_actions
      WHERE status = 'failed' AND started_at > NOW() - INTERVAL '${hours} hours'
      GROUP BY agent ORDER BY failures DESC
    `);
    const topErrors = await sql.query(`
      SELECT agent, substring(error from 1 for 150) as error, count(*)::int as count
      FROM agent_actions
      WHERE status = 'failed' AND error IS NOT NULL AND started_at > NOW() - INTERVAL '${hours} hours'
      GROUP BY agent, substring(error from 1 for 150) ORDER BY count DESC LIMIT 15
    `);
    const total = await sql.query(`
      SELECT count(*)::int as total_actions,
             count(CASE WHEN status = 'failed' THEN 1 END)::int as failed,
             count(CASE WHEN status = 'success' THEN 1 END)::int as succeeded
      FROM agent_actions WHERE started_at > NOW() - INTERVAL '${hours} hours'
    `);
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
    const where = status === "all" ? "" : `WHERE status = '${status}'`;
    const rows = await sql.query(`
      SELECT id, gate_type, title, status,
             substring(description from 1 for 200) as description,
             context, created_at
      FROM approvals ${where}
      ORDER BY created_at DESC LIMIT 30
    `);
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
    const where = company_id ? `WHERE company_id = '${company_id}'` : "";
    const rows = await sql.query(`
      SELECT c.id, co.name as company, c.status, c.score,
             c.started_at, c.finished_at,
             substring(c.plan::text from 1 for 200) as plan_preview,
             substring(c.review::text from 1 for 200) as review_preview
      FROM cycles c
      LEFT JOIN companies co ON co.id = c.company_id
      ${where}
      ORDER BY c.started_at DESC
      LIMIT ${limit}
    `);
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
      SELECT co.name, c.score, c.status, c.started_at::date as date
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

// Start server
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[hive-mcp] Server started");
