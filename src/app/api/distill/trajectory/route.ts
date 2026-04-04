import { getDb, json, err } from "@/lib/db";
import { generatePlaybookEmbedding } from "@/lib/embeddings";
import { generateText } from "@/lib/llm";
import { invalidatePlaybook } from "@/lib/redis-cache";

// POST /api/distill/trajectory
// Body: { cycle_id: string, action_ids: string[] }
// Auth: CRON_SECRET
//
// Distillation pipeline (Ruflo compounding loop):
//   1. Fetch cycle actions with quality_score >= 0.7 (high-quality executions)
//   2. Prompt Haiku: "In ≤3 sentences, what pattern made this succeed?"
//   3. Write to playbook (evolution_type='captured', source='auto_distill', confidence=0.4)
//   4. Generate embedding on every new entry before writing
//
// Called from CEO review endpoint after quality scoring completes.
// Guaranteed delivery via QStash — errors are retried automatically.
export async function POST(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    // Also accept QStash signature (handled by middleware if configured)
    return err("Unauthorized", 401);
  }

  let body: { cycle_id?: string; action_ids?: string[] };
  try {
    body = await req.json();
  } catch {
    return err("Invalid JSON body", 400);
  }

  const { cycle_id, action_ids } = body;
  if (!cycle_id || !Array.isArray(action_ids) || action_ids.length === 0) {
    return err("cycle_id and action_ids[] are required", 400);
  }

  const sql = getDb();

  // Fetch qualifying actions — must have quality_score >= 0.7 and meaningful description
  const actions = await sql`
    SELECT id, agent, action_type, description, output, quality_score, retry_count
    FROM agent_actions
    WHERE id = ANY(${action_ids})
      AND quality_score >= 0.7
      AND status = 'success'
      AND description IS NOT NULL
      AND agent NOT IN ('dispatch', 'backlog_dispatch', 'webhook', 'system', 'admin', 'sentinel')
  ` as Array<{
    id: string;
    agent: string;
    action_type: string;
    description: string;
    output: Record<string, unknown> | null;
    quality_score: number;
    retry_count: number;
  }>;

  if (actions.length === 0) {
    return json({ ok: true, distilled: 0, reason: "no_qualifying_actions" });
  }

  // Determine domain from agent type
  function agentToDomain(agent: string): string {
    switch (agent) {
      case 'engineer': return 'engineering';
      case 'growth': return 'growth';
      case 'ops': return 'operations';
      case 'scout': return 'strategy';
      case 'ceo': return 'strategy';
      default: return 'engineering';
    }
  }

  let distilledCount = 0;
  const errors: string[] = [];

  for (const action of actions) {
    try {
      const domain = agentToDomain(action.agent);

      // Build context for pattern extraction
      const outputSummary = action.output
        ? Object.entries(action.output)
            .filter(([k]) => ['summary', 'result', 'deployed_url', 'pr_url', 'commit_sha'].includes(k))
            .map(([k, v]) => `${k}: ${String(v).slice(0, 200)}`)
            .join(', ')
        : '';

      const prompt = `You are extracting a reusable engineering/growth pattern from a successful agent action.

Agent: ${action.agent}
Action type: ${action.action_type}
Quality score: ${action.quality_score}
Description: ${action.description.slice(0, 500)}
${outputSummary ? `Output signals: ${outputSummary}` : ''}

In exactly 1-3 sentences, state the reusable pattern that made this succeed. Focus on the "what worked" — not the specific task, but the generalizable principle. Be concrete. Start directly with the pattern.`;

      const insight = await generateText('ops', prompt, { maxTokens: 200 });
      if (!insight?.trim() || insight.trim().length < 10) continue;

      // Generate embedding before writing (required for vector search in Phase 4)
      const evidence: Record<string, unknown> = {
        cycle_id,
        action_id: action.id,
        agent: action.agent,
        action_type: action.action_type,
        quality_score: action.quality_score,
      };
      const embedding = await generatePlaybookEmbedding(insight.trim(), domain, evidence);
      const embeddingVector = `[${embedding.join(",")}]`;

      await sql`
        INSERT INTO playbook (
          domain, insight, evidence, confidence,
          evolution_type, source,
          relevant_agents, embedding
        )
        VALUES (
          ${domain},
          ${insight.trim().slice(0, 500)},
          ${JSON.stringify(evidence)}::jsonb,
          0.4,
          'captured',
          'auto_distill',
          ${[action.agent]},
          ${embeddingVector}::vector
        )
      `;

      distilledCount++;
      console.log(`[distill] captured pattern for ${action.agent}:${action.action_type} (score=${action.quality_score})`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${action.id}: ${msg.slice(0, 100)}`);
      console.error(`[distill] failed for action ${action.id}:`, msg);
    }
  }

  // Invalidate playbook cache so next context call sees new entries
  if (distilledCount > 0) {
    await invalidatePlaybook().catch(() => {});
  }

  console.log(`[distill] cycle ${cycle_id}: ${distilledCount}/${actions.length} patterns captured`);

  return json({
    ok: true,
    cycle_id,
    distilled: distilledCount,
    evaluated: actions.length,
    ...(errors.length > 0 ? { errors } : {}),
  });
}
