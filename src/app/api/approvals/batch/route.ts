import { getDb, json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

type Approval = {
  id: string;
  gate_type: string;
  status: string;
  company_id: string | null;
};

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
  ` as Approval[];

  // For batch approve: block if any are new_company (needs provisioning side effects)
  if (decision === "approved") {
    const newCompanyGates = approvals.filter(a => a.gate_type === "new_company");
    if (newCompanyGates.length > 0) {
      return err(
        `Batch approve is not allowed for new_company gates (IDs: ${newCompanyGates.map(a => a.id).join(", ")}). Approve these individually to trigger provisioning.`
      );
    }
  }

  const pending = approvals.filter((a: Approval) => a.status === "pending");
  const skipped: string[] = approvals
    .filter((a: Approval) => a.status !== "pending")
    .map((a: Approval) => `${a.id} (already ${a.status})`);

  // Parallel approval status updates
  await Promise.all(pending.map((approval: Approval) => sql`
    UPDATE approvals SET
      status = ${decision},
      decided_at = now(),
      decision_note = ${note || null}
    WHERE id = ${approval.id}
  `));

  // Parallel side effects for rejections
  if (decision === "rejected") {
    const newCompanyRejections = pending.filter(
      (a: Approval) => a.gate_type === "new_company" && a.company_id
    );
    await Promise.all(newCompanyRejections.map((approval: Approval) => sql`
      UPDATE companies SET
        status = 'killed',
        killed_at = now(),
        kill_reason = ${note || "Idea rejected by Carlos (batch)"},
        updated_at = now()
      WHERE id = ${approval.company_id} AND status = 'idea'
    `));
  }

  // Check for IDs that weren't found in the database
  const foundIds = new Set(approvals.map((a: Approval) => a.id as string));
  for (const id of ids) {
    if (!foundIds.has(id)) {
      skipped.push(`${id} (not found)`);
    }
  }

  return json({ processed: pending.length, skipped });
}
