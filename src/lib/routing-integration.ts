import { getOptimalModel, recordModelOutcome, type Agent, type ModelConfig } from "./dynamic-routing";

/**
 * Integration helpers for dynamic routing with existing agent workflows
 */

interface AgentExecutionContext {
  company_id?: string;
  action_type?: string;
  company_type?: string;
  recent_failures?: number;
  complexity_score?: number;
}

interface AgentExecutionResult {
  success: boolean;
  duration_s?: number;
  error?: string;
  tokens_used?: number;
}

/**
 * Get the optimal model for an agent execution with enhanced context
 */
export async function getModelForExecution(
  agent: Agent,
  actionType: string,
  context: AgentExecutionContext = {}
): Promise<ModelConfig> {
  const enhancedContext = {
    ...context,
    action_type: actionType,
  };

  return await getOptimalModel(agent, enhancedContext);
}

/**
 * Record the outcome of an agent execution for Q-Learning updates
 */
export async function recordExecutionOutcome(
  agent: Agent,
  modelConfig: ModelConfig,
  result: AgentExecutionResult,
  context: AgentExecutionContext = {}
): Promise<void> {
  await recordModelOutcome(
    agent,
    modelConfig,
    result.success,
    result.duration_s,
    context
  );
}

/**
 * Enhanced agent execution wrapper that integrates dynamic routing
 * This function should wrap existing agent dispatch calls
 */
export async function executeWithDynamicRouting<T>(
  agent: Agent,
  actionType: string,
  executionFn: (modelConfig: ModelConfig) => Promise<T>,
  context: AgentExecutionContext = {}
): Promise<T> {
  const startTime = Date.now();
  let modelConfig: ModelConfig;
  let result: T;
  let error: Error | null = null;

  try {
    // Get optimal model for this execution
    modelConfig = await getModelForExecution(agent, actionType, context);

    // Execute with the selected model
    result = await executionFn(modelConfig);

    // Record successful outcome
    const duration_s = Math.round((Date.now() - startTime) / 1000);
    await recordExecutionOutcome(
      agent,
      modelConfig,
      { success: true, duration_s },
      context
    );

    return result;

  } catch (err) {
    error = err as Error;

    // Record failed outcome
    const duration_s = Math.round((Date.now() - startTime) / 1000);
    await recordExecutionOutcome(
      agent,
      modelConfig!,
      { success: false, duration_s, error: error.message },
      context
    );

    throw error;
  }
}

/**
 * Get context factors from agent_actions history for enhanced routing
 */
export async function getExecutionContext(
  agent: Agent,
  companyId?: string,
  actionType?: string
): Promise<AgentExecutionContext> {
  try {
    const { getDb } = await import("./db");
    const sql = getDb();

    // Get recent failure count for this agent
    const recentActions = await sql`
      SELECT status, action_type
      FROM agent_actions
      WHERE agent = ${agent}
        ${companyId ? sql`AND company_id = ${companyId}` : sql``}
        AND started_at > NOW() - INTERVAL '7 days'
      ORDER BY started_at DESC
      LIMIT 10
    `;

    const recentFailures = recentActions.filter(
      (action: any) => action.status === "failed"
    ).length;

    // Calculate complexity score based on action type
    const complexityScore = getActionComplexity(actionType || "");

    return {
      company_id: companyId,
      action_type: actionType,
      recent_failures: recentFailures,
      complexity_score: complexityScore,
    };

  } catch (error) {
    console.warn("Failed to get execution context:", error);
    return {
      company_id: companyId,
      action_type: actionType,
      recent_failures: 0,
      complexity_score: 0.5,
    };
  }
}

/**
 * Calculate complexity score for an action type (0-1 scale)
 */
function getActionComplexity(actionType: string): number {
  const complexityMap: Record<string, number> = {
    // High complexity (strategic/creative tasks)
    "cycle_plan": 0.9,
    "idea_generation": 0.9,
    "competitive_analysis": 0.8,
    "prompt_evolution": 0.9,

    // Medium complexity (execution tasks)
    "execute_task": 0.7,
    "code_generation": 0.6,
    "content_creation": 0.6,
    "email_personalization": 0.5,

    // Low complexity (operational tasks)
    "health_check": 0.3,
    "metrics_collection": 0.3,
    "status_update": 0.2,
  };

  return complexityMap[actionType] || 0.5;
}

/**
 * Batch update routing outcomes from agent_actions table
 * Useful for bootstrapping the routing system from existing data
 */
export async function backfillRoutingData(daysBack = 30): Promise<void> {
  try {
    const { getDb } = await import("./db");
    const sql = getDb();

    // Get completed actions from the last N days
    const actions = await sql`
      SELECT
        agent,
        action_type,
        status,
        company_id,
        EXTRACT(EPOCH FROM (finished_at - started_at))::int as duration_s,
        started_at
      FROM agent_actions
      WHERE status IN ('success', 'failed')
        AND finished_at > NOW() - INTERVAL '${daysBack} days'
      ORDER BY finished_at ASC
    `;

    console.log(`Backfilling routing data from ${actions.length} agent actions...`);

    for (const action of actions) {
      // Get model config from static routing (since we don't have historical data)
      const agent = action.agent as Agent;
      const staticModel = await getOptimalModel(agent); // Falls back to static

      const context: AgentExecutionContext = {
        company_id: action.company_id,
        action_type: action.action_type,
      };

      await recordModelOutcome(
        agent,
        staticModel,
        action.status === "success",
        action.duration_s || 0,
        context
      );
    }

    console.log("Routing data backfill completed successfully");

  } catch (error) {
    console.error("Failed to backfill routing data:", error);
    throw error;
  }
}