import { getDb, json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

export async function GET(req: Request) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("company_id");
  const cycleId = searchParams.get("cycle_id");
  const status = searchParams.get("status");
  const limit = parseInt(searchParams.get("limit") || "50");

  const sql = getDb();

  let actions;
  if (cycleId) {
    actions = await sql`
      SELECT a.*, c.slug as company_slug FROM agent_actions a 
      JOIN companies c ON c.id = a.company_id
      WHERE a.cycle_id = ${cycleId} ORDER BY a.started_at ASC
    `;
  } else if (companyId && status) {
    actions = await sql`
      SELECT a.*, c.slug as company_slug FROM agent_actions a
      JOIN companies c ON c.id = a.company_id
      WHERE a.company_id = ${companyId} AND a.status = ${status}
      ORDER BY a.started_at DESC LIMIT ${limit}
    `;
  } else if (status) {
    actions = await sql`
      SELECT a.*, c.slug as company_slug FROM agent_actions a
      JOIN companies c ON c.id = a.company_id
      WHERE a.status = ${status}
      ORDER BY a.started_at DESC LIMIT ${limit}
    `;
  } else {
    actions = await sql`
      SELECT a.*, c.slug as company_slug FROM agent_actions a
      JOIN companies c ON c.id = a.company_id
      ORDER BY a.started_at DESC LIMIT ${limit}
    `;
  }

  return json(actions);
}

export async function POST(req: Request) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const body = await req.json();
  const { cycle_id, company_id, agent, action_type, description, status, input, output, error, reflection, retry_count, tokens_used } = body;

  if (!cycle_id || !company_id || !agent || !action_type) {
    return err("cycle_id, company_id, agent, and action_type required");
  }

  // Don't log failures for 0-turn workflow dispatch errors - these are GitHub Actions YAML issues, not real agent failures
  if (status === "failed" && error && (tokens_used === 0 || tokens_used == null)) {
    const is0TurnError = error.includes("unknown (0 turns)") ||
                        error.includes("exhausted after 0 turns") ||
                        error.includes("workflow file issue") ||
                        error.includes("syntax error") ||
                        description?.includes("unknown (0 turns)");

    if (is0TurnError) {
      console.log(`Skipping 0-turn failure log for ${agent}:${action_type} - GitHub Actions dispatch error, not agent execution failure`);
      return json({ ok: true, skipped: true, reason: "0-turn workflow dispatch error" });
    }
  }

  const sql = getDb();
  const [action] = await sql`
    INSERT INTO agent_actions (cycle_id, company_id, agent, action_type, description, status, input, output, error, reflection, retry_count, tokens_used, started_at, finished_at)
    VALUES (
      ${cycle_id}, ${company_id}, ${agent}, ${action_type},
      ${description || null}, ${status || "pending"},
      ${input ? JSON.stringify(input) : null},
      ${output ? JSON.stringify(output) : null},
      ${error || null}, ${reflection || null},
      ${retry_count || 0}, ${tokens_used || 0},
      now(), CASE WHEN ${status || "pending"} != 'pending' THEN now() ELSE null END
    )
    RETURNING *
  `;
  return json(action, 201);
}
