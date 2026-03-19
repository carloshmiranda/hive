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

      case "vercel_pro_upgrade": {
        // Vercel doesn't have a plan upgrade API — log the manual action required
        const upgradeCtx = approval.context as { project_slug?: string; vercel_project_id?: string } | null;
        if (approval.company_id) {
          await sql`
            INSERT INTO agent_actions (company_id, agent, action_type, description, status, started_at, finished_at)
            VALUES (
              ${approval.company_id}, 'orchestrator', 'vercel_upgrade_approved',
              ${`Vercel Pro upgrade approved. Manual action: go to https://vercel.com/${upgradeCtx?.project_slug || "dashboard"}/settings/billing and upgrade to Pro.`},
              'pending_manual', now(), now()
            )
          `;
        }
        break;
      }

      case "first_revenue": {
        // First paying customer detected — create the Vercel Pro upgrade gate
        if (approval.company_id) {
          const [comp] = await sql`SELECT slug FROM companies WHERE id = ${approval.company_id}`;
          await sql`
            INSERT INTO approvals (company_id, gate_type, title, description, context)
            VALUES (
              ${approval.company_id},
              'vercel_pro_upgrade',
              ${`Upgrade ${comp?.slug || "company"} to Vercel Pro`},
              ${`This company has its first paying customer. Vercel Hobby plan is non-commercial — it must be upgraded to Pro (€20/mo). Go to the Vercel dashboard to upgrade.`},
              ${JSON.stringify({ project_slug: comp?.slug })}
            )
          `;
        }
        break;
      }
    }
  }

  // Rejection side effects
  if (decision === "rejected") {
    switch (approval.gate_type) {
      case "new_company":
        // Clean up rejected idea — mark as killed so it doesn't clutter the dashboard
        if (approval.company_id) {
          await sql`
            UPDATE companies SET 
              status = 'killed', 
              killed_at = now(), 
              kill_reason = ${note || "Idea rejected by Carlos"},
              updated_at = now() 
            WHERE id = ${approval.company_id} AND status = 'idea'
          `;
        }
        break;
    }
  }

  return json(approval);
}
