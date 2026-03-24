import { getOptimalModel, recordModelOutcome, type Agent, type ModelConfig } from "./dynamic-routing";
import { hasRoutingTables } from "./migrate-routing";

/**
 * Enhanced agent dispatch that uses dynamic routing for model selection
 * This replaces the hardcoded model mapping in the original dispatch system
 */

export interface EnhancedAgentContext {
  company_id?: string;
  company_slug?: string;
  action_type?: string;
  company_type?: string;
  recent_failures?: number;
  trigger?: string;
}

/**
 * Get optimal model for an agent with fallback to static mapping
 */
export async function getEnhancedModel(
  agent: Agent,
  context: EnhancedAgentContext = {}
): Promise<{ modelConfig: ModelConfig; routingReason: string }> {
  try {
    // Check if dynamic routing is available
    const hasDynamicRouting = await hasRoutingTables();

    if (!hasDynamicRouting) {
      // Fall back to static routing
      const staticModel = getStaticModel(agent);
      return {
        modelConfig: staticModel,
        routingReason: "static_fallback (no_routing_tables)"
      };
    }

    // Use dynamic routing
    const modelConfig = await getOptimalModel(agent, context);

    return {
      modelConfig,
      routingReason: "dynamic_routing"
    };

  } catch (error) {
    console.warn(`Dynamic routing failed for ${agent}, falling back to static:`, error);
    const staticModel = getStaticModel(agent);
    return {
      modelConfig: staticModel,
      routingReason: `static_fallback (${error.message})`
    };
  }
}

/**
 * Record the outcome of an agent execution for learning
 */
export async function recordEnhancedOutcome(
  agent: Agent,
  modelConfig: ModelConfig,
  success: boolean,
  duration_s: number,
  context: EnhancedAgentContext = {},
  error?: string
): Promise<void> {
  try {
    const hasDynamicRouting = await hasRoutingTables();
    if (!hasDynamicRouting) return; // Skip if not set up

    await recordModelOutcome(agent, modelConfig, success, duration_s, {
      ...context,
      ...(error && { error: error.slice(0, 200) })
    });

  } catch (err) {
    console.warn(`Failed to record outcome for ${agent}:`, err);
    // Non-critical - don't throw
  }
}

/**
 * Static model mapping (fallback when dynamic routing unavailable)
 */
function getStaticModel(agent: Agent): ModelConfig {
  const staticMapping: Record<Agent, ModelConfig> = {
    ceo: { provider: "claude", model: "opus", max_turns: 25 },
    scout: { provider: "claude", model: "opus", max_turns: 35 },
    engineer: { provider: "claude", model: "sonnet", max_turns: 35 },
    evolver: { provider: "claude", model: "opus", max_turns: 25 },
    growth: { provider: "gemini", model: "flash", max_turns: 25, free_tier_limit: 1000 },
    outreach: { provider: "gemini", model: "flash", free_tier_limit: 1000 },
    ops: { provider: "groq", model: "llama-3.3-70b", free_tier_limit: 6000 },
    healer: { provider: "claude", model: "sonnet", max_turns: 20 },
  };

  return staticMapping[agent];
}

/**
 * Enhanced wrapper for existing getOptimalModel function in dispatch
 * This provides a drop-in replacement for the existing logic
 */
export async function getOptimalModelForWorker(
  sql: any,
  agent: "growth" | "outreach" | "ops",
  context: EnhancedAgentContext = {}
): Promise<{ provider: "gemini" | "groq"; model: string; routing_reason: string }> {
  try {
    const { modelConfig, routingReason } = await getEnhancedModel(agent, context);

    // Convert to format expected by existing dispatch code
    return {
      provider: modelConfig.provider as "gemini" | "groq",
      model: modelConfig.model === "flash" ? "gemini-2.5-flash" :
             modelConfig.model === "flash-lite" ? "gemini-2.5-flash-lite" :
             modelConfig.model === "llama-3.3-70b" ? "llama-3.3-70b-versatile" :
             modelConfig.model,
      routing_reason: routingReason
    };

  } catch (error) {
    // Original fallback logic
    const defaultMapping = {
      growth: { provider: "gemini" as const, model: "gemini-2.5-flash" },
      outreach: { provider: "gemini" as const, model: "gemini-2.5-flash" },
      ops: { provider: "groq" as const, model: "llama-3.3-70b-versatile" },
    };

    return {
      ...defaultMapping[agent],
      routing_reason: `enhanced_fallback (${error.message})`
    };
  }
}

/**
 * Enhanced outcome recording for existing dispatch system
 */
export async function recordWorkerOutcome(
  agent: "growth" | "outreach" | "ops",
  provider: string,
  model: string,
  success: boolean,
  duration_s: number,
  context: EnhancedAgentContext = {}
): Promise<void> {
  // Convert back to ModelConfig format
  const modelConfig: ModelConfig = {
    provider: provider as any,
    model: model.replace("gemini-2.5-", "").replace("llama-3.3-70b-versatile", "llama-3.3-70b") as any,
  };

  await recordEnhancedOutcome(agent, modelConfig, success, duration_s, context);
}