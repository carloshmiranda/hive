import { NextRequest } from "next/server";
import { validateOIDC } from "@/lib/oidc";
import { getDb, json, err } from "@/lib/db";
import { setSentryTags } from "@/lib/sentry-tags";

// POST /api/decisions — log strategic decisions for retrospective analysis
// Body: { company_id, cycle_id?, decision_type, reasoning, expected_outcome, decision_data? }
export async function POST(req: NextRequest) {
  setSentryTags({
    action_type: "agent_api",
    route: "/api/decisions",
  });

  const claims = await validateOIDC(req);
  if (claims instanceof Response) return claims;

  let body;
  try {
    body = await req.json();
  } catch {
    return err("Invalid JSON body", 400);
  }

  const { company_id, cycle_id, decision_type, reasoning, expected_outcome, decision_data } = body;

  // Validate required fields
  if (!company_id || !decision_type || !reasoning || !expected_outcome) {
    return err("Missing required fields: company_id, decision_type, reasoning, expected_outcome", 400);
  }

  // Validate decision_type enum
  const validDecisionTypes = ['kill', 'pivot', 'phase_change', 'priority_shift'];
  if (!validDecisionTypes.includes(decision_type)) {
    return err(`Invalid decision_type. Must be one of: ${validDecisionTypes.join(', ')}`, 400);
  }

  const sql = getDb();

  // Verify company exists
  const [company] = await sql`
    SELECT id FROM companies WHERE id = ${company_id} LIMIT 1
  `.catch(() => []);
  if (!company) {
    return err("Company not found", 404);
  }

  // Verify cycle exists if provided
  if (cycle_id) {
    const [cycle] = await sql`
      SELECT id FROM cycles WHERE id = ${cycle_id} AND company_id = ${company_id} LIMIT 1
    `.catch(() => []);
    if (!cycle) {
      return err("Cycle not found", 404);
    }
  }

  // Insert decision log entry
  const [decision] = await sql`
    INSERT INTO decision_log (company_id, cycle_id, decision_type, reasoning, expected_outcome, decision_data)
    VALUES (${company_id}, ${cycle_id || null}, ${decision_type}, ${reasoning}, ${expected_outcome},
            ${decision_data ? JSON.stringify(decision_data) : null}::jsonb)
    RETURNING id, created_at
  `;

  return json({
    logged: true,
    decision_id: decision.id,
    created_at: decision.created_at
  }, 201);
}

// GET /api/decisions — retrieve decision history for analysis
export async function GET(req: NextRequest) {
  setSentryTags({
    action_type: "agent_api",
    route: "/api/decisions",
  });

  const claims = await validateOIDC(req);
  if (claims instanceof Response) return claims;

  const { searchParams } = new URL(req.url);
  const companyId = searchParams.get("company_id");
  const decisionType = searchParams.get("decision_type");
  const pendingValidation = searchParams.get("pending_validation") === "true";

  const sql = getDb();

  let query = sql`
    SELECT d.*, c.slug as company_slug, c.name as company_name,
           cy.cycle_number
    FROM decision_log d
    JOIN companies c ON c.id = d.company_id
    LEFT JOIN cycles cy ON cy.id = d.cycle_id
    WHERE 1=1
  `;

  if (companyId) {
    query = sql`${query} AND d.company_id = ${companyId}`;
  }

  if (decisionType) {
    query = sql`${query} AND d.decision_type = ${decisionType}`;
  }

  if (pendingValidation) {
    query = sql`${query} AND d.was_correct IS NULL AND d.created_at < NOW() - INTERVAL '30 days'`;
  }

  query = sql`${query} ORDER BY d.created_at DESC LIMIT 100`;

  const decisions = await query;
  return json(decisions);
}