import { getDb, json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

// GET /api/evolver          → list proposals (default: pending)
// GET /api/evolver?status=all → all proposals
export async function GET(req: Request) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status") || "pending";
  const sql = getDb();

  const proposals = status === "all"
    ? await sql`
        SELECT ep.*, p.insight as playbook_insight
        FROM evolver_proposals ep
        LEFT JOIN playbook p ON p.id = ep.playbook_entry_id
        ORDER BY
          CASE ep.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
          ep.created_at DESC
        LIMIT 50
      `
    : await sql`
        SELECT ep.*, p.insight as playbook_insight
        FROM evolver_proposals ep
        LEFT JOIN playbook p ON p.id = ep.playbook_entry_id
        WHERE ep.status = ${status}
        ORDER BY
          CASE ep.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
          ep.created_at DESC
        LIMIT 50
      `;

  return json(proposals);
}

// PATCH /api/evolver — approve/reject/defer a proposal
export async function PATCH(req: Request) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const body = await req.json();
  const { id, decision, notes } = body;

  if (!id || !decision) return err("id and decision required");
  if (!["approved", "rejected", "deferred"].includes(decision)) {
    return err("decision must be approved, rejected, or deferred");
  }

  const sql = getDb();

  const [proposal] = await sql`SELECT * FROM evolver_proposals WHERE id = ${id}`;
  if (!proposal) return err("Proposal not found", 404);
  if (proposal.status !== "pending" && proposal.status !== "deferred") {
    return err(`Proposal already ${proposal.status}`);
  }

  await sql`
    UPDATE evolver_proposals
    SET status = ${decision},
        reviewed_at = NOW(),
        notes = COALESCE(${notes || null}, notes)
    WHERE id = ${id}
  `;

  // If approved and it's a prompt_update, activate the new prompt version
  if (decision === "approved" && proposal.proposed_fix?.type === "prompt_update") {
    const targetAgent = proposal.proposed_fix.target;
    if (targetAgent) {
      // Deactivate current active prompt
      await sql`UPDATE agent_prompts SET is_active = false WHERE agent = ${targetAgent} AND is_active = true`;
      // Activate the latest inactive prompt for this agent
      await sql`
        UPDATE agent_prompts SET is_active = true, promoted_at = NOW()
        WHERE agent = ${targetAgent} AND is_active = false
        AND id = (SELECT id FROM agent_prompts WHERE agent = ${targetAgent} ORDER BY version DESC LIMIT 1)
      `;
    }
  }

  return json({ ok: true, status: decision });
}
