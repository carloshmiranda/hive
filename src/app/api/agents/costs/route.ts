import { getDb, json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

// Cost per turn by model (USD)
const COST_PER_TURN: Record<string, number> = {
  opus: 0.15,
  sonnet: 0.03,
  "gemini-flash": 0,
  "gemini-flash-lite": 0,
  groq: 0,
};

// Default model per agent (from CLAUDE.md model routing table)
const DEFAULT_MODEL: Record<string, string> = {
  ceo: "opus",
  scout: "opus",
  engineer: "sonnet",
  evolver: "opus",
  growth: "gemini-flash",
  outreach: "gemini-flash",
  ops: "groq",
};

function costPerTurn(model: string | null | undefined, agent: string): number {
  if (model) {
    const m = model.toLowerCase();
    // Match known model names loosely
    if (m.includes("opus")) return COST_PER_TURN.opus;
    if (m.includes("sonnet")) return COST_PER_TURN.sonnet;
    if (m.includes("gemini") || m.includes("flash")) return COST_PER_TURN["gemini-flash"];
    if (m.includes("groq") || m.includes("llama")) return COST_PER_TURN.groq;
  }
  // Fall back to default model for agent
  const defaultModel = DEFAULT_MODEL[agent] || "sonnet";
  return COST_PER_TURN[defaultModel] ?? 0.03;
}

// GET /api/agents/costs — cost tracking summary
export async function GET() {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const sql = getDb();

  // Query agent actions from last 7 days with turns, model, and cost info
  const rows = await sql`
    SELECT
      agent,
      status,
      tokens_used,
      input,
      output,
      started_at
    FROM agent_actions
    WHERE started_at >= NOW() - INTERVAL '7 days'
      AND status IN ('success', 'failed', 'running')
  `;

  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const fiveHoursAgo = new Date(now.getTime() - 5 * 60 * 60 * 1000);

  let dailyCost = 0;
  let weeklyCost = 0;
  let turns24h = 0;
  let turns5h = 0;

  const byAgent: Record<string, { turns: number; est_cost: number; providers: Record<string, number> }> = {};
  const byProvider: Record<string, { calls: number; successes: number; failures: number; est_cost: number }> = {};

  for (const row of rows) {
    const agent = row.agent as string;
    const meta = row.input as Record<string, unknown> | null;
    const outputMeta = row.output as Record<string, unknown> | null;

    // Prefer actual cost from output (worker agents), fall back to turn-based estimate
    const actualCost = (outputMeta?.cost_usd as number) || null;
    const model = (outputMeta?.model as string) || (meta?.model as string) || null;
    const provider = (outputMeta?.provider as string) || null;
    const turnsUsed = (meta?.turns_used as number) || 1;
    const startedAt = new Date(row.started_at as string);

    const turnCost = actualCost ?? turnsUsed * costPerTurn(model, agent);

    // Accumulate weekly
    weeklyCost += turnCost;

    // Accumulate daily
    if (startedAt >= oneDayAgo) {
      dailyCost += turnCost;
      turns24h += turnsUsed;
    }

    // Accumulate 5h window
    if (startedAt >= fiveHoursAgo) {
      turns5h += turnsUsed;
    }

    // By agent (with provider breakdown)
    if (!byAgent[agent]) {
      byAgent[agent] = { turns: 0, est_cost: 0, providers: {} };
    }
    byAgent[agent].turns += turnsUsed;
    byAgent[agent].est_cost += turnCost;
    if (provider) {
      byAgent[agent].providers[provider] = (byAgent[agent].providers[provider] || 0) + 1;
    }

    // By provider (for routing insights)
    if (provider) {
      if (!byProvider[provider]) {
        byProvider[provider] = { calls: 0, successes: 0, failures: 0, est_cost: 0 };
      }
      byProvider[provider].calls++;
      byProvider[provider].est_cost += turnCost;
      if (row.status === "success") byProvider[provider].successes++;
      if (row.status === "failed") byProvider[provider].failures++;
    }
  }

  // Round costs to 2 decimal places
  dailyCost = Math.round(dailyCost * 100) / 100;
  weeklyCost = Math.round(weeklyCost * 100) / 100;
  for (const agent of Object.keys(byAgent)) {
    byAgent[agent].est_cost = Math.round(byAgent[agent].est_cost * 100) / 100;
  }
  for (const p of Object.keys(byProvider)) {
    byProvider[p].est_cost = Math.round(byProvider[p].est_cost * 100) / 100;
  }

  const budgetUtilizationPct = Math.round((turns5h / 225) * 100 * 10) / 10;

  return json({
    daily_cost: dailyCost,
    weekly_cost: weeklyCost,
    turns_24h: turns24h,
    turns_5h: turns5h,
    budget_utilization_pct: budgetUtilizationPct,
    by_agent: byAgent,
    by_provider: byProvider,
  });
}
