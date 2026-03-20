import { getDb, json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { dispatchEvent } from "@/lib/dispatch";

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

  if (decision === "approved") {
    const fixType = proposal.proposed_fix?.type;

    if (fixType === "prompt_update") {
      // Activate the new prompt version immediately
      const targetAgent = proposal.proposed_fix.target;
      if (targetAgent) {
        await sql`UPDATE agent_prompts SET is_active = false WHERE agent = ${targetAgent} AND is_active = true`;
        await sql`
          UPDATE agent_prompts SET is_active = true, promoted_at = NOW()
          WHERE agent = ${targetAgent} AND is_active = false
          AND id = (SELECT id FROM agent_prompts WHERE agent = ${targetAgent} ORDER BY version DESC LIMIT 1)
        `;
      }
      // prompt_update is implemented immediately — mark it
      await sql`UPDATE evolver_proposals SET status = 'implemented', implemented_at = NOW() WHERE id = ${id}`;

    } else if (fixType === "setup_action") {
      // Create a manual action todo so it surfaces in the dashboard
      const affectedCompanies = proposal.affected_companies || [];
      const firstCompany = affectedCompanies[0];
      let companyId = null;
      if (firstCompany) {
        const [comp] = await sql`SELECT id FROM companies WHERE slug = ${firstCompany} LIMIT 1`;
        companyId = comp?.id || null;
      }
      await sql`
        INSERT INTO agent_actions (agent, action_type, description, status, output, started_at, finished_at, company_id)
        VALUES ('evolver', 'setup_action', ${`Evolver proposal approved: ${proposal.title}`}, 'pending_manual',
          ${JSON.stringify({ proposal_id: proposal.id, proposed_fix: proposal.proposed_fix, diagnosis: proposal.diagnosis })}::jsonb,
          NOW(), NOW(), ${companyId})
      `;
      // Also dispatch to CEO so it can incorporate in next cycle plan
      await dispatchEvent("ceo_review", {
        source: "evolver",
        proposal_id: proposal.id,
        proposal_type: fixType,
        title: proposal.title,
        change: proposal.proposed_fix?.change,
      });

    } else if (fixType === "knowledge_gap") {
      // Dispatch to CEO to extract knowledge into playbook
      await dispatchEvent("ceo_review", {
        source: "evolver",
        proposal_id: proposal.id,
        proposal_type: fixType,
        title: proposal.title,
        change: proposal.proposed_fix?.change,
      });

    } else if (fixType === "code_fix") {
      // Dispatch to Engineer to implement the fix
      const affectedCompanies = proposal.affected_companies || [];
      const firstCompany = affectedCompanies[0];
      await dispatchEvent("feature_request", {
        source: "evolver",
        proposal_id: proposal.id,
        title: proposal.title,
        change: proposal.proposed_fix?.change,
        target: proposal.proposed_fix?.target,
        company: firstCompany || "",
      });
    }
  }

  return json({ ok: true, status: decision });
}

