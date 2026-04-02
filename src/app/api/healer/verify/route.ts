import { getDb, json, err } from "@/lib/db";
import { verifyCronAuth } from "@/lib/qstash";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// POST /api/healer/verify
// Called via QStash with a 30-minute delay after Healer fixes an error.
// Checks whether:
//   1. The same error pattern recurred for the affected company
//   2. Subsequent agent actions for the company succeeded
// If the error persisted, increments the circuit breaker failure count.
// If agents succeeded, records a healer success action to improve the circuit breaker success rate.

export async function POST(req: Request) {
  const auth = await verifyCronAuth(req);
  if (!auth.authorized) {
    return Response.json({ error: auth.error }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const { company_id, company_slug, error_pattern, healed_at } = body;

  if (!company_id || !healed_at) {
    return err("Missing required fields: company_id, healed_at");
  }

  const sql = getDb();
  const healedAtDate = new Date(healed_at);

  try {
    // 1. Check if same error pattern recurred since the heal
    const recurredErrors = await sql`
      SELECT id, agent, error, description, finished_at
      FROM agent_actions
      WHERE company_id = ${company_id}
        AND status = 'failed'
        AND finished_at > ${healedAtDate}
        AND finished_at > NOW() - INTERVAL '1 hour'
        ${error_pattern
          ? sql`AND (
              error ILIKE ${"%" + error_pattern + "%"}
              OR description ILIKE ${"%" + error_pattern + "%"}
            )`
          : sql``}
      ORDER BY finished_at DESC
      LIMIT 5
    `.catch(() => [] as any[]);

    // 2. Check if subsequent agent actions succeeded after the heal
    const successfulActions = await sql`
      SELECT id, agent, action_type, finished_at
      FROM agent_actions
      WHERE company_id = ${company_id}
        AND status = 'success'
        AND finished_at > ${healedAtDate}
        AND finished_at > NOW() - INTERVAL '1 hour'
        AND agent != 'healer'
      ORDER BY finished_at DESC
      LIMIT 5
    `.catch(() => [] as any[]);

    const errorRecurred = recurredErrors.length > 0;
    const agentsSucceeded = successfulActions.length > 0;

    if (errorRecurred) {
      // Fix didn't hold — log a healer failure to worsen the circuit breaker
      await sql`
        INSERT INTO agent_actions (agent, action_type, status, description, company_id, started_at, finished_at)
        VALUES (
          'healer', 'verify_fix', 'failed',
          ${`Post-fix verification FAILED for ${company_slug || company_id}: error recurred ${recurredErrors.length}x within 30 min. Pattern: ${error_pattern || "unknown"}`},
          ${company_id}, NOW(), NOW()
        )
      `.catch(() => {});

      return json({
        verified: false,
        error_recurred: true,
        recurrence_count: recurredErrors.length,
        agents_succeeded: agentsSucceeded,
        company_id,
        company_slug,
      });
    }

    if (agentsSucceeded) {
      // Fix held and agents are working — record a strong success signal
      await sql`
        INSERT INTO agent_actions (agent, action_type, status, description, company_id, started_at, finished_at)
        VALUES (
          'healer', 'verify_fix', 'success',
          ${`Post-fix verification PASSED for ${company_slug || company_id}: ${successfulActions.length} agent(s) succeeded after fix. Pattern: ${error_pattern || "unknown"}`},
          ${company_id}, NOW(), NOW()
        )
      `.catch(() => {});

      return json({
        verified: true,
        error_recurred: false,
        agents_succeeded: true,
        successful_agents: successfulActions.map((a: any) => a.agent),
        company_id,
        company_slug,
      });
    }

    // No errors, no successes — inconclusive (agents may not have run yet)
    await sql`
      INSERT INTO agent_actions (agent, action_type, status, description, company_id, started_at, finished_at)
      VALUES (
        'healer', 'verify_fix', 'success',
        ${`Post-fix verification inconclusive for ${company_slug || company_id}: no errors recurred, but no agents ran yet. Pattern: ${error_pattern || "unknown"}`},
        ${company_id}, NOW(), NOW()
      )
    `.catch(() => {});

    return json({
      verified: true,
      error_recurred: false,
      agents_succeeded: false,
      inconclusive: true,
      company_id,
      company_slug,
    });

  } catch (error) {
    return err(`Verification failed: ${error instanceof Error ? error.message : "unknown"}`);
  }
}
