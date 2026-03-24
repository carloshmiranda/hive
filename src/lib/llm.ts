import { getSettingValue } from "./settings";

// Unified LLM calling interface for worker agents
// Handles provider selection, automatic failover, rate limiting, and response normalization

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

export interface LLMProvider {
  name: string;
  models: string[];
  cost_per_call: number;
  free_tier: boolean;
}

// Provider definitions with fallback priority
export const PROVIDERS: Record<string, LLMProvider> = {
  groq: {
    name: "groq",
    models: ["llama-3.3-70b-versatile", "llama-3.1-70b-versatile"],
    cost_per_call: 0,
    free_tier: true,
  },
  gemini: {
    name: "gemini",
    models: ["gemini-2.5-flash", "gemini-2.5-flash-lite"],
    cost_per_call: 0,
    free_tier: true,
  },
  claude: {
    name: "claude",
    models: ["claude-3-sonnet-20240229"],
    cost_per_call: 0.03,
    free_tier: false,
  },
};

// Agent-specific provider routing table
export const AGENT_ROUTING: Record<string, { primary: string; model: string; fallback: string[] }> = {
  growth: {
    primary: "gemini",
    model: "gemini-2.5-flash",
    fallback: ["groq", "claude"],
  },
  outreach: {
    primary: "gemini",
    model: "gemini-2.5-flash",
    fallback: ["groq", "claude"],
  },
  ops: {
    primary: "groq",
    model: "llama-3.3-70b-versatile",
    fallback: ["gemini", "claude"],
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
        const baseDelay = 1000; // 1 second base
        const exponentialDelay = baseDelay * Math.pow(2, attempt);
        const jitter = Math.random() * 1000; // 0-1 second jitter
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

// Provider-specific API calls
async function callGemini(prompt: string, model: string, options: LLMOptions = {}): Promise<string> {
  const apiKey = await getSettingValue("gemini_api_key");
  if (!apiKey) throw new Error("gemini_api_key not configured in settings");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: options.maxTokens || 8192,
        temperature: options.temperature || 0.7,
      },
    }),
  }, options.maxRetries);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini ${model} HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned empty response");
  return text.trim();
}

async function callGroq(prompt: string, model: string, options: LLMOptions = {}): Promise<string> {
  const apiKey = await getSettingValue("groq_api_key");
  if (!apiKey) throw new Error("groq_api_key not configured in settings");

  const res = await fetchWithRetry("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: options.maxTokens || 8192,
      temperature: options.temperature || 0.7,
    }),
  }, options.maxRetries || 4); // Higher retries for Groq due to rate limiting

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Groq ${model} HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error("Groq returned empty response");
  return text.trim();
}

async function callClaude(prompt: string, model: string, options: LLMOptions = {}): Promise<string> {
  // Fallback to Claude should only happen in extreme cases
  // For now, return a placeholder that logs the fallback
  console.warn(`Falling back to Claude for ${model} - this burns premium quota`);
  throw new Error("Claude fallback not implemented - contact admin to add API key");
}

// Get historical success rates to determine optimal provider
async function getProviderSuccessRate(
  provider: string,
  agent: string,
  sql?: any
): Promise<number> {
  if (!sql) return 0.8; // Default success rate if no DB access

  try {
    const [stats] = await sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'success') as successes,
        COUNT(*) as total
      FROM agent_actions
      WHERE agent = ${agent}
        AND action_type = 'execute_task'
        AND started_at > NOW() - INTERVAL '48 hours'
        AND output IS NOT NULL
        AND output->>'provider' = ${provider}
    `;

    if (!stats || stats.total === 0) return 0.8; // Default if no data
    return Number(stats.successes) / Number(stats.total);
  } catch {
    return 0.8; // Default on error
  }
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
  const providers = [routing.primary, ...routing.fallback];
  let lastError: Error | null = null;

  // Try each provider in order until one succeeds
  for (const providerName of providers) {
    const provider = PROVIDERS[providerName];
    if (!provider) continue;

    try {
      // Check historical success rate for adaptive routing
      const successRate = await getProviderSuccessRate(providerName, agent, sql);
      const isProviderDegraded = successRate < 0.7;

      let routingReason = `primary_${providerName}`;
      if (isProviderDegraded && providerName === routing.primary) {
        routingReason = `degraded_${providerName} (${Math.round(successRate * 100)}% success)`;
      } else if (providerName !== routing.primary) {
        routingReason = `fallback_${providerName}`;
      }

      // Select model - use primary model for primary provider, first available for fallbacks
      const model = providerName === routing.primary
        ? routing.model
        : provider.models[0];

      let content: string;

      // Call provider-specific function
      switch (providerName) {
        case "gemini":
          content = await callGemini(prompt, model, llmOptions);
          break;
        case "groq":
          content = await callGroq(prompt, model, llmOptions);
          break;
        case "claude":
          content = await callClaude(prompt, model, llmOptions);
          break;
        default:
          throw new Error(`Unknown provider: ${providerName}`);
      }

      return {
        content,
        provider: providerName,
        model,
        usage: {
          cost_usd: provider.cost_per_call,
        },
        routing_reason: routingReason,
      };

    } catch (error: any) {
      console.warn(`Provider ${providerName} failed:`, error.message);
      lastError = error;

      // If this is Gemini Flash, try Flash-Lite before moving to next provider
      if (providerName === "gemini" && routing.model === "gemini-2.5-flash") {
        try {
          const content = await callGemini(prompt, "gemini-2.5-flash-lite", llmOptions);
          return {
            content,
            provider: "gemini",
            model: "gemini-2.5-flash-lite",
            usage: { cost_usd: 0 },
            routing_reason: "gemini_flash_lite_fallback",
          };
        } catch {
          // Continue to next provider
        }
      }

      // Continue to next provider in fallback chain
      continue;
    }
  }

  // All providers failed
  throw new Error(`All LLM providers failed for agent ${agent}. Last error: ${lastError?.message}`);
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
      provider: "unknown",
      model: "unknown",
      routing_reason: "error",
      cost_usd: 0,
      duration_s: duration,
      status: "failed",
      error: error.message?.slice(0, 500),
    };

    throw { error, logData };
  }
}