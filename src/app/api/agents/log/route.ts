import { NextRequest } from "next/server";
import { validateOIDC } from "@/lib/oidc";
import { getDb, json, err } from "@/lib/db";
import { setSentryTags } from "@/lib/sentry-tags";

// POST /api/agents/log — log agent action via OIDC auth
// Body: { company_slug, agent, action_type, status, description?, error? }
export async function POST(req: NextRequest) {
  setSentryTags({
    action_type: "agent_api",
    route: "/api/agents/log",
  });

  const claims = await validateOIDC(req);
  if (claims instanceof Response) return claims;

  let body;
  try {
    body = await req.json();
  } catch {
    return err("Invalid JSON body", 400);
  }

  const { company_slug, agent, action_type, status, description, error: errorMsg, trace_id, metadata: bodyMetadata } = body;
  if (!agent || !action_type || !status) {
    return err("Missing required fields: agent, action_type, status", 400);
  }

  const sql = getDb();

  let companyId = null;
  if (company_slug) {
    const [company] = await sql`
      SELECT id FROM companies WHERE slug = ${company_slug} LIMIT 1
    `.catch(() => []);
    companyId = company?.id || null;
  }

  // Merge trace_id into metadata for correlation across dispatch chains
  const metadata = {
    ...(typeof bodyMetadata === "object" && bodyMetadata ? bodyMetadata : {}),
    ...(trace_id ? { trace_id } : {}),
  };
  const hasMetadata = Object.keys(metadata).length > 0;

  await sql`
    INSERT INTO agent_actions (agent, company_id, action_type, status, description, error, input, started_at, finished_at)
    VALUES (${agent}, ${companyId}, ${action_type}, ${status},
      ${description || null}, ${errorMsg || null},
      ${hasMetadata ? JSON.stringify(metadata) : null}::jsonb,
      NOW() - INTERVAL '20 minutes', NOW())
  `;

  // Update routing weights on agent completion (post-hook)
  await updateRoutingWeights(sql, action_type, agent, status, metadata);

  return json({ logged: true });
}

// Update routing weights based on agent action completion
async function updateRoutingWeights(sql: any, action_type: string, agent: string, status: string, metadata: any) {
  // Extract model from metadata, fall back to default models per agent
  const model = metadata?.model || getDefaultModel(agent);

  // Only track completion statuses that indicate success/failure
  if (!['success', 'failed'].includes(status)) {
    return;
  }

  const isSuccess = status === 'success';

  try {
    // Upsert routing weights record
    await sql`
      INSERT INTO routing_weights (task_type, model, agent, successes, failures, last_updated)
      VALUES (${action_type}, ${model}, ${agent},
        ${isSuccess ? 1 : 0}, ${isSuccess ? 0 : 1}, NOW())
      ON CONFLICT (task_type, model, agent)
      DO UPDATE SET
        successes = routing_weights.successes + ${isSuccess ? 1 : 0},
        failures = routing_weights.failures + ${isSuccess ? 0 : 1},
        last_updated = NOW()
    `;
  } catch (error) {
    // Log error but don't fail the main request
    console.error('Failed to update routing weights:', error);
  }
}

// Get default model for each agent type
function getDefaultModel(agent: string): string {
  const defaults: Record<string, string> = {
    'ceo': 'claude-opus',
    'scout': 'claude-opus',
    'engineer': 'claude-sonnet',
    'evolver': 'claude-opus',
    'growth': 'openrouter',
    'outreach': 'openrouter',
    'ops': 'openrouter',
    'healer': 'claude-sonnet',
    'orchestrator': 'none', // orchestrator doesn't use LLMs
    'sentinel': 'none'      // sentinel doesn't use LLMs
  };

  return defaults[agent] || 'unknown';
}
