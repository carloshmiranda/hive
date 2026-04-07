import { NextRequest } from "next/server";
import { getDb, json, err } from "@/lib/db";
import { getGitHubToken } from "@/lib/github-app";
import { capabilitiesSummary } from "@/lib/capabilities";
import { getFilePrompt } from "@/lib/prompts";
import { canSendOutreach } from "@/lib/resend";
import { callLLMWithLogging, callLLMWithTools } from "@/lib/llm";
import { getSuppressedEmails } from "@/lib/outreach-suppression";
import { getResponseFormat, AGENT_SCHEMAS } from "@/lib/agent-schemas";
import { HIVE_TOOLS } from "@/lib/hive-tools";
import { sanitizeJSON, validateDispatchPayload, sanitizeTaskInput, hasSuspiciousPatterns } from "@/lib/input-sanitizer";
import { setSentryTags, addDispatchBreadcrumb, withSpan } from "@/lib/sentry-tags";
import { type CompletionReport } from "@/lib/completion-report";
import { cachedPlaybook } from "@/lib/redis-cache";
import { compressResearchForAgent } from "@/lib/research-compression";
import { qstashPublish } from "@/lib/qstash";
import { verifyPlaybookUsage } from "@/lib/playbook-verification";
import { resolveBlobContent, uploadIfLarge } from "@/lib/blob-storage";

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

// Deduplicate playbook entries across agents in the same cycle
async function getDeduplicatedPlaybook(
  sql: any,
  company: any,
  agentName: string,
  cycleId?: string
): Promise<any[]> {
  // Get all playbook entries
  const allPlaybook = await sql`
    SELECT domain, insight, confidence FROM playbook
    WHERE superseded_by IS NULL AND confidence >= 0.6
      AND (content_language IS NULL OR content_language = ${company.content_language || 'en'})
    ORDER BY confidence DESC LIMIT 20
  `.catch(() => []);

  if (!cycleId) {
    // No cycle context, return full playbook (up to 10 entries)
    return allPlaybook.slice(0, 10);
  }

  // Get playbook entries already sent to other agents in this cycle
  const usedEntries = await sql`
    SELECT DISTINCT jsonb_array_elements_text(
      (output->'context'->'playbook_entries')::jsonb
    ) as insight
    FROM agent_actions
    WHERE company_id = ${company.id}
      AND agent != ${agentName}
      AND description LIKE '%cycle%' || ${cycleId} || '%'
      AND output ? 'context'
      AND status = 'success'
      AND started_at >= (
        SELECT started_at FROM cycles
        WHERE id = ${cycleId} LIMIT 1
      )
  `.catch(() => []);

  const usedInsights = new Set(usedEntries.map((e: any) => e.insight));

  // Filter out entries already sent to other agents in this cycle
  const deduplicatedPlaybook = allPlaybook.filter(
    (entry: any) => !usedInsights.has(entry.insight)
  );

  // Return top 10 unique entries for this agent
  return deduplicatedPlaybook.slice(0, 10);
}

// Max duration: Gemini calls take 10-30s, 60s is Hobby-tier safe
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  // Auth: CRON_SECRET bearer token or GitHub Actions OIDC
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    const { validateOIDC } = await import("@/lib/oidc");
    const result = await validateOIDC(req);
    if (result instanceof Response) return result;
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

  // Set Sentry tags for error triage and filtering
  setSentryTags({
    agent: agentName,
    action_type: "agent_dispatch",
    route: "/api/agents/dispatch"
  });

  try {
    // 1. Load company
    const [company] = await sql`
      SELECT id, name, slug, status, description, capabilities, company_type, content_language, imported, github_repo
      FROM companies WHERE slug = ${company_slug} AND status IN ('mvp', 'active')
    `;
    if (!company) return err(`Company ${company_slug} not found or not active`);

    // Add company_id to Sentry tags now that we have it
    setSentryTags({ company_id: company.id });

    addDispatchBreadcrumb({
      message: `Dispatch started: ${agentName} for ${company.slug}`,
      category: "dispatch",
      data: { agent: agentName, company: company.slug, trigger: trigger || "scheduled" },
    });

    // Per-agent hourly rate limit: prevent dispatch burst patterns
    // Brain agents: 3/hr, Workers: 8/hr (defense-in-depth on top of specific dedup guards)
    const isWorkerAgent = WORKER_AGENTS.includes(agentName);
    const hourlyThreshold = isWorkerAgent ? 8 : 3; // Workers: 8/hr, Brain agents: 3/hr

    const [hourlyCount] = await sql`
      SELECT COUNT(*)::int as dispatch_count FROM agent_actions
      WHERE agent = ${agentName}
      AND company_id = ${company.id}
      AND started_at > NOW() - INTERVAL '1 hour'
      AND status IN ('running', 'success', 'failed')  -- All dispatch attempts
    `.catch(() => [{ dispatch_count: 0 }]);

    if (hourlyCount.dispatch_count >= hourlyThreshold) {
      addDispatchBreadcrumb({
        message: `Rate limited: ${agentName} for ${company.slug} (${hourlyCount.dispatch_count}/${hourlyThreshold}/hr)`,
        category: "rate_limit",
        level: "warning",
        data: { agent: agentName, company: company.slug, count: hourlyCount.dispatch_count, threshold: hourlyThreshold },
      });
      // Log the rate limit hit for debugging
      await sql`
        INSERT INTO agent_actions (company_id, agent, action_type, status, description, started_at, finished_at)
        VALUES (${company.id}, ${agentName}, 'dispatch_attempt', 'skipped',
          ${`Per-agent hourly rate limit exceeded: ${hourlyCount.dispatch_count}/${hourlyThreshold} dispatches in last hour for ${company.slug}`},
          NOW(), NOW())
      `.catch(() => {});

      console.log(`[dispatch] Rate limit: ${agentName} for ${company.slug} blocked - ${hourlyCount.dispatch_count}/${hourlyThreshold} dispatches in last hour`);
      return json({
        ok: true,
        skipped: true,
        reason: "rate_limited",
        agent: agentName,
        company: company.slug,
        hourly_count: hourlyCount.dispatch_count,
        threshold: hourlyThreshold
      });
    }

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

    // Fetch independent data sources in parallel
    const [metrics, rawResearchReports, playbook, dbPromptRows] = await Promise.all([
      sql`
        SELECT date, revenue, mrr, customers, page_views, signups, churn_rate, waitlist_signups, waitlist_total FROM metrics
        WHERE company_id = ${company.id} AND date >= CURRENT_DATE - INTERVAL '7 days'
        ORDER BY date DESC LIMIT 20
      `,
      sql`
        SELECT report_type, summary, content FROM research_reports
        WHERE company_id = ${company.id} LIMIT 10
      `,
      getDeduplicatedPlaybook(sql, company, agentName, latestCycle?.id),
      sql`
        SELECT prompt_text FROM agent_prompts
        WHERE agent = ${agentName} AND is_active = true LIMIT 1
      `,
    ]);

    // Compress research summaries to reduce context size by ~20%
    const researchReports = compressResearchForAgent(rawResearchReports, agentName);

    // 3. Build the agent prompt with full context
    const [dbPrompt] = dbPromptRows;
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
      const [[leadList], [outreachLog]] = await Promise.all([
        sql`SELECT content FROM research_reports WHERE company_id = ${company.id} AND report_type = 'lead_list'`,
        sql`SELECT content FROM research_reports WHERE company_id = ${company.id} AND report_type = 'outreach_log'`,
      ]);
      const [leadContent, outreachContent] = await Promise.all([
        leadList ? resolveBlobContent(leadList.content) : Promise.resolve(null),
        outreachLog ? resolveBlobContent(outreachLog.content) : Promise.resolve(null),
      ]);
      fullPrompt += `\n\nEXISTING LEADS: ${leadContent ? JSON.stringify(leadContent) : "None yet"}`;
      fullPrompt += `\nOUTREACH LOG: ${outreachContent ? JSON.stringify(outreachContent) : "No outreach yet"}`;
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

      // Inject visibility context into Growth prompt (fetch in parallel)
      const [[visSnapshot], [llmVis], [contentPerf]] = await Promise.all([
        sql`SELECT content FROM research_reports WHERE company_id = ${company.id} AND report_type = 'visibility_snapshot'`,
        sql`SELECT content FROM research_reports WHERE company_id = ${company.id} AND report_type = 'llm_visibility'`,
        sql`SELECT content FROM research_reports WHERE company_id = ${company.id} AND report_type = 'content_performance'`,
      ]);
      const [visContent, llmVisContent, contentPerfContent] = await Promise.all([
        visSnapshot ? resolveBlobContent(visSnapshot.content) : Promise.resolve(null),
        llmVis ? resolveBlobContent(llmVis.content) : Promise.resolve(null),
        contentPerf ? resolveBlobContent(contentPerf.content) : Promise.resolve(null),
      ]);
      // Context optimization: truncate large JSONB reports to prevent token bloat
      if (visContent) fullPrompt += `\n\nVISIBILITY DATA (from GSC):\n${truncateJson(visContent, 2000)}`;
      if (llmVisContent) fullPrompt += `\n\nLLM VISIBILITY:\n${truncateJson(llmVisContent, 1500)}`;
      if (contentPerfContent) fullPrompt += `\n\nCONTENT PERFORMANCE (refresh recommendations):\n${truncateJson(contentPerfContent, 2000)}`;
    }

    // 5. Call the unified LLM interface with tool calling support
    // Use tools for dynamic context loading instead of pre-loading everything
    addDispatchBreadcrumb({
      message: `LLM call starting: ${agentName} for ${company.slug}`,
      category: "llm",
      data: { agent: agentName, company: company.slug },
    });
    const responseFormat = getResponseFormat(agentName as keyof typeof AGENT_SCHEMAS);

    // Sentry performance span: measures LLM call duration for tracing in the performance tab
    const { response, logData, toolResults } = await withSpan(
      `LLM: ${agentName}`,
      "ai.run",
      { "ai.agent": agentName, "ai.company": company.slug },
      async (span) => {
        const result = await callLLMWithTools(agentName, fullPrompt, {
          sql,
          responseFormat,
          tools: HIVE_TOOLS,
          parallelToolCalls: true,
          company: company.slug,
        });
        // Update span with actual provider/model resolved at runtime
        span?.setAttributes({
          "ai.provider": result.logData.provider,
          "ai.model_id": result.logData.model,
          "ai.duration_s": result.logData.duration_s,
          "ai.cost_usd": result.logData.cost_usd ?? 0,
          "ai.tool_calls": result.response.toolCalls?.length ?? 0,
        });
        return result;
      }
    );
    const output = response.content;

    addDispatchBreadcrumb({
      message: `LLM call complete: ${logData.provider}/${logData.model} in ${logData.duration_s}s`,
      category: "llm",
      data: { provider: logData.provider, model: logData.model, duration_s: logData.duration_s, cost_usd: logData.cost_usd, tool_calls: response.toolCalls?.length || 0 },
    });

    // 6. Verify playbook usage before logging
    const playbookUsage = await verifyPlaybookUsage(output, playbook);

    // 7. Log the result to agent_actions with provider metadata and tool calling tracking
    const duration = Math.round((Date.now() - startTime) / 1000);
    const contextMetadata = {
      playbook_entries: playbook.map((p: any) => p.insight),
      playbook_usage: playbookUsage,
      research_types: researchReports.map((r: any) => r.report_type),
      compressed_research: true,
      deduplication_applied: !!latestCycle?.id,
      tool_calls_used: response.toolCalls?.length || 0,
      tool_results: toolResults?.length || 0,
      tool_execution_success: logData.tool_execution_success || true,
    };

    // Build completion report from worker output
    let workerReport: CompletionReport | undefined;
    try {
      const reportMatch = output.match(/\{[\s\S]*\}/);
      if (reportMatch) {
        const parsed = JSON.parse(reportMatch[0]);
        workerReport = {
          summary: `${agentName} for ${company.slug}: ${parsed.health_status || parsed.content_created?.length + ' items' || 'completed'}`,
          recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations : undefined,
          metrics_impact: typeof parsed.metrics_collected === 'number' ? { metrics_collected: parsed.metrics_collected } : undefined,
        };
        // Ops agent: signal engineer if issues found
        if (agentName === "ops" && parsed.needs_engineer && Array.isArray(parsed.issues_found)) {
          workerReport.blockers = parsed.issues_found.map((i: any) => typeof i === 'string' ? i : i.title || i.issue || JSON.stringify(i)).slice(0, 3);
          workerReport.recommendations = [
            ...(workerReport.recommendations || []),
            { target_agent: 'engineer', priority: 'action' as const, message: `Ops detected ${parsed.issues_found.length} issue(s) for ${company.slug}` },
          ];
        }
      }
    } catch { /* best-effort report extraction */ }

    await sql`
      INSERT INTO agent_actions (
        company_id, cycle_id, agent, action_type, description,
        status, output, started_at, finished_at
      ) VALUES (
        ${company.id}, ${latestCycle?.id || null}, ${agentName}, 'execute_task',
        ${`[serverless] ${agentName} for ${company.slug} (${trigger || "scheduled"}, ${logData.duration_s}s, ${logData.provider}/${logData.model}, routed: ${logData.routing_reason})`},
        'success', ${JSON.stringify({
          output: output.slice(0, 5000),
          context: contextMetadata,
          ...logData,
          trigger,
          ...(workerReport || {}),
        })}::jsonb,
        ${new Date(startTime).toISOString()}, ${new Date().toISOString()}
      )
    `;

    addDispatchBreadcrumb({
      message: `DB logged: agent_actions insert success for ${agentName}/${company.slug}`,
      category: "db",
      data: { agent: agentName, company: company.slug },
    });

    // 8. Agent-specific post-processing
    if (agentName === "outreach") {
      await processOutreachResults(sql, company, output);
    }

    // 9. Track worker output as company_tasks (best-effort JSON parsing)
    try {
      const jsonMatch = output.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        const taskEntries: { title: string; description: string }[] = [];

        if (agentName === "growth" && Array.isArray(parsed.content_created)) {
          for (const c of parsed.content_created.slice(0, 5)) {
            taskEntries.push({ title: `[Growth] ${typeof c === "string" ? c : c.title || c.type || "Content piece"}`, description: typeof c === "string" ? c : JSON.stringify(c) });
          }
        } else if (agentName === "outreach" && Array.isArray(parsed.emails_drafted)) {
          for (const e of parsed.emails_drafted.slice(0, 5)) {
            taskEntries.push({ title: `[Outreach] ${typeof e === "string" ? e : e.subject || e.to || "Email draft"}`, description: typeof e === "string" ? e : JSON.stringify(e) });
          }
        } else if (agentName === "ops" && Array.isArray(parsed.issues_found)) {
          for (const i of parsed.issues_found.slice(0, 5)) {
            taskEntries.push({ title: `[Ops] ${typeof i === "string" ? i : i.title || i.issue || "Issue detected"}`, description: typeof i === "string" ? i : JSON.stringify(i) });
          }
        }

        for (const te of taskEntries) {
          await sql`
            INSERT INTO company_tasks (company_id, cycle_id, title, description, status, source)
            VALUES (${company.id}, ${latestCycle?.id || null}, ${te.title.slice(0, 200)}, ${te.description.slice(0, 2000)}, 'done', ${agentName})
          `.catch(() => {});
        }
      }
    } catch { /* best-effort — don't fail dispatch on parse errors */ }

    // 10. Ops escalation → dispatch fix to company repo (free Actions) with Hive fallback
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
                Authorization: `Bearer ${ghPat}`,
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
              Authorization: `Bearer ${ghPat}`,
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

    // Chain dispatch: trigger cycle-complete to continue workflow instead of waiting for Sentinel
    // This fixes the 4-hour latency gap by immediately chaining to next work
    addDispatchBreadcrumb({
      message: `QStash chain dispatch: worker-completion for ${agentName}/${company.slug}`,
      category: "qstash",
      data: { agent: agentName, company: company.slug },
    });
    qstashPublish("/api/dispatch/cycle-complete", {
      agent: agentName,
      company: company.slug,
      status: "success",
      action_type: "worker_completion",
    }, {
      deduplicationId: `worker-complete-${agentName}-${company.slug}-${new Date().toISOString().slice(0, 13)}`,
      retries: 2,
    }).catch((e: any) => {
      console.warn(`[dispatch] worker completion chain dispatch for ${agentName}:${company.slug} failed: ${e?.message || e}`);
    });

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

    let leadsUpdated = false;

    if (parsed.leads?.length) {
      // Filter out suppressed emails before storing leads
      const suppressedEmails = await getSuppressedEmails(company.id);
      const filteredLeads = parsed.leads.filter((lead: any) => {
        if (!lead.email) return true; // Keep leads without email
        return !suppressedEmails.has(lead.email.toLowerCase());
      });

      const originalCount = parsed.leads.length;
      const filteredCount = filteredLeads.length;

      if (originalCount > filteredCount) {
        console.log(`[dispatch] Filtered ${originalCount - filteredCount} suppressed leads for ${company.slug}`);
      }

      const processedData = { ...parsed, leads: filteredLeads };
      const processedStr = JSON.stringify(processedData);
      const leadsBlobUrl = await uploadIfLarge(processedStr, `research/${company.id}/lead_list`);
      const leadsContent = leadsBlobUrl ? JSON.stringify({ _blob_url: leadsBlobUrl }) : processedStr;

      await sql`
        INSERT INTO research_reports (company_id, report_type, content, summary)
        VALUES (${company.id}, 'lead_list', ${leadsContent}::jsonb, ${`${filteredLeads.length} leads tracked (${originalCount - filteredCount} filtered)`})
        ON CONFLICT (company_id, report_type) DO UPDATE SET
          content = ${leadsContent}::jsonb, summary = ${`${filteredLeads.length} leads tracked (${originalCount - filteredCount} filtered)`}, updated_at = now()
      `;
      leadsUpdated = true;
    }

    if (parsed.emails_drafted?.length) {
      const parsedStr = JSON.stringify(parsed);
      const outreachBlobUrl = await uploadIfLarge(parsedStr, `research/${company.id}/outreach_log`);
      const outreachContent = outreachBlobUrl ? JSON.stringify({ _blob_url: outreachBlobUrl }) : parsedStr;
      await sql`
        INSERT INTO research_reports (company_id, report_type, content, summary)
        VALUES (${company.id}, 'outreach_log', ${outreachContent}::jsonb, ${`${parsed.emails_drafted.length} emails drafted`})
        ON CONFLICT (company_id, report_type) DO UPDATE SET
          content = ${outreachContent}::jsonb, summary = ${`${parsed.emails_drafted.length} emails drafted`}, updated_at = now()
      `;
    }

    // Auto-sync leads to Resend after updating lead_list
    if (leadsUpdated) {
      try {
        const syncResponse = await fetch(`${process.env.VERCEL_URL || 'https://hive-phi.vercel.app'}/api/outreach/sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ company_id: company.id }),
        });

        if (syncResponse.ok) {
          const syncResult = await syncResponse.json();
          console.log(`[dispatch] Auto-synced ${syncResult.leads_synced || 0} leads to Resend for ${company.slug}`);
        } else {
          console.warn(`[dispatch] Resend sync failed for ${company.slug}: ${syncResponse.status}`);
        }
      } catch (syncError: any) {
        console.warn(`[dispatch] Resend sync error for ${company.slug}: ${syncError.message}`);
      }
    }

  } catch (e: any) { console.warn(`[dispatch] outreach result parsing for ${company.slug} failed: ${e?.message || e}`); }
}
