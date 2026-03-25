import { getDb, json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { getSettingValue } from "@/lib/settings";
import { dispatchEvent } from "@/lib/dispatch";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const { id } = await params;
  const body = await req.json();
  const { resolution } = body;

  const sql = getDb();
  const [directive] = await sql`
    UPDATE directives SET status = 'done', resolution = ${resolution || null}, resolved_at = now()
    WHERE id = ${id} RETURNING *
  `;
  if (!directive) return err("Directive not found", 404);

  // Close the GitHub Issue if it exists
  if (directive.github_issue_number) {
    const token = await getSettingValue("github_token");
    const owner = await getSettingValue("github_owner");
    if (token && owner) {
      try {
        await fetch(`https://api.github.com/repos/${owner}/hive/issues/${directive.github_issue_number}`, {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            state: "closed",
            body: (directive.text || "") + `\n\n---\n**Resolution:** ${resolution || "Completed by Hive orchestrator"}`,
          }),
        });
      } catch (e) {
        console.error("Failed to close GitHub issue:", e);
      }
    }
  }

  // Check for approved knowledge_gap type proposals that need CEO attention
  try {
    const knowledgeGapProposals = await sql`
      SELECT id, title, diagnosis, proposed_fix, affected_companies
      FROM evolver_proposals
      WHERE status = 'approved'
        AND implemented_at IS NULL
        AND proposed_fix->>'type' = 'knowledge_gap'
        AND reviewed_at > NOW() - INTERVAL '14 days'
      LIMIT 5
    `;

    if (knowledgeGapProposals.length > 0) {
      // Dispatch CEO review for knowledge gap proposals
      await dispatchEvent("ceo_review", {
        source: "directive_close",
        trigger: "knowledge_gap_proposals",
        directive_id: directive.id,
        knowledge_gap_proposals: knowledgeGapProposals.map((p: any) => ({
          id: p.id,
          title: p.title,
          diagnosis: p.diagnosis,
          proposed_fix: p.proposed_fix,
          affected_companies: p.affected_companies
        }))
      });
    }
  } catch (e) {
    console.error("Failed to check knowledge gap proposals:", e);
  }

  return json(directive);
}
