import { getSettingValue } from "./settings";

// Unified LLM calling interface for worker agents
// All calls route through OpenRouter with per-model fallback chains.
// Claude Max (GitHub Actions CLI) is NOT in this chain — it's not API-based.

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

// Available OpenRouter free models (ordered by capability)
export const OPENROUTER_MODELS = {
  hermes_405b: "nousresearch/hermes-3-llama-3.1-405b:free",   // 405B — strongest free reasoning
  llama_70b: "meta-llama/llama-3.3-70b-instruct:free",         // 70B — solid general purpose
  mistral_24b: "mistralai/mistral-small-3.1-24b-instruct:free", // 24B — fast, good for simple tasks
  qwen_coder: "qwen/qwen3-coder:free",                         // Best free coding model
  claude_sonnet: "anthropic/claude-sonnet-4:free",              // Claude Sonnet 4 free — best reasoning
} as const;

// Agent-specific model routing — all through OpenRouter
// Primary model + fallback models (tried in order if primary fails)
export const AGENT_ROUTING: Record<string, { primary: string; fallbacks: string[] }> = {
  growth: {
    primary: OPENROUTER_MODELS.hermes_405b,       // 405B for content quality
    fallbacks: [OPENROUTER_MODELS.llama_70b, OPENROUTER_MODELS.mistral_24b],
  },
  outreach: {
    primary: OPENROUTER_MODELS.llama_70b,          // 70B sufficient for emails
    fallbacks: [OPENROUTER_MODELS.hermes_405b, OPENROUTER_MODELS.mistral_24b],
  },
  ops: {
    primary: OPENROUTER_MODELS.mistral_24b,        // 24B fast for health checks
    fallbacks: [OPENROUTER_MODELS.llama_70b, OPENROUTER_MODELS.hermes_405b],
  },
  planner: {
    primary: OPENROUTER_MODELS.qwen_coder,         // Best free coding model
    fallbacks: [OPENROUTER_MODELS.claude_sonnet, OPENROUTER_MODELS.hermes_405b],
  },
  decomposer: {
    primary: OPENROUTER_MODELS.claude_sonnet,       // Best reasoning for task decomposition
    fallbacks: [OPENROUTER_MODELS.hermes_405b, OPENROUTER_MODELS.qwen_coder],
  },
};

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

// Single provider: OpenRouter
async function callOpenRouter(prompt: string, model: string, options: LLMOptions = {}): Promise<string> {
  const apiKey = await getSettingValue("openrouter_api_key");
  if (!apiKey) throw new Error("openrouter_api_key not configured in settings");

  const res = await fetchWithRetry("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://hive-phi.vercel.app",
      "X-Title": "Hive Venture Orchestrator",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: options.maxTokens || 8192,
      temperature: options.temperature || 0.7,
    }),
  }, options.maxRetries || 3);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter ${model} HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error(`OpenRouter ${model} returned empty response`);
  return text.trim();
}

// Main unified LLM calling interface
export async function callLLM(
  agent: string,
  prompt: string,
  options: LLMOptions & { sql?: any } = {}
): Promise<LLMResponse> {
  const routing = AGENT_ROUTING[agent];
  if (!routing) {
    throw new Error(`No routing configuration for agent: ${agent}`);
  }

  const { sql, ...llmOptions } = options;
  const models = [routing.primary, ...routing.fallbacks];
  let lastError: Error | null = null;

  // Try each model in order until one succeeds
  for (const model of models) {
    const circuitKey = `openrouter:${model}`;

    // Circuit breaker: skip models with open circuits
    if (!isProviderAvailable(circuitKey)) {
      console.warn(`[circuit-breaker] Skipping ${model} (circuit open)`);
      continue;
    }

    const isPrimary = model === routing.primary;
    const routingReason = isPrimary ? `primary:${model}` : `fallback:${model}`;

    try {
      const content = await callOpenRouter(prompt, model, llmOptions);

      // Record success for circuit breaker
      recordProviderSuccess(circuitKey);

      return {
        content,
        provider: "openrouter",
        model,
        usage: { cost_usd: 0 },
        routing_reason: routingReason,
      };
    } catch (error: any) {
      console.warn(`[llm] Model ${model} failed for ${agent}: ${error.message}`);
      lastError = error;

      // Record failure for circuit breaker
      recordProviderFailure(circuitKey);
      continue;
    }
  }

  // All models failed
  throw new Error(`All OpenRouter models failed for agent ${agent}. Models tried: ${models.join(", ")}. Last error: ${lastError?.message}`);
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
