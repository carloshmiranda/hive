import { getDb, json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

/**
 * POST /api/approvals/scout-cleanup
 *
 * DISABLED — Scout proposals are never auto-expired. Carlos reviews them manually.
 * This endpoint previously caused 14 proposals to be dismissed without approval.
 * Only dry_run mode is allowed (for dashboards/monitoring).
 */
export async function POST(req: Request) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const body = await req.json();
  if (!body.dry_run) {
    return err("Auto-cleanup is disabled. Scout proposals require manual review. Use dry_run:true for monitoring only.", 403);
  }

  const {
    max_pending = 3,
    min_age_hours = 48,
    dry_run = false,
    reason = "Pipeline cleanup: too many Scout proposals blocking existing companies"
  } = body;

  if (max_pending < 1 || min_age_hours < 1) {
    return err("max_pending and min_age_hours must be positive integers");
  }

  const sql = getDb();

  // Find all pending new_company proposals, ordered by creation date (oldest first)
  const pendingProposals = await sql`
    SELECT a.*, c.name as company_name, c.slug as company_slug
    FROM approvals a
    LEFT JOIN companies c ON c.id = a.company_id
    WHERE a.gate_type = 'new_company'
    AND a.status = 'pending'
    AND a.created_at < NOW() - INTERVAL '${min_age_hours} hours'
    ORDER BY a.created_at ASC
  `;

  // If we have fewer than or equal to max_pending proposals, nothing to clean
  if (pendingProposals.length <= max_pending) {
    return json({
      action: "no_cleanup_needed",
      total_pending: pendingProposals.length,
      max_allowed: max_pending,
      would_expire: 0,
      expired: []
    });
  }

  // Calculate how many to expire (keep the max_pending most recent ones)
  const toExpire = pendingProposals.slice(0, pendingProposals.length - max_pending);

  if (dry_run) {
    return json({
      action: "dry_run",
      total_pending: pendingProposals.length,
      max_allowed: max_pending,
      would_expire: toExpire.length,
      proposals: toExpire.map(p => ({
        id: p.id,
        title: p.title,
        company: p.company_name || p.company_slug,
        age_hours: Math.round((Date.now() - new Date(p.created_at).getTime()) / (1000 * 60 * 60)),
        created_at: p.created_at
      }))
    });
  }

  // Expire the oldest proposals
  const expiredIds = toExpire.map(p => p.id);

  const expiredApprovals = await sql`
    UPDATE approvals
    SET status = 'expired',
        decision_note = ${reason},
        decided_at = NOW()
    WHERE id = ANY(${expiredIds})
    RETURNING id, title, company_id
  `;

  // Clean up orphaned idea companies for expired proposals
  const cleanedCompanies = await sql`
    UPDATE companies
    SET status = 'killed',
        killed_at = NOW(),
        kill_reason = ${reason},
        updated_at = NOW()
    WHERE id = ANY(${toExpire.map(p => p.company_id).filter(Boolean)})
    AND status = 'idea'
    RETURNING id, slug
  `;

  // Log the cleanup action
  await sql`
    INSERT INTO agent_actions (
      company_id, agent, action_type, input, output, status, started_at, finished_at
    ) VALUES (
      NULL,
      'system',
      'scout_proposal_cleanup',
      ${JSON.stringify({ max_pending, min_age_hours, total_pending: pendingProposals.length })},
      ${JSON.stringify({
        expired_count: expiredApprovals.length,
        cleaned_companies: cleanedCompanies.length,
        expired_ids: expiredIds
      })},
      'completed',
      NOW(),
      NOW()
    )
  `;

  return json({
    action: "cleanup_completed",
    total_pending: pendingProposals.length,
    max_allowed: max_pending,
    expired_count: expiredApprovals.length,
    cleaned_companies: cleanedCompanies.length,
    expired_proposals: expiredApprovals.map(a => ({
      id: a.id,
      title: a.title
    }))
  });
}