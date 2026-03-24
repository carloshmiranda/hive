import { NextRequest } from "next/server";
import { getDb, json, err } from "@/lib/db";
import { getSettingValue } from "@/lib/settings";
import { capabilitiesSummary } from "@/lib/capabilities";
import { getFilePrompt } from "@/lib/prompts";
import { canSendOutreach } from "@/lib/resend";

// Retry wrapper for transient LLM API failures (429, 5xx, network errors)
// Implements exponential backoff with jitter for rate limiting (429) responses
async function fetchWithRetry(url: string, options: RequestInit, maxRetries = 2): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, options);
      if (res.ok || [400, 401, 403, 404].includes(res.status)) return res;

      if (attempt < maxRetries) {
        let delay: number;
        if (res.status === 429) {
          // Exponential backoff with jitter for rate limits: 2^attempt * base + random jitter
          const baseDelay = 1000; // 1 second base
          const exponentialDelay = baseDelay * Math.pow(2, attempt);
          const jitter = Math.random() * 1000; // 0-1 second jitter
          delay = exponentialDelay + jitter;
          console.log(`Rate limit hit (429), retrying in ${Math.round(delay)}ms (attempt ${attempt + 1}/${maxRetries + 1})`);
        } else {
          // Regular retry for other errors
          delay = attempt === 0 ? 1000 : 3000;
        }

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

// Agents that can run on Vercel serverless (Gemini/Groq HTTP calls only)
const WORKER_AGENTS = ["growth", "outreach", "ops"] as const;
type WorkerAgent = typeof WORKER_AGENTS[number];

// Default agent → LLM provider mapping (used when no performance data available)
const DEFAULT_AGENT_MODEL: Record<WorkerAgent, { provider: "gemini" | "groq"; model: string }> = {
  growth:   { provider: "gemini", model: "gemini-2.5-flash" },
  outreach: { provider: "gemini", model: "gemini-2.5-flash" },
  ops:      { provider: "groq",  model: "llama-3.3-70b-versatile" },
};

// Cost per call by provider (estimated USD)
const PROVIDER_COST: Record<string, number> = {
  gemini: 0,       // free tier
  groq: 0,         // free tier
  claude: 0.03,    // Sonnet per-turn fallback
};

// Get optimal provider for an agent based on historical success rates
// If primary provider has <70% success rate in last 48h, try alternatives
// Short window (48h) allows fast reaction to provider outages/degradation
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getOptimalModel(sql: any, agent: WorkerAgent): Promise<{ provider: "gemini" | "groq"; model: string; routing_reason: string }> {
  const defaults = DEFAULT_AGENT_MODEL[agent];

  try {
    // Get success rates by provider for this agent in last 48 hours
    const stats = await sql`
      SELECT
        output->>'provider' as provider,
        output->>'model' as model,
        COUNT(*) FILTER (WHERE status = 'success') as successes,
        COUNT(*) as total
      FROM agent_actions
      WHERE agent = ${agent}
        AND action_type = 'execute_task'
        AND started_at > NOW() - INTERVAL '48 hours'
        AND output IS NOT NULL
        AND output->>'provider' IS NOT NULL
      GROUP BY output->>'provider', output->>'model'
    `.catch(() => []);

    if (stats.length === 0) {
      return { ...defaults, routing_reason: "no_history" };
    }

    // Check primary provider success rate
    const primaryStats = stats.find((s: Record<string, unknown>) => s.provider === defaults.provider);
    if (primaryStats) {
      const successRate = Number(primaryStats.successes) / Number(primaryStats.total);
      if (successRate >= 0.7) {
        return { ...defaults, routing_reason: `primary_ok (${Math.round(successRate * 100)}% success)` };
      }

      // Primary failing — try alternative
      // For Gemini agents: try Groq as cheaper alternative
      // For Groq agents: try Gemini
      if (defaults.provider === "gemini") {
        const groqStats = stats.find((s: Record<string, unknown>) => s.provider === "groq");
        if (groqStats && Number(groqStats.successes) / Number(groqStats.total) >= 0.5) {
          return { provider: "groq", model: "llama-3.3-70b-versatile", routing_reason: `failover (${defaults.provider} at ${Math.round(successRate * 100)}%)` };
        }
      } else {
        const geminiStats = stats.find((s: Record<string, unknown>) => s.provider === "gemini");
        if (geminiStats && Number(geminiStats.successes) / Number(geminiStats.total) >= 0.5) {
          return { provider: "gemini", model: "gemini-2.5-flash", routing_reason: `failover (${defaults.provider} at ${Math.round(successRate * 100)}%)` };
        }
      }

      // Both failing — stick with default (fallback chain handles it)
      return { ...defaults, routing_reason: `degraded (${Math.round(successRate * 100)}% success, no better alternative)` };
    }

    return { ...defaults, routing_reason: "no_primary_data" };
  } catch {
    return { ...defaults, routing_reason: "stats_error" };
  }
}

// Default prompts — one verb per agent
const DEFAULT_PROMPTS: Record<WorkerAgent, string> = {
  growth: "Generate content. Read the CEO plan and playbook, then create blog posts, social content, or SEO pages. Output JSON: { content_created: [...], posts_scheduled: N }",
  outreach: "Prospect leads. Read the lead list and outreach log, then draft cold emails and plan follow-ups. Output JSON: { leads: [...], emails_drafted: [...] }",
  ops: "Verify health. Check deploy status, collect metrics from Stripe/Vercel/Neon, detect anomalies. Output JSON: { metrics_collected: N, health_status: 'ok'|'degraded', issues_found: [...], needs_engineer: bool }",
};

// Truncate large JSONB content to save context tokens
function truncateJson(content: unknown, maxChars: number): string {
  const str = typeof content === "string" ? content : JSON.stringify(content);
  if (str.length <= maxChars) return str;
  return str.slice(0, maxChars) + `... [truncated, ${str.length - maxChars} chars omitted]`;
}

// Max duration: Gemini calls take 10-30s, 60s is Hobby-tier safe
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  // Auth: CRON_SECRET bearer token (same as Vercel crons)
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return err("Unauthorized", 401);
  }

  const body = await req.json();
  const { company_slug, agent, trigger } = body as {
    company_slug: string;
    agent: string;
    trigger?: string;
  };

  if (!company_slug || !agent) {
    return err("company_slug and agent are required");
  }
  if (!WORKER_AGENTS.includes(agent as WorkerAgent)) {
    return err(`Agent must be one of: ${WORKER_AGENTS.join(", ")}. Brain agents run on GitHub Actions.`);
  }

  const sql = getDb();
  const agentName = agent as WorkerAgent;
  const startTime = Date.now();

  try {
    // 1. Load company
    const [company] = await sql`
      SELECT id, name, slug, status, description, capabilities, company_type, imported, github_repo
      FROM companies WHERE slug = ${company_slug} AND status IN ('mvp', 'active')
    `;
    if (!company) return err(`Company ${company_slug} not found or not active`);

    // 2. Load context: latest CEO plan, metrics, research, playbook
    const [latestCycle] = await sql`
      SELECT id, cycle_number, ceo_plan FROM cycles
      WHERE company_id = ${company.id} ORDER BY started_at DESC LIMIT 1
    `;

    // Outreach requires a verified sending domain — skip if not configured
    if (agentName === "outreach") {
      const outreachAllowed = await canSendOutreach();
      if (!outreachAllowed) {
        console.warn(`Outreach dispatch skipped for ${company.slug}: canSendOutreach() returned false (no verified sending_domain)`);
        return json({
          ok: true,
          skipped: true,
          reason: `Outreach skipped for ${company.slug}: no verified sending domain configured. Set sending_domain in /settings.`,
          agent: agentName,
          company: company.slug,
        });
      }
    }

    // Growth and Outreach must wait for a CEO plan — without one, they'd run blind
    if ((agentName === "growth" || agentName === "outreach") && !latestCycle?.ceo_plan) {
      return json({
        ok: true,
        skipped: true,
        reason: `No CEO plan exists for ${company.slug} yet. Growth/Outreach wait for the CEO to create a cycle first.`,
        agent: agentName,
        company: company.slug,
      });
    }

    const ceoPlan = latestCycle?.ceo_plan || "No CEO plan yet — use your best judgment.";

    const metrics = await sql`
      SELECT date, revenue, mrr, customers, page_views, signups, churn_rate, waitlist_signups, waitlist_total FROM metrics
      WHERE company_id = ${company.id} AND date >= CURRENT_DATE - INTERVAL '7 days'
      ORDER BY date DESC LIMIT 20
    `;

    const researchReports = await sql`
      SELECT report_type, summary, content FROM research_reports 
      WHERE company_id = ${company.id} LIMIT 5
    `;

    const playbook = await sql`
      SELECT domain, insight, confidence FROM playbook 
      WHERE superseded_by IS NULL AND confidence >= 0.6
      ORDER BY confidence DESC LIMIT 10
    `;

    // 3. Build the agent prompt with full context
    const [dbPrompt] = await sql`
      SELECT prompt_text FROM agent_prompts 
      WHERE agent = ${agentName} AND is_active = true LIMIT 1
    `;
    let agentPrompt = dbPrompt?.prompt_text || getFilePrompt(agentName) || DEFAULT_PROMPTS[agentName];
    agentPrompt = agentPrompt
      .replace(/\{\{COMPANY_NAME\}\}/g, company.name)
      .replace(/\{\{COMPANY_SLUG\}\}/g, company.slug);

    const contextBlock = `
COMPANY: ${company.name} (${company.slug}) — ${company.status}
DESCRIPTION: ${company.description || "N/A"}

CEO PLAN: ${typeof ceoPlan === "string" ? ceoPlan : JSON.stringify(ceoPlan)}

METRICS (last 7 days):
${metrics.length > 0 ? metrics.map((m: any) => `${m.date}: MRR=${m.mrr || 0}, customers=${m.customers || 0}, pageviews=${m.page_views || 0}, signups=${m.signups || 0}, waitlist=${m.waitlist_total || 0}(+${m.waitlist_signups || 0})`).join("\n") : "No metrics yet"}

RESEARCH REPORTS:
${researchReports.map((r: any) => `[${r.report_type}] ${r.summary || "See content"}`).join("\n") || "None yet"}

PLAYBOOK (cross-company learnings):
${playbook.map((p: any) => `[${p.domain}] ${p.insight} (confidence: ${p.confidence})`).join("\n") || "No playbook entries yet"}

TRIGGER: ${trigger || "scheduled"}

${capabilitiesSummary(company.capabilities)}`;

    // 4. Add agent-specific context
    let fullPrompt = agentPrompt + "\n\n" + contextBlock;

    if (agentName === "outreach") {
      const [leadList] = await sql`
        SELECT content FROM research_reports WHERE company_id = ${company.id} AND report_type = 'lead_list'
      `;
      const [outreachLog] = await sql`
        SELECT content FROM research_reports WHERE company_id = ${company.id} AND report_type = 'outreach_log'
      `;
      fullPrompt += `\n\nEXISTING LEADS: ${leadList ? JSON.stringify(leadList.content) : "None yet"}`;
      fullPrompt += `\nOUTREACH LOG: ${outreachLog ? JSON.stringify(outreachLog.content) : "No outreach yet"}`;
    }

    if (agentName === "growth") {
      // Collect fresh visibility data (non-blocking — runs GSC + LLM citation checks)
      try {
        const visRes = await fetch(`${process.env.NEXT_PUBLIC_URL || "https://hive-phi.vercel.app"}/api/agents/visibility`, {
          method: "POST",
          headers: { Authorization: `Bearer ${cronSecret}`, "Content-Type": "application/json" },
          body: JSON.stringify({ company_slug }),
        });
        if (visRes.ok) {
          const visData = await visRes.json();
          console.log(`Visibility data collected for ${company_slug}:`, visData.data?.results);
        }
      } catch (e) {
        console.log(`Visibility collection failed (non-blocking): ${e}`);
      }

      // Inject visibility context into Growth prompt
      const [visSnapshot] = await sql`
        SELECT content FROM research_reports WHERE company_id = ${company.id} AND report_type = 'visibility_snapshot'
      `;
      const [llmVis] = await sql`
        SELECT content FROM research_reports WHERE company_id = ${company.id} AND report_type = 'llm_visibility'
      `;
      // Context optimization: truncate large JSONB reports to prevent token bloat
      if (visSnapshot) fullPrompt += `\n\nVISIBILITY DATA (from GSC):\n${truncateJson(visSnapshot.content, 2000)}`;
      if (llmVis) fullPrompt += `\n\nLLM VISIBILITY:\n${truncateJson(llmVis.content, 1500)}`;

      // Content performance report — per-URL trends and refresh recommendations
      const [contentPerf] = await sql`
        SELECT content FROM research_reports WHERE company_id = ${company.id} AND report_type = 'content_performance'
      `;
      if (contentPerf) fullPrompt += `\n\nCONTENT PERFORMANCE (refresh recommendations):\n${truncateJson(contentPerf.content, 2000)}`;
    }

    // 5. Call the LLM — cost-based routing selects optimal provider
    const { provider, model, routing_reason } = await getOptimalModel(sql, agentName);
    let output: string;

    if (provider === "gemini") {
      output = await callGemini(fullPrompt, model);
    } else {
      output = await callGroq(fullPrompt, model);
    }

    // 6. Log the result to agent_actions with cost tracking
    const duration = Math.round((Date.now() - startTime) / 1000);
    const estimatedCost = PROVIDER_COST[provider] || 0;
    await sql`
      INSERT INTO agent_actions (
        company_id, cycle_id, agent, action_type, description,
        status, output, started_at, finished_at
      ) VALUES (
        ${company.id}, ${latestCycle?.id || null}, ${agentName}, 'execute_task',
        ${`[serverless] ${agentName} for ${company.slug} (${trigger || "scheduled"}, ${duration}s, ${provider}/${model}, routed: ${routing_reason})`},
        'success', ${JSON.stringify({ output: output.slice(0, 5000), provider, model, trigger, routing_reason, cost_usd: estimatedCost, duration_s: duration })}::jsonb,
        ${new Date(startTime).toISOString()}, ${new Date().toISOString()}
      )
    `;

    // 7. Agent-specific post-processing
    if (agentName === "outreach") {
      await processOutreachResults(sql, company, output);
    }

    // 8. Ops escalation → dispatch fix to company repo (free Actions) with Hive fallback
    if (agentName === "ops" && output.includes("needs_engineer")) {
      try {
        const ghPat = await getSettingValue("github_token") || process.env.GH_PAT;
        if (ghPat && company.github_repo) {
          // Try company repo's hive-fix.yml first (free on public repos)
          const fixRes = await fetch(
            `https://api.github.com/repos/${company.github_repo}/actions/workflows/hive-fix.yml/dispatches`,
            {
              method: "POST",
              headers: {
                Authorization: `token ${ghPat}`,
                Accept: "application/vnd.github.v3+json",
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                ref: "main",
                inputs: {
                  error_summary: `Ops detected issue for ${company.slug}`,
                  company_slug: company.slug,
                  source: "ops",
                },
              }),
            }
          );
          if (!fixRes.ok) throw new Error("Company workflow dispatch failed");
        } else if (ghPat) {
          // Fallback: dispatch to Hive Engineer
          const ghRepo = process.env.GITHUB_REPOSITORY || "carloshmiranda/hive";
          await fetch(`https://api.github.com/repos/${ghRepo}/dispatches`, {
            method: "POST",
            headers: {
              Authorization: `token ${ghPat}`,
              Accept: "application/vnd.github.v3+json",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              event_type: "ops_escalation",
              client_payload: { company: company.slug, source: "ops" },
            }),
          });
        }
      } catch { /* non-critical chain dispatch failure */ }
    }

    return json({
      ok: true,
      agent: agentName,
      company: company.slug,
      provider,
      model,
      routing_reason,
      cost_usd: estimatedCost,
      duration_seconds: duration,
      output_preview: output.slice(0, 500),
    });

  } catch (error: any) {
    // Log failure with provider info for routing decisions
    const duration = Math.round((Date.now() - startTime) / 1000);
    try {
      const [company] = await sql`SELECT id FROM companies WHERE slug = ${company_slug}`;
      const failedModel = DEFAULT_AGENT_MODEL[agentName] || { provider: "unknown", model: "unknown" };
      await sql`
        INSERT INTO agent_actions (
          company_id, agent, action_type, description, status, error,
          output, started_at, finished_at
        ) VALUES (
          ${company?.id || null}, ${agentName}, 'execute_task',
          ${`[serverless] ${agentName} failed for ${company_slug} (${duration}s, ${failedModel.provider}/${failedModel.model})`},
          'failed', ${error.message?.slice(0, 500) || "Unknown error"},
          ${JSON.stringify({ provider: failedModel.provider, model: failedModel.model, duration_s: duration })}::jsonb,
          ${new Date(startTime).toISOString()}, ${new Date().toISOString()}
        )
      `;
    } catch { /* don't fail the failure logging */ }

    return err(`Agent dispatch failed: ${error.message}`, 500);
  }
}

// === LLM PROVIDERS ===

async function callGemini(prompt: string, model: string): Promise<string> {
  const apiKey = await getSettingValue("gemini_api_key");
  if (!apiKey) throw new Error("gemini_api_key not configured in settings");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 8192, temperature: 0.7 },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.log(`Gemini ${model} failed (${res.status}): ${body.slice(0, 200)}`);
    // Fallback chain: Flash → Flash-Lite → Groq
    if (model === "gemini-2.5-flash") {
      return callGemini(prompt, "gemini-2.5-flash-lite");
    }
    return callGroq(prompt, "llama-3.3-70b-versatile");
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned empty response");
  return text.trim();
}

async function callGroq(prompt: string, model: string): Promise<string> {
  const apiKey = await getSettingValue("groq_api_key");
  if (!apiKey) throw new Error("groq_api_key not configured in settings");

  // Use more aggressive retry for Groq due to rate limiting
  const res = await fetchWithRetry("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 8192,
      temperature: 0.7,
    }),
  }, 4); // Increase retries from 2 to 4 for rate limit resilience

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Groq ${model} HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error("Groq returned empty response");
  return text.trim();
}

// === POST-PROCESSING ===

async function processOutreachResults(sql: any, company: any, output: string) {
  try {
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;
    const parsed = JSON.parse(jsonMatch[0]);

    if (parsed.leads?.length) {
      await sql`
        INSERT INTO research_reports (company_id, report_type, content, summary)
        VALUES (${company.id}, 'lead_list', ${JSON.stringify(parsed)}, ${`${parsed.leads.length} leads tracked`})
        ON CONFLICT (company_id, report_type) DO UPDATE SET
          content = ${JSON.stringify(parsed)}, summary = ${`${parsed.leads.length} leads tracked`}, updated_at = now()
      `;
    }

    if (parsed.emails_drafted?.length) {
      await sql`
        INSERT INTO research_reports (company_id, report_type, content, summary)
        VALUES (${company.id}, 'outreach_log', ${JSON.stringify(parsed)}, ${`${parsed.emails_drafted.length} emails drafted`})
        ON CONFLICT (company_id, report_type) DO UPDATE SET
          content = ${JSON.stringify(parsed)}, summary = ${`${parsed.emails_drafted.length} emails drafted`}, updated_at = now()
      `;
    }
  } catch { /* non-critical parsing failure */ }
}
