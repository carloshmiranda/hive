import { NextRequest } from "next/server";
import { getDb, json, err } from "@/lib/db";
import { getSettingValue } from "@/lib/settings";

// Agents that can run on Vercel serverless (Gemini/Groq HTTP calls only)
const WORKER_AGENTS = ["growth", "outreach", "ops"] as const;
type WorkerAgent = typeof WORKER_AGENTS[number];

// Agent → LLM provider mapping
const AGENT_MODEL: Record<WorkerAgent, { provider: "gemini" | "groq"; model: string }> = {
  growth:   { provider: "gemini", model: "gemini-2.5-flash-lite" },
  outreach: { provider: "gemini", model: "gemini-2.5-flash-lite" },
  ops:      { provider: "groq",  model: "llama-3.3-70b-versatile" },
};

// Default prompts if not in DB
const DEFAULT_PROMPTS: Record<WorkerAgent, string> = {
  growth: "You are the Growth agent. Create content, schedule posts, run experiments. Check the playbook first. Output JSON with content_created, posts_scheduled, experiments.",
  outreach: "You are the Outreach agent. Find leads, draft cold emails, plan follow-ups. Output JSON with leads and emails_drafted.",
  ops: "You are the Ops agent. Check deployment health, collect metrics, verify services are running. Output JSON with metrics_collected, health_status, issues_found.",
};

// Max duration: Gemini calls take 10-30s, well within 300s Fluid Compute limit
export const maxDuration = 120;

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
    return err(`Agent must be one of: ${WORKER_AGENTS.join(", ")}. Brain agents run on Mac/Synology.`);
  }

  const sql = getDb();
  const agentName = agent as WorkerAgent;
  const startTime = Date.now();

  try {
    // 1. Load company
    const [company] = await sql`
      SELECT id, name, slug, status, description 
      FROM companies WHERE slug = ${company_slug} AND status IN ('mvp', 'active')
    `;
    if (!company) return err(`Company ${company_slug} not found or not active`);

    // 2. Load context: latest CEO plan, metrics, research, playbook
    const [latestCycle] = await sql`
      SELECT id, cycle_number, ceo_plan FROM cycles
      WHERE company_id = ${company.id} ORDER BY started_at DESC LIMIT 1
    `;
    const ceoPlan = latestCycle?.ceo_plan || "No CEO plan yet — use your best judgment.";

    const metrics = await sql`
      SELECT date, revenue, mrr, customers, page_views, signups, churn_rate FROM metrics
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
    let agentPrompt = dbPrompt?.prompt_text || DEFAULT_PROMPTS[agentName];
    agentPrompt = agentPrompt
      .replace(/\{\{COMPANY_NAME\}\}/g, company.name)
      .replace(/\{\{COMPANY_SLUG\}\}/g, company.slug);

    const contextBlock = `
COMPANY: ${company.name} (${company.slug}) — ${company.status}
DESCRIPTION: ${company.description || "N/A"}

CEO PLAN: ${typeof ceoPlan === "string" ? ceoPlan : JSON.stringify(ceoPlan)}

METRICS (last 7 days):
${metrics.length > 0 ? metrics.map((m: any) => `${m.date}: MRR=${m.mrr || 0}, customers=${m.customers || 0}, pageviews=${m.page_views || 0}, signups=${m.signups || 0}`).join("\n") : "No metrics yet"}

RESEARCH REPORTS:
${researchReports.map((r: any) => `[${r.report_type}] ${r.summary || "See content"}`).join("\n") || "None yet"}

PLAYBOOK (cross-company learnings):
${playbook.map((p: any) => `[${p.domain}] ${p.insight} (confidence: ${p.confidence})`).join("\n") || "No playbook entries yet"}

TRIGGER: ${trigger || "scheduled"}`;

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

    // 5. Call the LLM
    const { provider, model } = AGENT_MODEL[agentName];
    let output: string;

    if (provider === "gemini") {
      output = await callGemini(fullPrompt, model);
    } else {
      output = await callGroq(fullPrompt, model);
    }

    // 6. Log the result to agent_actions
    const duration = Math.round((Date.now() - startTime) / 1000);
    await sql`
      INSERT INTO agent_actions (
        company_id, cycle_id, agent, action_type, description, 
        status, output, started_at, finished_at
      ) VALUES (
        ${company.id}, ${latestCycle?.id || null}, ${agentName}, 'execute_task',
        ${`[serverless] ${agentName} for ${company.slug} (${trigger || "scheduled"}, ${duration}s, ${provider}/${model})`},
        'success', ${JSON.stringify({ output: output.slice(0, 5000), provider, model, trigger })},
        ${new Date(startTime).toISOString()}, ${new Date().toISOString()}
      )
    `;

    // 7. Agent-specific post-processing
    if (agentName === "outreach") {
      await processOutreachResults(sql, company, output);
    }

    return json({
      ok: true,
      agent: agentName,
      company: company.slug,
      provider,
      model,
      duration_seconds: duration,
      output_preview: output.slice(0, 500),
    });

  } catch (error: any) {
    // Log failure
    const duration = Math.round((Date.now() - startTime) / 1000);
    try {
      const [company] = await sql`SELECT id FROM companies WHERE slug = ${company_slug}`;
      await sql`
        INSERT INTO agent_actions (
          company_id, agent, action_type, description, status, error,
          started_at, finished_at
        ) VALUES (
          ${company?.id || null}, ${agentName}, 'execute_task',
          ${`[serverless] ${agentName} failed for ${company_slug} (${duration}s)`},
          'failed', ${error.message?.slice(0, 500) || "Unknown error"},
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
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 8192, temperature: 0.7 },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    // Fallback to Groq if Gemini fails
    console.log(`Gemini ${model} failed (${res.status}), falling back to Groq`);
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

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 8192,
      temperature: 0.7,
    }),
  });

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
