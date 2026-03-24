import { getDb } from "./db";

// Dynamic model routing with Q-Learning style adaptation
// Tracks success rates by agent-model combination and learns optimal routing

export type Provider = "claude" | "gemini" | "groq";
export type Model = "opus" | "sonnet" | "haiku" | "flash" | "flash-lite" | "llama-3.3-70b";
export type Agent = "ceo" | "scout" | "engineer" | "ops" | "growth" | "outreach" | "evolver" | "healer";

interface ModelConfig {
  provider: Provider;
  model: Model;
  max_turns?: number;
  timeout_ms?: number;
  cost_per_token?: number;
  free_tier_limit?: number;
}

interface RoutingChoice {
  agent: Agent;
  model_config: ModelConfig;
  q_value: number;
  confidence: number;
  last_updated: Date;
  sample_size: number;
}

// Static fallback mapping from CLAUDE.md
const STATIC_ROUTING: Record<Agent, ModelConfig> = {
  ceo: { provider: "claude", model: "opus", max_turns: 25 },
  scout: { provider: "claude", model: "opus", max_turns: 35 },
  engineer: { provider: "claude", model: "sonnet", max_turns: 35 },
  evolver: { provider: "claude", model: "opus", max_turns: 25 },
  growth: { provider: "gemini", model: "flash", max_turns: 25, free_tier_limit: 1000 },
  outreach: { provider: "gemini", model: "flash", free_tier_limit: 1000 },
  ops: { provider: "groq", model: "llama-3.3-70b", free_tier_limit: 6000 },
  healer: { provider: "claude", model: "sonnet", max_turns: 20 },
};

// Available models for each agent (exploration space)
const EXPLORATION_MODELS: Record<Agent, ModelConfig[]> = {
  ceo: [
    { provider: "claude", model: "opus", max_turns: 25 },
    { provider: "claude", model: "sonnet", max_turns: 25 },
  ],
  scout: [
    { provider: "claude", model: "opus", max_turns: 35 },
    { provider: "claude", model: "sonnet", max_turns: 35 },
  ],
  engineer: [
    { provider: "claude", model: "sonnet", max_turns: 35 },
    { provider: "claude", model: "opus", max_turns: 35 },
  ],
  evolver: [
    { provider: "claude", model: "opus", max_turns: 25 },
    { provider: "claude", model: "sonnet", max_turns: 25 },
  ],
  growth: [
    { provider: "gemini", model: "flash", max_turns: 25 },
    { provider: "gemini", model: "flash-lite", max_turns: 25 },
    { provider: "claude", model: "haiku", max_turns: 25 },
  ],
  outreach: [
    { provider: "gemini", model: "flash" },
    { provider: "gemini", model: "flash-lite" },
    { provider: "groq", model: "llama-3.3-70b" },
  ],
  ops: [
    { provider: "groq", model: "llama-3.3-70b" },
    { provider: "gemini", model: "flash" },
  ],
  healer: [
    { provider: "claude", model: "sonnet", max_turns: 20 },
    { provider: "claude", model: "opus", max_turns: 20 },
  ],
};

interface ContextFactors {
  company_type?: string;
  action_type?: string;
  recent_failures?: number;
  complexity_score?: number;
}

/**
 * Get the optimal model for an agent based on Q-Learning routing table
 * Falls back to static routing if no data or during initial exploration
 */
export async function getOptimalModel(
  agent: Agent,
  context: ContextFactors = {}
): Promise<ModelConfig> {
  try {
    const sql = getDb();

    // Get routing data for this agent
    const routes = await sql`
      SELECT
        model_config,
        q_value,
        confidence,
        sample_size,
        last_updated,
        success_count,
        failure_count
      FROM model_routing
      WHERE agent = ${agent}
        AND is_active = true
      ORDER BY q_value DESC
    `;

    if (routes.length === 0) {
      // No data yet - use static routing
      return STATIC_ROUTING[agent];
    }

    // Epsilon-greedy strategy: exploration vs exploitation
    const epsilon = getExplorationRate(agent, routes[0].sample_size);
    const shouldExplore = Math.random() < epsilon;

    if (shouldExplore) {
      // Explore: try a model with insufficient data
      const explorationModels = EXPLORATION_MODELS[agent];
      const undersampled = explorationModels.filter(model => {
        const existing = routes.find(r =>
          JSON.stringify(r.model_config) === JSON.stringify(model)
        );
        return !existing || existing.sample_size < 10;
      });

      if (undersampled.length > 0) {
        const randomModel = undersampled[Math.floor(Math.random() * undersampled.length)];
        await recordModelChoice(agent, randomModel, context);
        return randomModel;
      }
    }

    // Exploit: use best performing model
    const bestRoute = routes[0];
    const modelConfig = bestRoute.model_config as ModelConfig;

    // Apply context-based adjustments
    if (context.recent_failures && context.recent_failures >= 2) {
      // Switch to more powerful model after repeated failures
      const fallbackModel = getFallbackModel(agent, modelConfig);
      await recordModelChoice(agent, fallbackModel, context);
      return fallbackModel;
    }

    await recordModelChoice(agent, modelConfig, context);
    return modelConfig;

  } catch (error) {
    console.error(`Dynamic routing failed for ${agent}:`, error);
    return STATIC_ROUTING[agent];
  }
}

/**
 * Record the success or failure of a model choice for Q-Learning updates
 */
export async function recordModelOutcome(
  agent: Agent,
  modelConfig: ModelConfig,
  success: boolean,
  duration_s?: number,
  context: ContextFactors = {}
): Promise<void> {
  try {
    const sql = getDb();

    // Update or insert routing record
    await sql`
      INSERT INTO model_routing (
        agent,
        model_config,
        success_count,
        failure_count,
        total_duration_s,
        sample_size,
        q_value,
        confidence,
        last_updated,
        context_factors
      )
      VALUES (
        ${agent},
        ${JSON.stringify(modelConfig)},
        ${success ? 1 : 0},
        ${success ? 0 : 1},
        ${duration_s || 0},
        1,
        ${success ? 1.0 : 0.0},
        0.1,
        NOW(),
        ${JSON.stringify(context)}
      )
      ON CONFLICT (agent, model_config_hash)
      DO UPDATE SET
        success_count = model_routing.success_count + ${success ? 1 : 0},
        failure_count = model_routing.failure_count + ${success ? 0 : 1},
        total_duration_s = model_routing.total_duration_s + ${duration_s || 0},
        sample_size = model_routing.sample_size + 1,
        q_value = calculate_q_value(
          model_routing.success_count + ${success ? 1 : 0},
          model_routing.sample_size + 1,
          model_routing.total_duration_s + ${duration_s || 0}
        ),
        confidence = LEAST(1.0, (model_routing.sample_size + 1) / 50.0),
        last_updated = NOW(),
        context_factors = ${JSON.stringify(context)}
    `;

  } catch (error) {
    console.error(`Failed to record model outcome for ${agent}:`, error);
  }
}

/**
 * Get exploration rate (epsilon) based on agent and sample size
 * Higher exploration for agents with less data
 */
function getExplorationRate(agent: Agent, sampleSize: number): number {
  // Critical agents (CEO, Scout) explore less to avoid poor decisions
  const baseEpsilon = ["ceo", "scout"].includes(agent) ? 0.05 : 0.15;

  // Decay exploration as sample size grows
  const decayFactor = Math.max(0.01, 1 - (sampleSize / 100));

  return baseEpsilon * decayFactor;
}

/**
 * Get fallback model for an agent after failures
 */
function getFallbackModel(agent: Agent, currentModel: ModelConfig): ModelConfig {
  // Fallback to most powerful/reliable model for each agent
  switch (agent) {
    case "ceo":
    case "scout":
    case "evolver":
      return { provider: "claude", model: "opus", max_turns: currentModel.max_turns };
    case "engineer":
    case "healer":
      return { provider: "claude", model: "sonnet", max_turns: currentModel.max_turns };
    default:
      return STATIC_ROUTING[agent];
  }
}

/**
 * Record that a model was chosen (for tracking exploration)
 */
async function recordModelChoice(
  agent: Agent,
  modelConfig: ModelConfig,
  context: ContextFactors
): Promise<void> {
  try {
    const sql = getDb();

    await sql`
      INSERT INTO model_choices (
        agent,
        model_config,
        context_factors,
        chosen_at
      )
      VALUES (
        ${agent},
        ${JSON.stringify(modelConfig)},
        ${JSON.stringify(context)},
        NOW()
      )
    `;
  } catch (error) {
    // Non-critical - just log
    console.warn(`Failed to record model choice for ${agent}:`, error);
  }
}

/**
 * Get routing statistics for analysis
 */
export async function getRoutingStats(): Promise<{
  by_agent: Record<string, any>;
  recommendations: string[];
}> {
  try {
    const sql = getDb();

    const stats = await sql`
      SELECT
        agent,
        model_config,
        success_count,
        failure_count,
        sample_size,
        q_value,
        confidence,
        ROUND(avg_duration_s, 1) as avg_duration_s
      FROM model_routing
      WHERE is_active = true
        AND sample_size >= 3
      ORDER BY agent, q_value DESC
    `;

    const byAgent: Record<string, any> = {};
    const recommendations: string[] = [];

    for (const row of stats) {
      const agent = row.agent as string;
      if (!byAgent[agent]) byAgent[agent] = [];

      const successRate = row.success_count / (row.success_count + row.failure_count);

      byAgent[agent].push({
        model: row.model_config,
        success_rate: Math.round(successRate * 100) / 100,
        sample_size: row.sample_size,
        q_value: Math.round(row.q_value * 100) / 100,
        confidence: Math.round(row.confidence * 100) / 100,
        avg_duration_s: row.avg_duration_s,
      });

      // Generate recommendations
      if (successRate < 0.3 && row.sample_size >= 10) {
        recommendations.push(
          `${agent} has ${Math.round(successRate * 100)}% success rate with ${JSON.stringify(row.model_config)} - consider different model`
        );
      }
    }

    return { by_agent: byAgent, recommendations };
  } catch (error) {
    console.error("Failed to get routing stats:", error);
    return { by_agent: {}, recommendations: [] };
  }
}

/**
 * Reset routing data for an agent (for debugging/retuning)
 */
export async function resetAgentRouting(agent: Agent): Promise<void> {
  const sql = getDb();

  await sql`
    UPDATE model_routing
    SET is_active = false,
        deactivated_at = NOW()
    WHERE agent = ${agent}
  `;
}