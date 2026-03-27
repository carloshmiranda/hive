import { getDb, json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { setSentryTags } from "@/lib/sentry-tags";

export async function GET(req: Request) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("company_id");
  const cycleId = searchParams.get("cycle_id");
  const status = searchParams.get("status");
  const limit = parseInt(searchParams.get("limit") || "50");

  // Set Sentry tags for error tracking
  setSentryTags({
    company_id: companyId || undefined,
    action_type: "fetch_actions"
  });

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

  // Set Sentry tags for error tracking
  setSentryTags({
    company_id: String(company_id),
    agent: agent,
    action_type: action_type
  });

  // Enhanced detection for 0-turn workflow dispatch errors
  // These are GitHub Actions YAML/dispatch issues, not real agent execution failures
  if (status === "failed" && error) {
    const is0TurnError =
      // Zero or null tokens indicates workflow never started executing
      (tokens_used === 0 || tokens_used == null) &&
      (
        // Known 0-turn error patterns
        error.includes("unknown (0 turns)") ||
        error.includes("exhausted after 0 turns") ||
        error.includes("workflow file issue") ||
        error.includes("syntax error") ||
        error.includes("YAML syntax") ||
        error.includes("workflow dispatch failed") ||
        error.includes("workflow not found") ||
        error.includes("invalid workflow") ||
        description?.includes("unknown (0 turns)") ||
        description?.includes("dispatch failed")
      );

    // Also check for GitHub Actions brain agents that failed without any execution evidence
    const isBrainAgent = ['ceo', 'scout', 'engineer', 'evolver', 'healer'].includes(agent);
    const isPreWorkflowLogging =
      isBrainAgent &&
      (tokens_used === 0 || tokens_used == null) &&
      !input && // No input means workflow didn't process the payload
      (!output || output === '{}' || output === 'null'); // No meaningful output

    if (is0TurnError || isPreWorkflowLogging) {
      console.log(`Skipping 0-turn failure log for ${agent}:${action_type} - GitHub Actions dispatch error, not agent execution failure`);
      console.log(`Error details: tokens=${tokens_used}, error="${error?.slice(0, 200)}"`);
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
