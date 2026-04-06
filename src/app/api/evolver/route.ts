import { getDb, json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { dispatchEvent } from "@/lib/dispatch";

// Batch reject proposals based on criteria
async function batchRejectProposals(criteria: any, notes?: string) {
  const sql = getDb();

  if (criteria.title_patterns && Array.isArray(criteria.title_patterns)) {
    // Handle recurring-escalation-automation patterns
    const patterns = criteria.title_patterns;
    const proposals = await sql`
      SELECT id, title FROM evolver_proposals
      WHERE status = 'pending'
      AND (
        title ILIKE ANY(${patterns.map((p: string) => `%${p}%`)})
        ${criteria.gap_type ? sql`AND gap_type = ${criteria.gap_type}` : sql``}
      )
    `;

    if (proposals.length === 0) {
      return json({ rejected_count: 0, message: "No proposals matched criteria" });
    }

    const proposalIds = proposals.map(p => p.id);
    const rejectionNote = notes || "Batch rejected: describes symptoms rather than root causes";

    await sql`
      UPDATE evolver_proposals
      SET status = 'rejected', reviewed_at = NOW(), notes = ${rejectionNote}
      WHERE id = ANY(${proposalIds})
    `;

    return json({
      rejected_count: proposals.length,
      rejected_proposals: proposals.map(p => ({ id: p.id, title: p.title }))
    });
  }

  return err("No valid criteria provided for batch rejection");
}

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

// PATCH /api/evolver — approve/reject/defer a proposal or batch reject
export async function PATCH(req: Request) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const body = await req.json();
  const { id, decision, notes, batch_action, criteria } = body;

  // Handle batch operations
  if (batch_action) {
    if (batch_action === "batch_reject" && criteria) {
      return await batchRejectProposals(criteria, notes);
    }
    return err("Invalid batch action or missing criteria");
  }

  if (!id || !decision) return err("id and decision required");
  if (!["approved", "rejected", "deferred", "implemented"].includes(decision)) {
    return err("decision must be approved, rejected, deferred, or implemented");
  }

  const sql = getDb();

  const [proposal] = await sql`SELECT * FROM evolver_proposals WHERE id = ${id}`;
  if (!proposal) return err("Proposal not found", 404);
  if (!["pending", "deferred"].includes(proposal.status)) {
    return err(`Proposal already ${proposal.status}`);
  }

  // Mark as implemented — manual dismissal for fixes already applied outside the approval flow
  if (decision === "implemented") {
    await sql`
      UPDATE evolver_proposals
      SET status = 'implemented',
          reviewed_at = NOW(),
          implemented_at = NOW(),
          notes = COALESCE(${notes || null}, notes, 'Manually marked as implemented')
      WHERE id = ${id}
    `;
    return json({ ok: true, status: "implemented" });
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
      // Create hive_backlog item for Engineer dispatch
      const backlogDescription = `${proposal.diagnosis}\n\nProposed fix: ${proposal.proposed_fix?.change || 'See proposal for details'}`;

      const [backlogItem] = await sql`
        INSERT INTO hive_backlog (title, description, priority, category, status, source, notes, spec)
        VALUES (
          ${proposal.title},
          ${backlogDescription},
          'P2',
          'feature',
          'ready',
          'evolver',
          ${`Evolver proposal ${proposal.id}`},
          ${JSON.stringify({
            evolver_proposal_id: proposal.id,
            affected_files: proposal.proposed_fix?.affected_files || [],
            acceptance_criteria: proposal.proposed_fix?.acceptance_criteria || [],
            approach: proposal.proposed_fix?.change || ''
          })}::jsonb
        )
        RETURNING id
      `;

      // Link the proposal to the backlog item for tracking
      await sql`
        UPDATE evolver_proposals
        SET notes = COALESCE(notes, '') || ${` | Backlog item created: ${backlogItem.id}`}
        WHERE id = ${id}
      `;

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
          ${JSON.stringify({ proposal_id: proposal.id, proposed_fix: proposal.proposed_fix, diagnosis: proposal.diagnosis, backlog_id: backlogItem.id })}::jsonb,
          NOW(), NOW(), ${companyId})
      `;

    } else if (fixType === "knowledge_gap") {
      // Create hive_backlog item for CEO to extract knowledge into playbook
      const backlogDescription = `${proposal.diagnosis}\n\nKnowledge gap to address: ${proposal.proposed_fix?.change || 'See proposal for details'}`;

      const [backlogItem] = await sql`
        INSERT INTO hive_backlog (title, description, priority, category, status, source, notes, spec)
        VALUES (
          ${`Extract knowledge: ${proposal.title}`},
          ${backlogDescription},
          'P2',
          'research',
          'ready',
          'evolver',
          ${`Evolver proposal ${proposal.id}`},
          ${JSON.stringify({
            evolver_proposal_id: proposal.id,
            knowledge_domain: proposal.proposed_fix?.domain || '',
            acceptance_criteria: proposal.proposed_fix?.acceptance_criteria || [],
            approach: proposal.proposed_fix?.change || ''
          })}::jsonb
        )
        RETURNING id
      `;

      // Link the proposal to the backlog item for tracking
      await sql`
        UPDATE evolver_proposals
        SET notes = COALESCE(notes, '') || ${` | Backlog item created: ${backlogItem.id}`}
        WHERE id = ${id}
      `;

      // Dispatch to CEO to extract knowledge into playbook
      await dispatchEvent("ceo_review", {
        source: "evolver",
        proposal_id: proposal.id,
        proposal_type: fixType,
        title: proposal.title,
        change: proposal.proposed_fix?.change,
        backlog_id: backlogItem.id
      });

    } else if (fixType === "code_fix") {
      // Create hive_backlog item for Engineer dispatch
      const backlogDescription = `${proposal.diagnosis}\n\nCode fix needed: ${proposal.proposed_fix?.change || 'See proposal for details'}`;

      const [backlogItem] = await sql`
        INSERT INTO hive_backlog (title, description, priority, category, status, source, notes, spec)
        VALUES (
          ${proposal.title},
          ${backlogDescription},
          'P2',
          'bugfix',
          'ready',
          'evolver',
          ${`Evolver proposal ${proposal.id}`},
          ${JSON.stringify({
            evolver_proposal_id: proposal.id,
            affected_files: proposal.proposed_fix?.affected_files || [],
            acceptance_criteria: proposal.proposed_fix?.acceptance_criteria || [],
            approach: proposal.proposed_fix?.change || ''
          })}::jsonb
        )
        RETURNING id
      `;

      // Link the proposal to the backlog item for tracking
      await sql`
        UPDATE evolver_proposals
        SET notes = COALESCE(notes, '') || ${` | Backlog item created: ${backlogItem.id}`}
        WHERE id = ${id}
      `;

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
        backlog_id: backlogItem.id
      });
    }
  }

  return json({ ok: true, status: decision });
}

// POST /api/evolver/auto-approve — auto-approve proposals after 48h
export async function POST(req: Request) {
  // This endpoint should only be called by system/cron, not by users
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return err("Unauthorized", 401);
  }

  const sql = getDb();

  // Auto-approve capability gaps with medium severity + concrete fix after 48h
  const autoApproveProposals = await sql`
    SELECT id, title, proposed_fix, affected_companies
    FROM evolver_proposals
    WHERE status = 'pending'
      AND gap_type = 'capability'
      AND severity = 'medium'
      AND proposed_fix->>'change' IS NOT NULL
      AND LENGTH(proposed_fix->>'change') > 50
      AND created_at < NOW() - INTERVAL '48 hours'
  `;

  let approvedCount = 0;

  for (const proposal of autoApproveProposals) {
    // Auto-approve the proposal
    await sql`
      UPDATE evolver_proposals
      SET status = 'approved',
          reviewed_at = NOW(),
          notes = 'Auto-approved after 48h: capability gap with medium severity and concrete fix'
      WHERE id = ${proposal.id}
    `;

    // Handle the implementation based on fix type
    const fixType = proposal.proposed_fix?.type;

    if (fixType === "setup_action") {
      // Create hive_backlog item for Engineer dispatch
      const backlogDescription = `${proposal.diagnosis}\n\nProposed fix: ${proposal.proposed_fix?.change || 'See proposal for details'}`;

      const [backlogItem] = await sql`
        INSERT INTO hive_backlog (title, description, priority, category, status, source, notes, spec)
        VALUES (
          ${proposal.title},
          ${backlogDescription},
          'P2',
          'feature',
          'ready',
          'evolver',
          ${`Auto-approved evolver proposal ${proposal.id}`},
          ${JSON.stringify({
            evolver_proposal_id: proposal.id,
            affected_files: proposal.proposed_fix?.affected_files || [],
            acceptance_criteria: proposal.proposed_fix?.acceptance_criteria || [],
            approach: proposal.proposed_fix?.change || '',
            auto_approved: true
          })}::jsonb
        )
        RETURNING id
      `;

      // Link the proposal to the backlog item for tracking
      await sql`
        UPDATE evolver_proposals
        SET notes = COALESCE(notes, '') || ${` | Auto-approved backlog item created: ${backlogItem.id}`}
        WHERE id = ${proposal.id}
      `;

      const affectedCompanies = proposal.affected_companies || [];
      const firstCompany = affectedCompanies[0];
      let companyId = null;
      if (firstCompany) {
        const [comp] = await sql`SELECT id FROM companies WHERE slug = ${firstCompany} LIMIT 1`;
        companyId = comp?.id || null;
      }
      await sql`
        INSERT INTO agent_actions (agent, action_type, description, status, output, started_at, finished_at, company_id)
        VALUES ('evolver', 'setup_action', ${`Auto-approved evolver proposal: ${proposal.title}`}, 'pending_manual',
          ${JSON.stringify({ proposal_id: proposal.id, proposed_fix: proposal.proposed_fix, auto_approved: true, backlog_id: backlogItem.id })}::jsonb,
          NOW(), NOW(), ${companyId})
      `;

    } else if (fixType === "knowledge_gap") {
      // Create hive_backlog item for CEO to extract knowledge into playbook
      const backlogDescription = `${proposal.diagnosis}\n\nKnowledge gap to address: ${proposal.proposed_fix?.change || 'See proposal for details'}`;

      const [backlogItem] = await sql`
        INSERT INTO hive_backlog (title, description, priority, category, status, source, notes, spec)
        VALUES (
          ${`Extract knowledge: ${proposal.title}`},
          ${backlogDescription},
          'P2',
          'research',
          'ready',
          'evolver',
          ${`Auto-approved evolver proposal ${proposal.id}`},
          ${JSON.stringify({
            evolver_proposal_id: proposal.id,
            knowledge_domain: proposal.proposed_fix?.domain || '',
            acceptance_criteria: proposal.proposed_fix?.acceptance_criteria || [],
            approach: proposal.proposed_fix?.change || '',
            auto_approved: true
          })}::jsonb
        )
        RETURNING id
      `;

      // Link the proposal to the backlog item for tracking
      await sql`
        UPDATE evolver_proposals
        SET notes = COALESCE(notes, '') || ${` | Auto-approved backlog item created: ${backlogItem.id}`}
        WHERE id = ${proposal.id}
      `;

    } else if (fixType === "code_fix") {
      // Create hive_backlog item for Engineer dispatch
      const backlogDescription = `${proposal.diagnosis}\n\nCode fix needed: ${proposal.proposed_fix?.change || 'See proposal for details'}`;

      const [backlogItem] = await sql`
        INSERT INTO hive_backlog (title, description, priority, category, status, source, notes, spec)
        VALUES (
          ${proposal.title},
          ${backlogDescription},
          'P2',
          'bugfix',
          'ready',
          'evolver',
          ${`Auto-approved evolver proposal ${proposal.id}`},
          ${JSON.stringify({
            evolver_proposal_id: proposal.id,
            affected_files: proposal.proposed_fix?.affected_files || [],
            acceptance_criteria: proposal.proposed_fix?.acceptance_criteria || [],
            approach: proposal.proposed_fix?.change || '',
            auto_approved: true
          })}::jsonb
        )
        RETURNING id
      `;

      // Link the proposal to the backlog item for tracking
      await sql`
        UPDATE evolver_proposals
        SET notes = COALESCE(notes, '') || ${` | Auto-approved backlog item created: ${backlogItem.id}`}
        WHERE id = ${proposal.id}
      `;
    }

    approvedCount++;
  }

  return json({
    auto_approved_count: approvedCount,
    auto_approved_proposals: autoApproveProposals.map(p => ({ id: p.id, title: p.title }))
  });
}

