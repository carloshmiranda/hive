import { NextRequest } from "next/server";
import { getDb, json, err } from "@/lib/db";
import { getGitHubToken } from "@/lib/github-app";
import { capabilitiesSummary } from "@/lib/capabilities";
import { getFilePrompt } from "@/lib/prompts";
import { canSendOutreach } from "@/lib/resend";
import { callLLMWithLogging } from "@/lib/llm";
import { getResponseFormat, AGENT_SCHEMAS } from "@/lib/agent-schemas";
import { sanitizeJSON, validateDispatchPayload, sanitizeTaskInput, hasSuspiciousPatterns } from "@/lib/input-sanitizer";

// Worker agents use unified LLM provider abstraction (src/lib/llm.ts)
// Handles provider routing, fallbacks, rate limiting, and response normalization

// Agents that can run on Vercel serverless (unified LLM abstraction)
const WORKER_AGENTS = ["growth", "outreach", "ops"] as const;
type WorkerAgent = typeof WORKER_AGENTS[number];

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

  let body = await req.json();

  // Validate and sanitize the request payload
  const validation = validateDispatchPayload(body);
  if (!validation.isValid) {
    return err(validation.error || "Invalid payload", 400);
  }

  // Sanitize the entire body to prevent injection attacks
  body = sanitizeJSON(body);

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
      SELECT id, name, slug, status, description, capabilities, company_type, content_language, imported, github_repo
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
        AND (content_language IS NULL OR content_language = ${company.content_language || 'en'})
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

    // Sanitize trigger input before adding to agent prompt
    let sanitizedTrigger = trigger || "scheduled";
    if (trigger) {
      sanitizedTrigger = sanitizeTaskInput(trigger);

      // Check for suspicious patterns in trigger
      const suspiciousCheck = hasSuspiciousPatterns(trigger);
      if (suspiciousCheck.hasSuspicious) {
        console.warn(`[agents] Suspicious patterns detected in trigger for ${company.slug}/${agentName}: ${suspiciousCheck.patterns.join(', ')} (risk: ${suspiciousCheck.riskLevel})`);

        // Log to agent_actions with flagged status
        await sql`
          INSERT INTO agent_actions (
            company_id, agent, action_type, description, status, output,
            started_at, finished_at
          ) VALUES (
            ${company.id}, ${agentName}, 'security_check',
            ${`Suspicious patterns detected in trigger: ${suspiciousCheck.patterns.join(', ')}`},
            'flagged', ${JSON.stringify({
              company_slug: company.slug,
              patterns: suspiciousCheck.patterns,
              risk_level: suspiciousCheck.riskLevel,
              original_trigger: trigger
            })}::jsonb,
            ${new Date().toISOString()}, ${new Date().toISOString()}
          )
        `.catch(e => console.error('[agents] Failed to log suspicious pattern detection:', e));
      }
    }

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

TRIGGER: ${sanitizedTrigger}

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

    // 5. Call the unified LLM interface with structured JSON response format
    const responseFormat = getResponseFormat(agentName as keyof typeof AGENT_SCHEMAS);
    const { response, logData } = await callLLMWithLogging(agentName, fullPrompt, {
      sql,
      responseFormat
    });
    const output = response.content;

    // 6. Log the result to agent_actions with provider metadata
    const duration = Math.round((Date.now() - startTime) / 1000);
    await sql`
      INSERT INTO agent_actions (
        company_id, cycle_id, agent, action_type, description,
        status, output, started_at, finished_at
      ) VALUES (
        ${company.id}, ${latestCycle?.id || null}, ${agentName}, 'execute_task',
        ${`[serverless] ${agentName} for ${company.slug} (${trigger || "scheduled"}, ${logData.duration_s}s, ${logData.provider}/${logData.model}, routed: ${logData.routing_reason})`},
        'success', ${JSON.stringify({ output: output.slice(0, 5000), ...logData, trigger })}::jsonb,
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
        const ghPat = await getGitHubToken() || process.env.GH_PAT;
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
      } catch (e: any) { console.warn(`[dispatch] ops escalation chain dispatch for ${company.slug} failed: ${e?.message || e}`); }
    }

    return json({
      ok: true,
      agent: agentName,
      company: company.slug,
      provider: logData.provider,
      model: logData.model,
      routing_reason: logData.routing_reason,
      cost_usd: logData.cost_usd,
      duration_seconds: logData.duration_s,
      output_preview: output.slice(0, 500),
    });

  } catch (error: any) {
    // Handle unified LLM errors with provider info for routing decisions
    const duration = Math.round((Date.now() - startTime) / 1000);
    try {
      const [company] = await sql`SELECT id FROM companies WHERE slug = ${company_slug}`;

      // Extract log data from LLM error if available
      const logData = error.logData || {
        provider: "unknown",
        model: "unknown",
        routing_reason: "error",
        cost_usd: 0,
        duration_s: duration,
        status: "failed",
        error: error.message?.slice(0, 500) || "Unknown error"
      };

      await sql`
        INSERT INTO agent_actions (
          company_id, agent, action_type, description, status, error,
          output, started_at, finished_at
        ) VALUES (
          ${company?.id || null}, ${agentName}, 'execute_task',
          ${`[serverless] ${agentName} failed for ${company_slug} (${logData.duration_s}s, ${logData.provider}/${logData.model})`},
          'failed', ${logData.error},
          ${JSON.stringify(logData)}::jsonb,
          ${new Date(startTime).toISOString()}, ${new Date().toISOString()}
        )
      `;
    } catch (e: any) { console.warn(`[dispatch] error logging for ${agentName}/${company_slug} failed: ${e?.message || e}`); }

    return err(`Agent dispatch failed: ${(error.error || error).message}`, 500);
  }
}

// LLM providers now handled by unified interface in src/lib/llm.ts

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
  } catch (e: any) { console.warn(`[dispatch] outreach result parsing for ${company.slug} failed: ${e?.message || e}`); }
}
