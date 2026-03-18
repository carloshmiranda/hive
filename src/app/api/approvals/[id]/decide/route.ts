import { getDb, json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const { id } = await params;
  const body = await req.json();
  const { decision, note } = body;

  if (!decision || !["approved", "rejected"].includes(decision)) {
    return err("decision must be 'approved' or 'rejected'");
  }

  const sql = getDb();

  // Verify it's still pending
  const [existing] = await sql`SELECT * FROM approvals WHERE id = ${id}`;
  if (!existing) return err("Approval not found", 404);
  if (existing.status !== "pending") return err(`Already ${existing.status}`);

  // Update the approval
  const [approval] = await sql`
    UPDATE approvals SET
      status = ${decision},
      decided_at = now(),
      decision_note = ${note || null}
    WHERE id = ${id}
    RETURNING *
  `;

  // Side effects based on gate type + decision
  if (decision === "approved") {
    switch (approval.gate_type) {
      case "new_company":
        // Move company from 'idea' to 'approved' — provisioner picks it up
        if (approval.company_id) {
          await sql`UPDATE companies SET status = 'approved', updated_at = now() WHERE id = ${approval.company_id}`;
        }
        break;

      case "kill_company":
        // Mark company as killed
        if (approval.company_id) {
          await sql`
            UPDATE companies SET 
              status = 'killed', 
              killed_at = now(), 
              kill_reason = ${note || "Approved by Kill Switch"},
              updated_at = now() 
            WHERE id = ${approval.company_id}
          `;
        }
        break;

      case "prompt_upgrade":
        // Activate the proposed prompt version
        const ctx = approval.context as { agent?: string; version?: number } | null;
        if (ctx?.agent && ctx?.version) {
          await sql`UPDATE agent_prompts SET is_active = false WHERE agent = ${ctx.agent}`;
          await sql`UPDATE agent_prompts SET is_active = true, promoted_at = now() WHERE agent = ${ctx.agent} AND version = ${ctx.version}`;
        }
        break;
    }
  }

  return json(approval);
}
