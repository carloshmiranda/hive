import { getDb, json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { setSentryTags } from "@/lib/sentry-tags";

/**
 * POST /api/admin/scout-reset
 *
 * Emergency Scout pipeline reset for Carlos.
 * Expires all pending Scout proposals and cleans up orphaned idea companies.
 * Use when Scout proposals are completely blocking company execution.
 */
export async function POST(req: Request) {
  setSentryTags({
    action_type: "admin",
    route: "/api/admin/scout-reset",
  });

  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const body = await req.json();
  const { reason = "Manual Scout reset by Carlos", slugs } = body;

  // Require an explicit list of slugs — no more bulk "kill all ideas" operations
  if (!slugs || !Array.isArray(slugs) || slugs.length === 0) {
    return err("Missing required field: 'slugs' (array of company slugs to reset). Bulk operations without explicit targets are banned.", 400);
  }

  const sql = getDb();

  // Get pending new_company proposals for the specified companies only
  const pendingProposals = await sql`
    SELECT a.id, a.title, a.company_id FROM approvals a
    JOIN companies c ON c.id = a.company_id
    WHERE a.gate_type = 'new_company' AND a.status = 'pending'
    AND c.slug = ANY(${slugs})
  `;

  if (pendingProposals.length === 0) {
    return json({
      action: "no_proposals_found",
      message: "No pending Scout proposals to clean up for the specified slugs"
    });
  }

  // Expire pending new_company proposals for the specified companies only
  const expiredApprovals = await sql`
    UPDATE approvals
    SET status = 'expired',
        decision_note = ${reason},
        decided_at = NOW()
    WHERE id = ANY(${pendingProposals.map((p: any) => p.id)})
    RETURNING id, title, company_id
  `;

  // Kill only the explicitly specified idea companies
  const killedCompanies = await sql`
    UPDATE companies
    SET status = 'killed',
        killed_at = NOW(),
        kill_reason = ${reason},
        updated_at = NOW()
    WHERE slug = ANY(${slugs})
    AND status = 'idea'
    RETURNING id, slug, name
  `;

  // Log the reset action
  await sql`
    INSERT INTO agent_actions (
      company_id, agent, action_type, input, output, status, started_at, finished_at
    ) VALUES (
      NULL,
      'admin',
      'scout_pipeline_reset',
      ${JSON.stringify({ reason })},
      ${JSON.stringify({
        expired_proposals: expiredApprovals.length,
        killed_companies: killedCompanies.length,
        proposal_ids: expiredApprovals.map((a: any) => a.id),
        company_ids: killedCompanies.map((c: any) => c.id)
      })},
      'completed',
      NOW(),
      NOW()
    )
  `;

  return json({
    action: "reset_completed",
    expired_proposals: expiredApprovals.length,
    killed_companies: killedCompanies.length,
    details: {
      proposals: expiredApprovals.map((a: any) => ({ id: a.id, title: a.title })),
      companies: killedCompanies.map((c: any) => ({ id: c.id, slug: c.slug, name: c.name }))
    },
    message: `Scout pipeline reset: ${expiredApprovals.length} proposals expired, ${killedCompanies.length} idea companies killed`
  });
}