import { getDb, json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

export async function POST(req: Request) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const body = await req.json();
  const { ids, decision, note } = body as {
    ids: string[];
    decision: "approved" | "rejected";
    note?: string;
  };

  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return err("ids must be a non-empty array");
  }
  if (!decision || !["approved", "rejected"].includes(decision)) {
    return err("decision must be 'approved' or 'rejected'");
  }

  const sql = getDb();

  // Fetch all approvals in the batch
  const approvals = await sql`
    SELECT * FROM approvals WHERE id = ANY(${ids})
  `;

  // For batch approve: block if any are new_company (needs provisioning side effects)
  if (decision === "approved") {
    const newCompanyGates = approvals.filter(a => a.gate_type === "new_company");
    if (newCompanyGates.length > 0) {
      return err(
        `Batch approve is not allowed for new_company gates (IDs: ${newCompanyGates.map(a => a.id).join(", ")}). Approve these individually to trigger provisioning.`
      );
    }
  }

  let processed = 0;
  const skipped: string[] = [];

  for (const approval of approvals) {
    // Skip if not pending
    if (approval.status !== "pending") {
      skipped.push(`${approval.id} (already ${approval.status})`);
      continue;
    }

    // Update the approval status
    await sql`
      UPDATE approvals SET
        status = ${decision},
        decided_at = now(),
        decision_note = ${note || null}
      WHERE id = ${approval.id}
    `;

    // For batch reject: apply rejection side effects (cleanup)
    if (decision === "rejected") {
      switch (approval.gate_type) {
        case "new_company":
          // Clean up rejected idea — mark as killed
          if (approval.company_id) {
            await sql`
              UPDATE companies SET
                status = 'killed',
                killed_at = now(),
                kill_reason = ${note || "Idea rejected by Carlos (batch)"},
                updated_at = now()
              WHERE id = ${approval.company_id} AND status = 'idea'
            `;
          }
          break;
      }
    }

    processed++;
  }

  // Check for IDs that weren't found in the database
  const foundIds = new Set(approvals.map((a: Record<string, any>) => a.id as string));
  for (const id of ids) {
    if (!foundIds.has(id)) {
      skipped.push(`${id} (not found)`);
    }
  }

  return json({ processed, skipped });
}
