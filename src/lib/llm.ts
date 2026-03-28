import { getSettingValue } from "./settings";
import { openrouter } from "@openrouter/ai-sdk-provider";
import { generateObject, generateText as aiGenerateText } from "ai";

// Unified LLM calling interface for worker agents
// All calls route through OpenRouter with per-model fallback chains.
// Claude Max (GitHub Actions CLI) is NOT in this chain — it's not API-based.
//
// Dynamic model discovery: fetches OpenRouter's free model catalog and pads
// agent chains with all available free models. Curated primaries go first
// (quality), dynamic pool fills the rest (resilience during outages).

// ---------------------------------------------------------------------------
// Circuit Breaker — per-model health tracking with EMA error rate
// ---------------------------------------------------------------------------

export interface ProviderHealth {
  errorRate: number;       // EMA of error rate (0-1), alpha=0.3
  lastError: number;       // timestamp of last error
  lastSuccess: number;     // timestamp of last success
  state: "closed" | "half_open" | "open";
  openedAt: number;        // when circuit opened
  requestCount: number;    // total requests tracked
}

const EMA_ALPHA = 0.3;
const ERROR_RATE_THRESHOLD = 0.5;   // 50% failure rate trips the breaker
const COOLDOWN_MS = 60_000;         // 60s before allowing a test request
const MIN_REQUESTS = 3;             // need at least 3 data points before tripping

const healthMap = new Map<string, ProviderHealth>();

function getOrCreateHealth(key: string): ProviderHealth {
  let h = healthMap.get(key);
  if (!h) {
    h = {
      errorRate: 0,
      lastError: 0,
      lastSuccess: 0,
      state: "closed",
      openedAt: 0,
      requestCount: 0,
    };
    healthMap.set(key, h);
  }
  return h;
}

/** Update EMA after a successful call. May transition half_open → closed. */
export function recordProviderSuccess(key: string): void {
  const h = getOrCreateHealth(key);
  h.requestCount++;
  h.lastSuccess = Date.now();
  h.errorRate = h.errorRate * (1 - EMA_ALPHA); // EMA towards 0

  if (h.state === "half_open") {
    h.state = "closed";
    console.warn(`[circuit-breaker] ${key}: HALF_OPEN → CLOSED (test request succeeded)`);
  }
}

/** Update EMA after a failed call. May transition closed → open or half_open → open. */
export function recordProviderFailure(key: string): void {
  const h = getOrCreateHealth(key);
  h.requestCount++;
  h.lastError = Date.now();
  h.errorRate = h.errorRate * (1 - EMA_ALPHA) + EMA_ALPHA; // EMA towards 1

  if (h.state === "half_open") {
    h.state = "open";
    h.openedAt = Date.now();
    console.warn(`[circuit-breaker] ${key}: HALF_OPEN → OPEN (test request failed, cooldown reset)`);
    return;
  }

  if (h.state === "closed" && h.requestCount >= MIN_REQUESTS && h.errorRate > ERROR_RATE_THRESHOLD) {
    h.state = "open";
    h.openedAt = Date.now();
    console.warn(`[circuit-breaker] ${key}: CLOSED → OPEN (error rate ${(h.errorRate * 100).toFixed(1)}% > ${ERROR_RATE_THRESHOLD * 100}%)`);
  }
}

/** Check whether a model should receive traffic. Handles open → half_open transition. */
export function isProviderAvailable(key: string): boolean {
  const h = healthMap.get(key);
  if (!h) return true; // no data = healthy

  if (h.state === "closed") return true;

  if (h.state === "open") {
    const elapsed = Date.now() - h.openedAt;
    if (elapsed >= COOLDOWN_MS) {
      h.state = "half_open";
      console.warn(`[circuit-breaker] ${key}: OPEN → HALF_OPEN (cooldown elapsed, allowing test request)`);
      return true;
    }
    return false;
  }

  // half_open — allow the single test request
  return true;
}

/** Return a snapshot of all tracked model health (for monitoring / API exposure). */
export function getProviderHealth(): Record<string, ProviderHealth> {
  const out: Record<string, ProviderHealth> = {};
  healthMap.forEach((v, k) => {
    out[k] = { ...v };
  });
  return out;
}

export interface LLMOptions {
  maxTokens?: number;
  temperature?: number;
  maxRetries?: number;
  timeout?: number;
  verbosity?: "low" | "medium" | "high" | "max";
  responseFormat?: {
    type: "json_schema";
    json_schema: {
      name: string;
      strict: true;
      schema: any;
    };
  };
}

export interface LLMResponse {
  content: string;
  provider: string;
  model: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cost_usd?: number;
  };
  routing_reason: string;
}

// Curated primary models — quality picks that go first in the chain.
// Dynamic discovery pads the rest with all available free models.
export const OPENROUTER_MODELS = {
  // Tier 1: Large models (best quality)
  hermes_405b: "nousresearch/hermes-3-llama-3.1-405b:free",
  llama_70b: "meta-llama/llama-3.3-70b-instruct:free",
  qwen_coder: "qwen/qwen3-coder:free",

  // Tier 2: Medium models (good balance)
  gemma_27b: "google/gemma-3-27b-it:free",
  mistral_24b: "mistralai/mistral-small-3.1-24b-instruct:free",
  phi4: "microsoft/phi-4:free",

  // Meta-routers (ultimate fallbacks — always appended last)
  free: "openrouter/free",
} as const;

// Agent-specific curated primaries — quality picks go first.
// Dynamic free models are appended after these (see buildModelChain).
export const AGENT_PRIMARIES: Record<string, { models: string[]; minContext: number; verbosity: "low" | "medium" | "high" | "max" }> = {
  growth: {
    models: [
      OPENROUTER_MODELS.hermes_405b + ":online",
      OPENROUTER_MODELS.llama_70b + ":online",
      OPENROUTER_MODELS.gemma_27b + ":online",
    ],
    minContext: 8192,  // Content generation needs decent context
    verbosity: "high", // Improve output quality
  },
  outreach: {
    models: [
      OPENROUTER_MODELS.llama_70b,
      OPENROUTER_MODELS.hermes_405b,
      OPENROUTER_MODELS.gemma_27b,
    ],
    minContext: 4096,  // Email drafting is short-context
    verbosity: "medium", // Balanced prospect research
  },
  ops: {
    models: [
      OPENROUTER_MODELS.mistral_24b,
      OPENROUTER_MODELS.phi4,
      OPENROUTER_MODELS.gemma_27b,
    ],
    minContext: 4096,  // Health checks are simple
    verbosity: "low",  // Reduce tokens, faster responses
  },
  planner: {
    models: [
      OPENROUTER_MODELS.qwen_coder,
      OPENROUTER_MODELS.hermes_405b,
      OPENROUTER_MODELS.llama_70b,
    ],
    minContext: 16384, // Spec generation needs long context
    verbosity: "low",  // Backlog-planner optimization
  },
  decomposer: {
    models: [
      OPENROUTER_MODELS.hermes_405b,
      OPENROUTER_MODELS.llama_70b,
      OPENROUTER_MODELS.qwen_coder,
    ],
    minContext: 16384, // Task decomposition needs full context
    verbosity: "medium", // Balance detail vs token usage
  },
};

// ---------------------------------------------------------------------------
// Dynamic Free Model Discovery
// Fetches OpenRouter's catalog, filters free text models, caches 1h.
// ---------------------------------------------------------------------------

interface OpenRouterModel {
  id: string;
  context_length: number;
  architecture: { modality: string };
  pricing: { prompt: string; completion: string };
}

interface FreeModelEntry {
  id: string;
  contextLength: number;
}

let freeModelCache: { models: FreeModelEntry[]; fetchedAt: number } | null = null;
const FREE_MODEL_CACHE_TTL = 60 * 60 * 1000; // 1 hour

/** Fetch all free text-to-text models from OpenRouter, sorted by context_length desc. */
async function fetchFreeModels(): Promise<FreeModelEntry[]> {
  // Return cache if fresh
  if (freeModelCache && Date.now() - freeModelCache.fetchedAt < FREE_MODEL_CACHE_TTL) {
    return freeModelCache.models;
  }

  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.warn(`[llm] Failed to fetch OpenRouter models: HTTP ${res.status}`);
      return freeModelCache?.models ?? [];
    }

    const { data } = await res.json() as { data: OpenRouterModel[] };

    const freeModels = data
      .filter((m) =>
        m.pricing.prompt === "0" &&
        m.pricing.completion === "0" &&
        m.architecture.modality.startsWith("text") &&
        !m.id.startsWith("openrouter/")  // exclude meta-routers
      )
      .sort((a, b) => (b.context_length ?? 0) - (a.context_length ?? 0))
      .map((m) => ({ id: m.id, contextLength: m.context_length ?? 0 }));

    freeModelCache = { models: freeModels, fetchedAt: Date.now() };
    console.log(`[llm] Discovered ${freeModels.length} free models on OpenRouter`);
    return freeModels;
  } catch (err: any) {
    console.warn(`[llm] OpenRouter model discovery failed: ${err.message}`);
    return freeModelCache?.models ?? [];
  }
}

/**
 * Build the full model chain for an agent:
 * 1. Curated primaries (quality — agent-specific ordering)
 * 2. Dynamic free models (resilience — everything else, sorted by context_length)
 * 3. Meta-router fallback (openrouter/free)
 *
 * Deduplicates so curated models aren't listed twice.
 * Filters dynamic pool by agent's minContext requirement.
 */
async function buildModelChain(agent: string): Promise<string[]> {
  const config = AGENT_PRIMARIES[agent];
  if (!config) throw new Error(`No routing configuration for agent: ${agent}`);

  const primaries = [...config.models];
  const dynamicPool = await fetchFreeModels();

  // Filter dynamic pool: meets min context, not already in primaries
  const primarySet = new Set(primaries);
  const extras = dynamicPool
    .filter((m) => !primarySet.has(m.id) && m.contextLength >= config.minContext)
    .map((m) => m.id);

  // Combine: primaries first, then dynamic pool, then meta-router
  return [
    ...primaries,
    ...extras,
    OPENROUTER_MODELS.free,
  ];
}

// Keep backward-compatible export for any code referencing AGENT_ROUTING
export const AGENT_ROUTING: Record<string, { models: string[] }> = Object.fromEntries(
  Object.entries(AGENT_PRIMARIES).map(([agent, config]) => [
    agent,
    { models: config.models },
  ])
);

// Retry wrapper with exponential backoff for rate limiting
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 3
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, options);

      // Success or client errors (don't retry)
      if (res.ok || [400, 401, 403, 404].includes(res.status)) {
        return res;
      }

      // Rate limiting - exponential backoff with jitter
      if (res.status === 429 && attempt < maxRetries) {
        const baseDelay = 1000;
        const exponentialDelay = baseDelay * Math.pow(2, attempt);
        const jitter = Math.random() * 1000;
        const delay = exponentialDelay + jitter;

        console.log(`Rate limit hit (429), retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries + 1})`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      // Server errors - retry with fixed delay
      if (attempt < maxRetries) {
        const delay = attempt === 0 ? 1000 : 3000;
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      return res;
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const delay = attempt === 0 ? 1000 : 3000;
      await new Promise(r => setTimeout(r, delay));
    }
  }

  throw new Error("fetchWithRetry: unreachable");
}

// Single provider: OpenRouter with native server-side fallback
// Uses `models` array — OpenRouter tries each model in order in ONE request.
// Falls back server-side without consuming additional rate limit.
async function callOpenRouter(
  prompt: string,
  models: string[],
  options: LLMOptions = {}
): Promise<{ content: string; model: string }> {
  const apiKey = await getSettingValue("openrouter_api_key");
  if (!apiKey) throw new Error("openrouter_api_key not configured in settings");

  const requestBody: any = {
    // Native models array: OpenRouter tries each in order server-side
    models,
    messages: [{ role: "user", content: prompt }],
    max_tokens: options.maxTokens || 8192,
    temperature: options.temperature || 0.7,
    provider: {
      allow_fallbacks: true,
      sort: "throughput",
      max_price: { prompt: 0, completion: 0 },  // Hard-enforce free-only routing
      require_parameters: true,  // Only route to providers that support all request parameters
    },
  };

  // Add verbosity config for OpenRouter (maps to output_config.effort for Anthropic models)
  if (options.verbosity) {
    requestBody.provider.output_config = {
      effort: options.verbosity,
    };
  }

  // Add structured JSON response format if specified
  if (options.responseFormat) {
    requestBody.response_format = options.responseFormat;
    requestBody.plugins = [{ id: "response-healing" }]; // Safety net for malformed JSON
  }

  const res = await fetchWithRetry("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://hive-phi.vercel.app",
      "X-Title": "Hive Venture Orchestrator",
    },
    body: JSON.stringify(requestBody),
  }, options.maxRetries || 2);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter HTTP ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error(`OpenRouter returned empty response (models: ${models[0]}...)`);

  // OpenRouter returns which model actually handled the request
  const actualModel = data.model || models[0];
  return { content: text.trim(), model: actualModel };
}

// AI SDK-based structured output wrapper using OpenRouter provider
// Coexists with existing callOpenRouter() — used only where structured output
// or system/user message split is needed. Preserves circuit breaker logic.
export interface StructuredLLMOptions extends LLMOptions {
  systemMessage?: string;  // Enables system/user message split
  schema?: any;           // Zod schema for structured output
}

export interface StructuredLLMResponse extends LLMResponse {
  structured?: any;       // Parsed structured data when schema provided
}

async function callLLMStructured(
  prompt: string | { system?: string; user: string },
  models: string[],
  options: StructuredLLMOptions = {}
): Promise<{ content: string; model: string; structured?: any }> {
  const apiKey = await getSettingValue("openrouter_api_key");
  if (!apiKey) throw new Error("openrouter_api_key not configured in settings");

  // Prepare messages
  let messages: Array<{ role: "system" | "user"; content: string }>;
  if (typeof prompt === "string") {
    messages = options.systemMessage
      ? [
          { role: "system", content: options.systemMessage },
          { role: "user", content: prompt }
        ]
      : [{ role: "user", content: prompt }];
  } else {
    messages = [];
    if (prompt.system) {
      messages.push({ role: "system", content: prompt.system });
    }
    messages.push({ role: "user", content: prompt.user });
  }

  // Filter models by circuit breaker availability
  const availableModels = models.filter(model => {
    const circuitKey = `openrouter:${model}`;
    return isProviderAvailable(circuitKey);
  });

  if (availableModels.length === 0) {
    throw new Error("All models circuit-broken");
  }

  // Common options for AI SDK calls
  const commonOptions = {
    messages,
    maxTokens: options.maxTokens || 8192,
    temperature: options.temperature || 0.7,
    apiKey,
  };

  // Try models sequentially with circuit breaker tracking
  for (const model of availableModels) {
    const circuitKey = `openrouter:${model}`;

    try {
      if (options.schema) {
        // Structured output using generateObject
        const result = await generateObject({
          model: openrouter(model),
          schema: options.schema,
          ...commonOptions,
        });

        recordProviderSuccess(circuitKey);
        return {
          content: JSON.stringify(result.object, null, 2),
          model,
          structured: result.object
        };
      } else {
        // Regular text generation using generateText
        const result = await aiGenerateText({
          model: openrouter(model),
          ...commonOptions,
        });

        recordProviderSuccess(circuitKey);
        return { content: result.text, model };
      }
    } catch (error: any) {
      recordProviderFailure(circuitKey);
      console.warn(`[llm] Model ${model} failed: ${error.message}`);

      // If this was the last model, throw the error
      if (model === availableModels[availableModels.length - 1]) {
        throw error;
      }
      // Otherwise continue to next model
    }
  }

  throw new Error("All available models failed");
}

// Main unified LLM calling interface
// Uses OpenRouter's native `models` array for server-side fallback.
// One API request covers all fallback models — saves rate limit budget.
export async function callLLM(
  agent: string,
  prompt: string,
  options: LLMOptions & { sql?: any } = {}
): Promise<LLMResponse> {
  // Build full model chain: curated primaries + dynamic free models + meta-routers
  const fullChain = await buildModelChain(agent);
  const primaryModel = AGENT_PRIMARIES[agent]?.models[0] ?? fullChain[0];

  const { sql, ...llmOptions } = options;

  // Apply default verbosity per agent type if not specified
  if (!llmOptions.verbosity && AGENT_PRIMARIES[agent]) {
    llmOptions.verbosity = AGENT_PRIMARIES[agent].verbosity;
  }

  // Filter out models with open circuit breakers
  const availableModels = fullChain.filter(model => {
    const circuitKey = `openrouter:${model}`;
    if (!isProviderAvailable(circuitKey)) {
      console.warn(`[circuit-breaker] Skipping ${model} (circuit open)`);
      return false;
    }
    return true;
  });

  if (availableModels.length === 0) {
    throw new Error(`All models circuit-broken for agent ${agent}`);
  }

  try {
    // Single request — OpenRouter handles fallback server-side
    const result = await callOpenRouter(prompt, availableModels, llmOptions);

    // Record success for the model that actually responded
    recordProviderSuccess(`openrouter:${result.model}`);

    return {
      content: result.content,
      provider: "openrouter",
      model: result.model,
      usage: { cost_usd: 0 },
      routing_reason: result.model === primaryModel
        ? `primary:${result.model}`
        : `fallback:${result.model} (${availableModels.length} models in chain)`,
    };
  } catch (error: any) {
    // Record failure for primary models only (don't penalize entire dynamic pool)
    const primaries = AGENT_PRIMARIES[agent]?.models ?? [];
    for (const model of primaries) {
      recordProviderFailure(`openrouter:${model}`);
    }

    throw new Error(`All OpenRouter models failed for agent ${agent}. Chain: ${availableModels.length} models (primaries: ${primaries.slice(0, 3).join(", ")}). Last error: ${error.message}`);
  }
}

// Structured LLM interface using AI SDK with OpenRouter provider
// Supports system/user message split and structured output via Zod schemas.
// Coexists with existing callLLM() — use for structured output or message control.
export async function callLLMStructuredResponse(
  agent: string,
  prompt: string | { system?: string; user: string },
  options: StructuredLLMOptions & { sql?: any } = {}
): Promise<StructuredLLMResponse> {
  // Build full model chain using existing routing logic
  const fullChain = await buildModelChain(agent);
  const primaryModel = AGENT_PRIMARIES[agent]?.models[0] ?? fullChain[0];

  const { sql, ...llmOptions } = options;

  // Apply default verbosity per agent type if not specified
  if (!llmOptions.verbosity && AGENT_PRIMARIES[agent]) {
    llmOptions.verbosity = AGENT_PRIMARIES[agent].verbosity;
  }

  try {
    // Use AI SDK-based structured calling
    const result = await callLLMStructured(prompt, fullChain, llmOptions);

    return {
      content: result.content,
      provider: "openrouter",
      model: result.model,
      usage: { cost_usd: 0 },
      routing_reason: result.model === primaryModel
        ? `primary:${result.model}`
        : `fallback:${result.model} (ai-sdk)`,
      structured: result.structured,
    };
  } catch (error: any) {
    // Record failure for primary models only
    const primaries = AGENT_PRIMARIES[agent]?.models ?? [];
    for (const model of primaries) {
      recordProviderFailure(`openrouter:${model}`);
    }

    throw new Error(`AI SDK OpenRouter models failed for agent ${agent}. Last error: ${error.message}`);
  }
}

// Convenience wrapper for simple text generation
export async function generateText(
  agent: string,
  prompt: string,
  options?: LLMOptions & { sql?: any }
): Promise<string> {
  const response = await callLLM(agent, prompt, options);
  return response.content;
}

// Convenience wrapper for structured output generation with Zod schema
export async function generateStructured<T>(
  agent: string,
  prompt: string | { system?: string; user: string },
  schema: any,
  options?: StructuredLLMOptions & { sql?: any }
): Promise<T> {
  const response = await callLLMStructuredResponse(agent, prompt, { ...options, schema });
  return response.structured as T;
}

// Convenience wrapper that includes provider metadata in logs
export async function callLLMWithLogging(
  agent: string,
  prompt: string,
  options: LLMOptions & { sql?: any } = {}
): Promise<{ response: LLMResponse; logData: Record<string, any> }> {
  const startTime = Date.now();

  try {
    const response = await callLLM(agent, prompt, options);
    const duration = Math.round((Date.now() - startTime) / 1000);

    const logData = {
      provider: response.provider,
      model: response.model,
      routing_reason: response.routing_reason,
      cost_usd: response.usage?.cost_usd || 0,
      duration_s: duration,
      status: "success",
    };

    return { response, logData };
  } catch (error: any) {
    const duration = Math.round((Date.now() - startTime) / 1000);

    const logData = {
      provider: "openrouter",
      model: "unknown",
      routing_reason: "all_models_failed",
      cost_usd: 0,
      duration_s: duration,
      status: "failed",
      error: error.message?.slice(0, 500),
    };

    throw { error, logData };
  }
}
