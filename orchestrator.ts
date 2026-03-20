#!/usr/bin/env ts-node
/**
 * HIVE Orchestrator Runner
 * 
 * This is the nightly brain. Runs via launchd on your Mac.
 * Calls Claude Code CLI (`claude -p`) for each agent task.
 * Pushes all state to Neon via the Hive API.
 * 
 * Usage:
 *   npx ts-node orchestrator.ts              # full nightly run
 *   npx ts-node orchestrator.ts --company pawly  # single company
 *   npx ts-node orchestrator.ts --dry-run    # plan only, no execution
 */

import { spawn } from "child_process";
import { neon } from "@neondatabase/serverless";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// === CONFIG ===
const HIVE_API = process.env.HIVE_API_URL || "http://localhost:3000/api";
const DATABASE_URL = process.env.DATABASE_URL!;
const MAX_RETRIES = 3;
const MESSAGES_PER_COMPANY = 40; // budget from Max 5x window
const DRY_RUN = process.argv.includes("--dry-run");
const SINGLE_COMPANY = process.argv.find((_, i, a) => a[i - 1] === "--company");
const FORCE_SCOUT = process.argv.includes("--scout"); // Force idea generation
const SCOUT_ONLY = process.argv.includes("--scout-only"); // Run only idea scout, skip companies

const sql = neon(DATABASE_URL);

// === MULTI-PROVIDER DISPATCH ===
// Brain (strategic) → Claude Code CLI (Max 5x subscription)
// Workers → Gemini API free tier / Groq free tier
// Fallback: if free tier fails → try next provider → Claude as last resort

type Provider = "claude" | "gemini" | "groq";

interface DispatchOptions {
  prompt: string;
  cwd?: string;              // only works with Claude (CLI tool use)
  allowedTools?: string[];   // only works with Claude
  maxTurns?: number;         // only works with Claude
  timeoutMs?: number;
  provider?: Provider;       // explicit override
  agent?: string;            // used for auto-routing
}

// Import report — generated after each project import for Carlos's awareness
interface ImportReport {
  company: string;
  slug: string;
  phases_completed: string[];
  content_absorbed: { guides: number; tools: number; pages: number; total_content_items: number };
  queue_items_absorbed: { directives_created: number; approvals_created: number; items: Array<{ file: string; type: string; title: string; priority: string }> };
  legacy_agents_found: Array<{ name: string; file: string; session_count: number }>;
  playbook_entries_created: number;
  manual_actions_required: Array<{ title: string; detail: string; priority: string; source: string }>;
  recommendations: string[];
  warnings: string[];
}

// Agent → Provider mapping
const AGENT_PROVIDER: Record<string, Provider> = {
  // Brain tier — Claude (strategic decisions, tool use, web search, code execution)
  ceo: "claude",         // Opus — plans, reviews, portfolio analysis, kill decisions
  scout: "claude",       // Opus — ideas, market research, SEO keywords
  engineer: "claude",    // Sonnet — code, deploy, scaffold, fix (needs cwd)
  evolver: "claude",     // Opus — prompt analysis + improvement
  // Worker tier — free LLMs (content gen, simple analysis, no tool use)
  growth: "gemini",      // Gemini 2.5 Flash (content quality matters for SEO)
  outreach: "gemini",    // Gemini 2.5 Flash (email personalization quality)
  ops: "groq",           // Groq Llama 3.3 70B (fast inference for health checks)
};

async function dispatch(opts: DispatchOptions): Promise<string> {
  if (DRY_RUN) {
    const p = opts.provider || AGENT_PROVIDER[opts.agent || ""] || "claude";
    console.log(`[DRY RUN] [${p}] ${opts.prompt.slice(0, 100)}...`);
    return "[DRY RUN] No output";
  }

  // If cwd or tools are needed, force Claude (only CLI can use them)
  if (opts.cwd || opts.allowedTools?.length) {
    return dispatchClaude(opts);
  }

  let provider = opts.provider || AGENT_PROVIDER[opts.agent || ""] || "claude";

  // Check if keys are configured; fall back to Claude if not
  if (provider === "gemini" && !(await getSettingValueDirect("gemini_api_key"))) provider = "claude";
  if (provider === "groq" && !(await getSettingValueDirect("groq_api_key"))) provider = "claude";

  // Dispatch with fallback chain: primary → alternate free tier → Claude
  if (provider === "gemini") {
    try { return await dispatchGemini(opts); } catch (e: any) {
      console.log(`    ⚠ Gemini failed: ${e.message.slice(0, 60)}`);
      try { return await dispatchGroq(opts); } catch {
        console.log(`    ⚠ Groq fallback also failed, using Claude`);
        return dispatchClaude(opts);
      }
    }
  }
  if (provider === "groq") {
    try { return await dispatchGroq(opts); } catch (e: any) {
      console.log(`    ⚠ Groq failed: ${e.message.slice(0, 60)}, using Claude`);
      return dispatchClaude(opts);
    }
  }
  return dispatchClaude(opts);
}

// === CLAUDE (CLI with tool use) ===
async function dispatchClaude(opts: DispatchOptions): Promise<string> {
  const args = ["-p", opts.prompt, "--output-format", "text"];
  if (opts.allowedTools?.length) args.push("--allowedTools", opts.allowedTools.join(","));
  if (opts.maxTurns) args.push("--max-turns", opts.maxTurns.toString());
  const timeout = opts.timeoutMs || 5 * 60 * 1000;

  return new Promise((resolve, reject) => {
    const spawnOpts: any = { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] };
    if (opts.cwd) spawnOpts.cwd = opts.cwd;
    const proc = spawn("claude", args, spawnOpts);
    let stdout = "", stderr = "", killed = false;
    proc.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
    proc.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
    const timer = setTimeout(() => { killed = true; proc.kill("SIGTERM"); setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000); }, timeout);
    proc.on("close", (code: number | null) => { clearTimeout(timer); if (killed) reject(new Error(`Claude timed out after ${Math.round(timeout/1000)}s`)); else if (code !== 0) reject(new Error(`Claude exited ${code}: ${stderr.slice(0,500)}`)); else resolve(stdout.trim()); });
    proc.on("error", (err: Error) => { clearTimeout(timer); reject(new Error(`Claude spawn failed: ${err.message}`)); });
  });
}

// === GEMINI (HTTP API, free tier) ===
async function dispatchGemini(opts: DispatchOptions): Promise<string> {
  const apiKey = await getSettingValueDirect("gemini_api_key");
  if (!apiKey) throw new Error("No gemini_api_key");
  // Flash for content quality, Flash-Lite only as fallback
  const model = "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || 120_000);
  try {
    const res = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: opts.prompt }] }], generationConfig: { maxOutputTokens: 8192, temperature: 0.7 } }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) { const e = await res.text(); throw new Error(`Gemini ${model} ${res.status}: ${e.slice(0,200)}`); }
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Gemini empty response");
    return text.trim();
  } catch (err: any) { clearTimeout(timer); throw err.name === "AbortError" ? new Error(`Gemini timed out`) : err; }
}

// === GROQ (HTTP API, free tier, fastest inference) ===
async function dispatchGroq(opts: DispatchOptions): Promise<string> {
  const apiKey = await getSettingValueDirect("groq_api_key");
  if (!apiKey) throw new Error("No groq_api_key");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || 60_000);
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages: [{ role: "user", content: opts.prompt }], max_tokens: 8192, temperature: 0.7 }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) { const e = await res.text(); throw new Error(`Groq ${res.status}: ${e.slice(0,200)}`); }
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error("Groq empty response");
    return text.trim();
  } catch (err: any) { clearTimeout(timer); throw err.name === "AbortError" ? new Error("Groq timed out") : err; }
}

// === DATABASE HELPERS ===

// Direct settings reader for orchestrator (can't import from Next.js app)
async function getSettingValueDirect(key: string): Promise<string | null> {
  const [row] = await sql`SELECT value, is_secret FROM settings WHERE key = ${key}`;
  if (!row) return null;
  if (!row.is_secret) return row.value;
  const encKey = process.env.ENCRYPTION_KEY;
  if (!encKey) return null;
  try {
    const { createDecipheriv } = await import("crypto");
    const [ivHex, tagHex, encrypted] = row.value.split(":");
    if (!ivHex || !tagHex || !encrypted) return null;
    const iv = Buffer.from(ivHex, "hex");
    const tag = Buffer.from(tagHex, "hex");
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(encKey, "hex"), iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted, "hex", "utf8") + decipher.final("utf8");
  } catch { return null; }
}

async function getActiveCompanies() {
  const rows = await sql`
    SELECT * FROM companies 
    WHERE status IN ('mvp', 'active')
    ORDER BY created_at ASC
  `;
  return SINGLE_COMPANY ? rows.filter(r => r.slug === SINGLE_COMPANY) : rows;
}

async function getLatestCycleNumber(companyId: string): Promise<number> {
  const [row] = await sql`
    SELECT MAX(cycle_number) as max_num FROM cycles WHERE company_id = ${companyId}
  `;
  return (row?.max_num || 0) + 1;
}

async function createCycle(companyId: string, cycleNumber: number) {
  const [row] = await sql`
    INSERT INTO cycles (company_id, cycle_number, status)
    VALUES (${companyId}, ${cycleNumber}, 'running')
    RETURNING id
  `;
  return row.id;
}

async function updateCycle(cycleId: string, data: Record<string, any>) {
  await sql`
    UPDATE cycles SET
      status = ${data.status || "completed"},
      ceo_plan = ${JSON.stringify(data.ceo_plan) || null},
      ceo_review = ${JSON.stringify(data.ceo_review) || null},
      finished_at = now()
    WHERE id = ${cycleId}
  `;
}

async function checkAndHandleRunningCycles(companyId: string): Promise<boolean> {
  // Check for running cycles
  const [runningCycle] = await sql`
    SELECT id, cycle_number, started_at
    FROM cycles
    WHERE company_id = ${companyId} AND status = 'running'
    ORDER BY started_at DESC
    LIMIT 1
  `;

  if (!runningCycle) {
    return true; // No running cycles, safe to create new one
  }

  const startedAt = new Date(runningCycle.started_at);
  const now = new Date();
  const hoursRunning = (now.getTime() - startedAt.getTime()) / (1000 * 60 * 60);

  if (hoursRunning > 2) {
    console.log(`  ⚠ Cycle ${runningCycle.cycle_number} has been running for ${Math.round(hoursRunning * 10) / 10}h — marking as failed`);

    // Mark the stuck cycle as failed
    await sql`
      UPDATE cycles SET
        status = 'failed',
        finished_at = now()
      WHERE id = ${runningCycle.id}
    `;

    // Log this as an action for visibility
    await sql`
      INSERT INTO agent_actions (
        company_id, cycle_id, agent, action_type, description, status,
        error, started_at, finished_at
      ) VALUES (
        ${companyId}, ${runningCycle.id}, 'orchestrator', 'cycle_timeout',
        ${`Cycle ${runningCycle.cycle_number} timed out after ${Math.round(hoursRunning * 10) / 10}h`},
        'failed', 'Cycle exceeded 2-hour timeout limit', now(), now()
      )
    `;

    return true; // Stuck cycle cleaned up, safe to create new one
  }

  console.log(`  ⏳ Cycle ${runningCycle.cycle_number} still running (${Math.round(hoursRunning * 10) / 10}h) — skipping new cycle`);
  return false; // Cycle still running, don't create new one
}

async function logAction(data: {
  cycleId: string;
  companyId: string;
  agent: string;
  actionType: string;
  description: string;
  status: string;
  output?: any;
  error?: string;
  reflection?: string;
  retryCount?: number;
  tokensUsed?: number;
}) {
  await sql`
    INSERT INTO agent_actions (
      cycle_id, company_id, agent, action_type, description,
      status, output, error, reflection, retry_count, tokens_used,
      started_at, finished_at
    ) VALUES (
      ${data.cycleId}, ${data.companyId}, ${data.agent}, ${data.actionType},
      ${data.description}, ${data.status}, ${JSON.stringify(data.output) || null},
      ${data.error || null}, ${data.reflection || null}, ${data.retryCount || 0},
      ${data.tokensUsed || 0}, now(), now()
    )
  `;
}

async function getMetrics(companyId: string) {
  const rows = await sql`
    SELECT * FROM metrics 
    WHERE company_id = ${companyId} 
    ORDER BY date DESC LIMIT 7
  `;
  return rows;
}

async function getPlaybook(domain?: string) {
  if (domain) {
    return sql`SELECT * FROM playbook WHERE domain = ${domain} AND superseded_by IS NULL ORDER BY confidence DESC LIMIT 10`;
  }
  return sql`SELECT * FROM playbook WHERE superseded_by IS NULL ORDER BY confidence DESC LIMIT 20`;
}

async function getActivePrompt(agent: string, company?: { name: string; slug: string }) {
  const [row] = await sql`
    SELECT prompt_text FROM agent_prompts 
    WHERE agent = ${agent} AND is_active = true 
    LIMIT 1
  `;
  // DB-stored prompts (from Prompt Evolver) take priority over file-based prompts
  if (row?.prompt_text) {
    let text = row.prompt_text;
    if (company) {
      text = text.replace(/\{\{COMPANY_NAME\}\}/g, company.name);
      text = text.replace(/\{\{COMPANY_SLUG\}\}/g, company.slug);
    }
    return text;
  }
  return getDefaultPrompt(agent, company);
}

async function getDirectives(companyId?: string) {
  if (companyId) {
    return sql`
      SELECT * FROM directives 
      WHERE status = 'open' AND (company_id = ${companyId} OR company_id IS NULL)
      ORDER BY created_at ASC
    `;
  }
  return sql`SELECT * FROM directives WHERE status = 'open' ORDER BY created_at ASC`;
}

async function closeDirective(id: string, resolution: string) {
  await sql`
    UPDATE directives SET status = 'done', resolution = ${resolution}, resolved_at = now()
    WHERE id = ${id}
  `;
}

async function getPendingImports() {
  return sql`
    SELECT i.*, c.name, c.slug FROM imports i
    JOIN companies c ON c.id = i.company_id
    WHERE i.onboard_status = 'pending' AND i.scan_status = 'scanned'
  `;
}

async function createApproval(data: {
  companyId?: string;
  gateType: string;
  title: string;
  description: string;
  context?: any;
}) {
  await sql`
    INSERT INTO approvals (company_id, gate_type, title, description, context)
    VALUES (${data.companyId || null}, ${data.gateType}, ${data.title}, ${data.description}, ${JSON.stringify(data.context) || null})
  `;
}

async function getPendingApprovals() {
  return sql`SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at ASC`;
}

// === PROMPT LOADER (files > DB versions > fallback) ===
function getDefaultPrompt(agent: string, company?: { name: string; slug: string }): string {
  // Try loading from /prompts/{agent}.md first
  const promptPath = join(__dirname, "prompts", `${agent}.md`);
  if (existsSync(promptPath)) {
    let content = readFileSync(promptPath, "utf-8");
    // Template in company details
    if (company) {
      content = content.replace(/\{\{COMPANY_NAME\}\}/g, company.name);
      content = content.replace(/\{\{COMPANY_SLUG\}\}/g, company.slug);
    }
    return content;
  }

  // Fallback: minimal inline prompts (should never hit this in production)
  const fallbacks: Record<string, string> = {
    ceo: "You are the CEO agent. Evaluate metrics, set 2-3 priorities, review results. Output JSON with plan and review.",
    engineer: "You are the Engineer agent. Execute coding tasks from the CEO's plan. Push to GitHub, deploy via Vercel. Output JSON with tasks_completed.",
    growth: "You are the Growth agent. Create content, schedule posts, run experiments. Check the playbook first. Output JSON with content_created.",
    ops: "You are the Ops agent. Monitor infrastructure, fill metric gaps, verify deploys. Output JSON with health status.",
  };
  return fallbacks[agent] || "Execute the assigned task and return results as JSON.";
}

// === STRUCTURED HANDOFF PARSING ===
// Extracts and validates JSON handoffs from raw agent output.
// Falls back to null so consumers can degrade to raw strings.
function parseHandoff<T>(rawOutput: string, requiredKeys: string[]): T | null {
  const jsonMatch = rawOutput.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    // Unwrap common wrappers (agents often wrap in {plan: {...}} or {review: {...}})
    const unwrapped = parsed.plan || parsed.review || parsed;
    for (const key of requiredKeys) {
      if (!(key in unwrapped) && !(key in parsed)) {
        console.log(`    ⚠ Handoff missing key: ${key}`);
        return null;
      }
    }
    return parsed as T;
  } catch {
    return null;
  }
}

// === AGENT EXECUTION WITH RETRY + SELF-HEAL ===
async function executeAgent(opts: {
  agent: string;
  companyId: string;
  cycleId: string;
  prompt: string;
  context: string;
  cwd?: string;
  allowedTools?: string[];
  provider?: Provider;       // explicit provider override (e.g., "claude" for strategic Growth pre-spec)
}): Promise<{ success: boolean; output: string }> {
  let lastError = "";
  let lastOutput = "";

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      let fullPrompt: string;

      if (attempt === 1) {
        fullPrompt = `${opts.context}\n\n${opts.prompt}`;
      } else {
        // On retry: give the agent its previous error AND instructions to fix it
        fullPrompt = `${opts.context}\n\n${opts.prompt}

⚠ PREVIOUS ATTEMPT ${attempt - 1} FAILED:
Error: ${lastError}
${lastOutput ? `Last output (partial): ${lastOutput.slice(0, 500)}` : ""}

INSTRUCTIONS FOR THIS RETRY:
- Read the error carefully. It tells you exactly what went wrong.
- If it's a build error: find the file and line, fix the TypeScript/syntax issue.
- If it's a timeout: do less this cycle, focus on the most important task only.
- If it's a JSON parse error: your output wasn't valid JSON. Output ONLY JSON, no markdown.
- If it's a database error: check the schema — the column/table might not exist.
- Do NOT repeat the same approach. Change something specific based on the error.
- After making changes, verify with \`npm run build\` before committing.`;
      }

      const output = await dispatch({
        prompt: fullPrompt,
        cwd: opts.cwd,
        allowedTools: opts.allowedTools,
        agent: opts.agent, // routes to correct provider (claude/gemini/groq)
        provider: opts.provider, // explicit override (e.g., strategic tasks on free-tier agents)
        maxTurns: attempt === 1 ? 10 : 15,
        timeoutMs: attempt === 1 ? 5 * 60 * 1000 : 8 * 60 * 1000,
      });

      await logAction({
        cycleId: opts.cycleId,
        companyId: opts.companyId,
        agent: opts.agent,
        actionType: "cycle_task",
        description: output.slice(0, 200),
        status: "success",
        output: { raw: output },
        retryCount: attempt - 1,
      });

      return { success: true, output };

    } catch (error: any) {
      lastError = error.message;
      lastOutput = ""; // dispatch failed, no output

      await logAction({
        cycleId: opts.cycleId,
        companyId: opts.companyId,
        agent: opts.agent,
        actionType: "cycle_task",
        description: `Attempt ${attempt} failed: ${error.message.slice(0, 150)}`,
        status: "failed",
        error: error.message,
        retryCount: attempt,
      });

      console.log(`    ⚠ ${opts.agent} attempt ${attempt}/${MAX_RETRIES}: ${error.message.slice(0, 80)}`);

      // Final attempt: escalate
      if (attempt === MAX_RETRIES) {
        await createApproval({
          companyId: opts.companyId,
          gateType: "escalation",
          title: `${opts.agent} agent failed for ${opts.companyId}`,
          description: `Failed after ${MAX_RETRIES} attempts.\n\nLast error: ${error.message}\n\nThis needs manual investigation.`,
          context: { agent: opts.agent, lastError, attempts: MAX_RETRIES },
        });

        return { success: false, output: error.message };
      }
    }
  }

  return { success: false, output: "Max retries exceeded" };
}

// === NIGHTLY LOOP ===
async function runNightlyCycle() {
  const startTime = Date.now();
  console.log(`\n🐝 HIVE Orchestrator — ${new Date().toISOString()}`);
  console.log(`${"─".repeat(50)}`);

  // === PRE-FLIGHT HEALTH CHECK ===
  console.log("\n🔧 Pre-flight checks...");
  try {
    // Verify DB connection
    await sql`SELECT 1`;
    console.log("  ✓ Database connection");

    // Check for unresolved errors from last run
    const lastRunErrors = await sql`
      SELECT agent, description, error, company_id, finished_at
      FROM agent_actions 
      WHERE status = 'failed' AND started_at > now() - interval '48 hours'
      ORDER BY finished_at DESC LIMIT 20
    `;
    if (lastRunErrors.length > 0) {
      console.log(`  ⚠ ${lastRunErrors.length} errors from last 48h (self-healing will address after company cycles)`);
    } else {
      console.log("  ✓ No recent errors");
    }

    // Verify orchestrator can reach Claude CLI
    if (!DRY_RUN) {
      const cliOk = await new Promise<boolean>((resolve) => {
        const proc = spawn("claude", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
        const timer = setTimeout(() => { proc.kill(); resolve(false); }, 10000);
        proc.on("close", (code) => { clearTimeout(timer); resolve(code === 0); });
        proc.on("error", () => { clearTimeout(timer); resolve(false); });
      });
      if (!cliOk) { console.log("  ✗ Claude CLI not reachable — aborting"); return; }
      console.log("  ✓ Claude CLI reachable");
    }
  } catch (healthErr: any) {
    console.log(`  ✗ Pre-flight failed: ${healthErr.message}`);
    console.log("  Cannot proceed without database. Exiting.");
    return;
  }

  // Collect errors during this run for the self-healing cycle
  const runErrors: Array<{
    company: string;
    companyId: string;
    agent: string;
    error: string;
    phase: string;
  }> = [];

  // === IDEA SCOUT: Generate new business ideas ===
  // Runs when portfolio has fewer than 3 active/pending companies
  const MIN_PIPELINE_SIZE = 3; // target: always have 3 companies in pipeline (idea/approved/active)
  const MAX_ACTIVE_COMPANIES = 5;
  const allCompanies = await sql`SELECT id, slug, name, status, description FROM companies`;
  const pipelineCount = allCompanies.filter(c => ["idea", "approved", "provisioning", "mvp", "active"].includes(c.status)).length;
  const activeCount = allCompanies.filter(c => ["mvp", "active", "provisioning", "approved"].includes(c.status)).length;

  const shouldScout = FORCE_SCOUT || SCOUT_ONLY || (pipelineCount < MIN_PIPELINE_SIZE && activeCount < MAX_ACTIVE_COMPANIES && !SINGLE_COMPANY);

  if (shouldScout) {
    console.log("\n💡 Idea Scout — searching for opportunities");

    const playbook = await getPlaybook();
    const liveCompanies = allCompanies.filter(c => ["mvp", "active"].includes(c.status));

    // Query recently rejected/killed companies with kill_reason for feedback loop
    const recentlyRejected = await sql`
      SELECT name, slug, description, kill_reason, killed_at
      FROM companies
      WHERE status = 'killed' AND kill_reason IS NOT NULL AND killed_at > NOW() - INTERVAL '90 days'
      ORDER BY killed_at DESC LIMIT 10
    `;

    // Query rejected approvals for additional context on why ideas were turned down
    const rejectedApprovals = await sql`
      SELECT a.title, a.description, a.decision_note, a.decided_at
      FROM approvals a
      WHERE a.gate_type = 'new_company' AND a.status = 'rejected' AND a.decided_at > NOW() - INTERVAL '90 days'
      ORDER BY a.decided_at DESC LIMIT 10
    `;

    // Load Scout prompt from shared file + inject dynamic context
    const scoutPromptBase = readFileSync(join(__dirname, "prompts", "scout.md"), "utf-8");

    const dynamicContext = `
## DYNAMIC CONTEXT (injected at runtime — DO NOT ignore this section):

### Current portfolio (${liveCompanies.length} active):
${liveCompanies.map(c => `- ${c.name} (${c.slug}): ${c.description} [target audience: expats/freelancers/developers — infer from description]`).join("\n") || "No active companies yet"}

### EXISTING AND PAST COMPANIES (do NOT propose anything that overlaps):
${allCompanies.map(c => `- ${c.name} (${c.slug}): ${c.description || "no description"} [status: ${c.status}]`).join("\n") || "None"}

### PREVIOUSLY REJECTED IDEAS (learn from these — do NOT propose similar concepts):
${recentlyRejected.length > 0 ? recentlyRejected.map((c: any) => `- ${c.name}: ${c.description || "no description"} — Rejection reason: ${c.kill_reason}`).join("\n") : "None"}
${rejectedApprovals.length > 0 ? "\nRejected approvals with feedback:\n" + rejectedApprovals.map((a: any) => `- ${a.title}: ${a.decision_note || "no reason given"}`).join("\n") : ""}

### Playbook learnings (what works):
${playbook.slice(0, 10).map(p => `- [${p.domain}] ${p.insight} (confidence: ${p.confidence})`).join("\n") || "No playbook entries yet"}
`;

    const ideaScoutOutput = await dispatch({
      agent: "scout",
      prompt: scoutPromptBase + "\n" + dynamicContext,
      allowedTools: ["WebSearch", "WebFetch"],
      maxTurns: 50,
      timeoutMs: 25 * 60 * 1000,
    });

    // Debug logging for Idea Scout output
    console.log(`    Output length: ${ideaScoutOutput.length}`);
    console.log(`    Raw preview: ${ideaScoutOutput.slice(0, 300)}`);

    // Parse the output and create approval gate with all 3 proposals
    try {
      // Extract JSON from the output (Claude may wrap it in markdown)
      const jsonMatch = ideaScoutOutput.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const idea = JSON.parse(jsonMatch[0]);
        const proposals = idea.proposals || (idea.proposal ? [idea.proposal] : []);

        if (proposals.length > 0) {
          // Semantic similarity check — filter out proposals too similar to existing companies
          const getWords = (text: string): Set<string> => {
            if (!text) return new Set();
            return new Set(
              text.toLowerCase()
                .replace(/[^a-z0-9\s]/g, " ")
                .split(/\s+/)
                .filter(w => w.length > 2) // skip short words like "a", "to", "is"
            );
          };
          const wordOverlap = (a: Set<string>, b: Set<string>): number => {
            if (a.size === 0 || b.size === 0) return 0;
            let shared = 0;
            for (const w of a) { if (b.has(w)) shared++; }
            const minSize = Math.min(a.size, b.size);
            return minSize > 0 ? shared / minSize : 0;
          };

          const filteredProposals: Array<{ proposal: any; idx: number }> = [];
          for (let i = 0; i < proposals.length; i++) {
            const p = proposals[i];
            if (!p?.name || !p?.slug) continue;

            const proposalNameWords = getWords(p.name);
            const proposalDescWords = getWords(p.description || "");
            const proposalProblemWords = getWords(p.problem || "");
            const proposalSolutionWords = getWords(p.solution || "");
            // Combine all proposal text for broader matching
            const proposalAllWords = new Set([...proposalDescWords, ...proposalProblemWords, ...proposalSolutionWords]);

            let isDuplicate = false;
            for (const existing of allCompanies) {
              const existingNameWords = getWords(existing.name);
              const existingDescWords = getWords(existing.description || "");
              const existingAllWords = new Set([...existingNameWords, ...existingDescWords]);

              // Check name-to-name overlap
              const nameOverlap = wordOverlap(proposalNameWords, existingNameWords);
              // Check description/problem/solution overlap with existing description
              const descOverlap = wordOverlap(proposalAllWords, existingAllWords);

              if (nameOverlap > 0.5 || descOverlap > 0.5) {
                console.log(`  ⚠ Skipping '${p.name}' — too similar to existing '${existing.name}' (${existing.status})`);
                isDuplicate = true;
                break;
              }
            }

            if (!isDuplicate) {
              filteredProposals.push({ proposal: p, idx: i });
            }
          }

          // CEO Venture Evaluation — let CEO decide expand-vs-new for each proposal
          console.log("  ├─ CEO evaluating proposals (expand vs new)...");
          let ceoDecisions: Array<{ proposal_index: number; decision: string; expand_target?: string; expand_what?: string; question_for_carlos?: string; reasoning?: string }> = [];

          try {
            const ceoEvalOutput = await dispatch({
              agent: "ceo",
              prompt: `You are the Venture CEO. The Scout has researched ${filteredProposals.length} opportunities.

CURRENT PORTFOLIO:
${liveCompanies.map(c => `- ${c.name} (${c.slug}): ${c.description}`).join("\n") || "No active companies"}

ALL COMPANIES (including killed/idea):
${allCompanies.map(c => `- ${c.name} (${c.slug}): ${c.description || "no description"} [${c.status}]`).join("\n")}

SCOUT PROPOSALS:
${filteredProposals.map(({ proposal: p }, i) => `\n### Proposal ${i}: ${p.name}\n${JSON.stringify(p, null, 2)}`).join("\n")}

Read prompts/ceo.md section "Venture Evaluation mode" for your decision framework and output format.
For each proposal, decide: new_company, expansion, or question. Output JSON with a "decisions" array.`,
              timeoutMs: 5 * 60 * 1000,
            });

            const parsed = parseHandoff<{ decisions: any[] }>(ceoEvalOutput, ["decisions"]);
            if (parsed?.decisions) {
              ceoDecisions = parsed.decisions;
            }
          } catch (e: any) {
            console.log(`    ⚠ CEO evaluation failed: ${e.message.slice(0, 80)} — defaulting all to new_company`);
          }

          // Process proposals using CEO decisions (fallback: new_company for all)
          let proposalCount = 0;

          for (let i = 0; i < filteredProposals.length; i++) {
            const { proposal: p } = filteredProposals[i];
            const ceoDec = ceoDecisions.find(d => d.proposal_index === i);
            const decision = ceoDec?.decision || "new_company";
            const marketTag = (p.market === "Portugal" || p.market === "pt") ? "🇵🇹 PT" : "🌍 Global";
            const num = i + 1;

            if (decision === "expansion" || decision === "question") {
              // EXPANSION or QUESTION — create growth_strategy approval on the existing company
              const targetSlug = ceoDec?.expand_target || p.expansion_candidate?.target_slug;
              let targetCompanyId: string | null = null;
              if (targetSlug) {
                const [target] = await sql`SELECT id FROM companies WHERE slug = ${targetSlug}`;
                targetCompanyId = target?.id || null;
              }

              const typeLabel = decision === "question" ? "❓ Question" : "📈 Expand";
              const expandWhat = ceoDec?.expand_what || p.expansion_candidate?.what_to_add || p.name;
              const title = decision === "question"
                ? `${typeLabel}: ${p.name} — standalone or expand ${targetSlug}?`
                : `${typeLabel}: Add ${expandWhat} to ${targetSlug} [${marketTag}]`;

              await sql`
                INSERT INTO approvals (company_id, gate_type, title, description, context)
                VALUES (
                  ${targetCompanyId},
                  'growth_strategy',
                  ${title},
                  ${`**${p.description}**\n\n` +
                    `**What to add:** ${expandWhat}\n` +
                    (ceoDec?.question_for_carlos ? `\n**Decision needed:**\n${ceoDec.question_for_carlos}\n\n` : "") +
                    `**CEO reasoning:** ${ceoDec?.reasoning || "N/A"}\n` +
                    `**Market:** ${p.market || "Global"}\n` +
                    `**Problem:** ${p.problem}\n` +
                    `**Solution:** ${p.solution}\n` +
                    `**Monetisation:** ${p.monetisation}\n` +
                    `**MVP scope:** ${p.mvp_scope}\n` +
                    `**Confidence:** ${Math.round((p.confidence || 0.5) * 100)}%`},
                  ${JSON.stringify({ proposal: p, ceo_decision: ceoDec, all_proposals: proposals, research: idea.research })}
                )
              `;
              console.log(`    ${num}. ${typeLabel} ${p.name} → ${targetSlug || "unknown"} [${p.market || "Global"}] — ${Math.round((p.confidence || 0.5) * 100)}%`);
              proposalCount++;

            } else {
              // NEW COMPANY — create company in 'idea' status + new_company approval
              if (!p.slug) continue;
              const [newCompany] = await sql`
                INSERT INTO companies (name, slug, description, status)
                VALUES (${p.name}, ${p.slug}, ${p.description}, 'idea')
                ON CONFLICT (slug) DO NOTHING
                RETURNING *
              `;
              if (newCompany) {
                await sql`
                  INSERT INTO approvals (company_id, gate_type, title, description, context)
                  VALUES (
                    ${newCompany.id},
                    'new_company',
                    ${"🆕 Launch " + p.name + " [" + marketTag + "]"},
                    ${`**${p.description}**\n\n` +
                      `**Model:** ${p.business_model || "saas"}\n` +
                      `**CEO reasoning:** ${ceoDec?.reasoning || "N/A"}\n` +
                      `**Market:** ${p.market || "Global"}\n` +
                      `**Problem:** ${p.problem}\n` +
                      `**Solution:** ${p.solution}\n` +
                      `**Monetisation:** ${p.monetisation}\n` +
                      `**MVP scope:** ${p.mvp_scope}\n` +
                      `**Confidence:** ${Math.round((p.confidence || 0.5) * 100)}%`},
                    ${JSON.stringify({ proposal: p, ceo_decision: ceoDec, all_proposals: proposals, research: idea.research })}
                  )
                `;
                console.log(`    ${num}. 🆕 ${p.name} (${p.slug}) [${p.market || "Global"}] — ${Math.round((p.confidence || 0.5) * 100)}%`);
                proposalCount++;
              }
            }
          }

          if (proposalCount > 0) {
            console.log(`  ✓ ${proposalCount} proposals created — awaiting approval`);
            // Log the action
            const summary = filteredProposals.map(({ proposal: p }) => {
              const type = p.proposal_type === "expansion" ? "📈" : p.proposal_type === "question" ? "❓" : "🆕";
              return `${type} ${p.name} [${p.market || "Global"}]`;
            }).join(", ");
            await sql`
              INSERT INTO agent_actions (company_id, agent, action_type, description, status, output, started_at, finished_at)
              VALUES (${null}, 'scout', 'generate_ideas', ${`Proposed ${proposalCount}: ${summary}`}, 'success', ${JSON.stringify(idea)}, now(), now())
            `;
          } else {
            console.log(`  ⓘ All proposed slugs already exist — skipping`);
          }
        }
      }
    } catch (e: any) {
      console.log(`  ⚠ Failed to parse Idea Scout output: ${e.message}`);
      // Still log the raw output so it's not lost
      await sql`
        INSERT INTO agent_actions (company_id, agent, action_type, description, status, error, output, started_at, finished_at)
        VALUES (${null}, 'scout', 'generate_ideas', 'Failed to parse idea proposals', 'failed', ${e.message}, ${JSON.stringify({ raw: ideaScoutOutput })}, now(), now())
      `;
    }
  } else if (!SINGLE_COMPANY) {
    const reason = pipelineCount >= MIN_PIPELINE_SIZE ? `pipeline full (${pipelineCount} companies in idea/active states)` : 
                   activeCount >= MAX_ACTIVE_COMPANIES ? `at capacity (${activeCount}/${MAX_ACTIVE_COMPANIES})` :
                   "unknown";
    console.log(`\n💡 Idea Scout — skipped (${reason})`);
  }

  // If scout-only mode, exit before company processing
  if (SCOUT_ONLY) {
    const totalDuration = Math.round((Date.now() - startTime) / 1000);
    console.log(`\n🐝 Scout-only run complete in ${totalDuration}s`);
    return;
  }

  // === PROVISION APPROVED COMPANIES (before cycles — get them into the pipeline ASAP) ===
  const approvedCompanies = await sql`SELECT * FROM companies WHERE status = 'approved'`;
  if (approvedCompanies.length > 0) {
    console.log(`\n🔧 Provisioning ${approvedCompanies.length} approved companies`);
    for (const company of approvedCompanies) {
      console.log(`  ▸ Provisioning ${company.name}...`);
      await sql`UPDATE companies SET status = 'provisioning', updated_at = now() WHERE id = ${company.id}`;

      // Gather cross-company learnings to inject into the new company's CLAUDE.md
      const playbookEntries = await sql`
        SELECT p.domain, p.insight, c.slug as source_company, p.confidence
        FROM playbook p LEFT JOIN companies c ON c.id = p.source_company_id
        WHERE p.superseded_by IS NULL AND p.confidence >= 0.6
        ORDER BY p.confidence DESC LIMIT 30
      `;
      const playbookSection = playbookEntries.length > 0
        ? `\n## Inherited Playbook (from Hive portfolio)\n\nThese learnings were extracted from other Hive companies. Apply them where relevant.\n\n${
            playbookEntries.map((p: any) => 
              `- **[${p.domain}]** ${p.insight}${p.source_company ? ` _(from ${p.source_company})_` : ""} — confidence: ${p.confidence}`
            ).join("\n")
          }\n`
        : "";

      // Gather common error patterns to warn about
      const commonErrors = await sql`
        SELECT agent, error, COUNT(*) as cnt
        FROM agent_actions
        WHERE status = 'failed' AND started_at > now() - interval '30 days'
        GROUP BY agent, error
        HAVING COUNT(*) >= 2
        ORDER BY cnt DESC LIMIT 10
      `;
      const pitfallsSection = commonErrors.length > 0
        ? `\n## Known Pitfalls (from Hive history)\n\nThese errors have occurred in other companies. Avoid them.\n\n${
            commonErrors.map((e: any) => `- **[${e.agent}]** ${(e.error || "").slice(0, 150)} _(${e.cnt}x)_`).join("\n")
          }\n`
        : "";

      try {
        await dispatch({
          prompt: `You are the Provisioner agent. Set up infrastructure for a new Hive company.

Company: ${company.name} (${company.slug})
Description: ${company.description}

Execute these steps using the APIs available to you:
1. Create GitHub repo: carlos-miranda/${company.slug} (use GitHub API)
2. Push the boilerplate template from templates/boilerplate/ (replace {{SLUG}}, {{COMPANY_NAME}}, {{DESCRIPTION}} placeholders)
3. Generate a CLAUDE.md from templates/company-claude.md with the company details filled in
4. **IMPORTANT:** Append these sections to the generated CLAUDE.md:
${playbookSection || "   (No playbook entries yet — skip this step)"}
${pitfallsSection || "   (No known pitfalls yet — skip this step)"}
5. Create Neon project: hive-${company.slug} (use Neon API)
6. Create Vercel project linked to the GitHub repo (use Vercel API)
7. Set environment variables in Vercel: DATABASE_URL, STRIPE_SECRET_KEY, NEXT_PUBLIC_URL, NEXT_PUBLIC_LAUNCH_MODE=waitlist, LAUNCH_MODE=waitlist
8. Create a Stripe product + price tagged with hive_company: ${company.slug}
9. Seed default email sequences in the company's DB:
   - waitlist_welcome (step 1): subject "You're #{{POSITION}} on the {{COMPANY_NAME}} waitlist", body with position confirmation + referral link
   - onboarding_d1 (step 1, delay 0h): subject "Welcome to {{COMPANY_NAME}}", body with getting started guide
   - onboarding_d3 (step 1, delay 72h): subject "3 tips to get more from {{COMPANY_NAME}}", body with product tips
   - onboarding_d7 (step 1, delay 168h): subject "How's it going with {{COMPANY_NAME}}?", body with value reminder + feedback ask
10. Record all resource IDs in the infra table via the Hive API
11. Update company status to 'mvp' and set vercel_url
12. Write the capability inventory to the companies table:
    UPDATE companies SET capabilities = '{
      "database": {"exists": true, "provider": "neon", "connection_verified": true},
      "hosting": {"exists": true, "provider": "vercel", "url": "https://${company.slug}.vercel.app"},
      "repo": {"exists": true, "provider": "github", "url": "https://github.com/carlos-miranda/${company.slug}", "framework": "nextjs"},
      "stripe": {"exists": true, "configured": false, "has_products": false, "has_customers": false},
      "auth": {"exists": true, "provider": "custom"},
      "email_provider": {"exists": true, "provider": "resend", "configured": false},
      "email_sequences": {"exists": true, "count": 4},
      "email_log": {"exists": true},
      "resend_webhook": {"exists": true},
      "waitlist": {"exists": true, "has_entries": false, "total": 0, "makes_sense": true},
      "referral_mechanics": {"exists": true, "makes_sense": true},
      "gsc_integration": {"exists": false, "configured": false},
      "visibility_metrics": {"exists": true},
      "indexnow": {"exists": false, "configured": false},
      "llms_txt": {"exists": true},
      "sitemap": {"exists": true},
      "json_ld": {"exists": true},
      "launch_mode": {"value": "waitlist"}
    }'::jsonb, last_assessed_at = NOW()
    WHERE slug = '${company.slug}'

Report what was created and any issues encountered.`,
          cwd: `/Users/carlos.miranda/Documents/Github/hive`,
          timeoutMs: 10 * 60 * 1000,
        });

        const [check] = await sql`SELECT status FROM companies WHERE id = ${company.id}`;
        if (check?.status === "provisioning") {
          await sql`UPDATE companies SET status = 'mvp', updated_at = now() WHERE id = ${company.id}`;
          console.log(`  ⚠ Provisioner didn't update status — forced to mvp`);
        }
        console.log(`  ✓ ${company.name} provisioned`);
      } catch (provErr: any) {
        console.log(`  ✗ Provisioning failed: ${provErr.message}`);
        await sql`UPDATE companies SET status = 'approved', updated_at = now() WHERE id = ${company.id}`;
        try {
          await sql`
            INSERT INTO agent_actions (company_id, agent, action_type, description, status, error, started_at, finished_at)
            VALUES (${company.id}, 'provisioner', 'provision_company', ${`Failed: ${provErr.message}`}, 'failed', ${provErr.message}, now(), now())
          `;
        } catch {}
      }
    }
  }

  // === ONBOARD IMPORTED PROJECTS (before cycles — prioritized over regular processing) ===
  const pendingImports = await getPendingImports();
  if (pendingImports.length > 0) {
    console.log(`\n📥 Onboarding ${pendingImports.length} imported projects`);
    for (const imp of pendingImports) {
      console.log(`  ▸ Onboarding ${imp.name}...`);
      await sql`UPDATE imports SET onboard_status = 'in_progress' WHERE id = ${imp.id}`;

      const scanReport = imp.scan_report || {};
      const companyCwd = `/Users/carlos.miranda/Documents/Github/${imp.slug}`;
      const importReport: ImportReport = {
        company: imp.name,
        slug: imp.slug,
        phases_completed: [],
        content_absorbed: { guides: 0, tools: 0, pages: 0, total_content_items: 0 },
        queue_items_absorbed: { directives_created: 0, approvals_created: 0, items: [] },
        legacy_agents_found: [],
        playbook_entries_created: 0,
        manual_actions_required: [],
        recommendations: [],
        warnings: [],
      };

      // === Phase 1: Infrastructure hookup ===
      try {
        await dispatch({
          prompt: `You are the Onboarding agent. An existing project is being imported into Hive.

Project: ${imp.name} (${imp.slug})
Git URL: ${imp.git_url}
Scan Report: ${JSON.stringify(scanReport, null, 2)}

Tasks:
1. Clone or pull the latest from the git repo
2. Analyze the tech stack, deployment config, and current state
3. Update the company record with: vercel_url, description, any detected metrics
4. Set up any missing Hive integrations (Stripe tags, webhooks, etc.)
5. Report what you found and what you set up.`,
          cwd: companyCwd,
        });
        importReport.phases_completed.push("infrastructure");
        console.log(`  ├─ ✓ Phase 1: Infrastructure hookup`);
      } catch (e: any) {
        console.log(`  ├─ ⚠ Phase 1 failed: ${e.message.slice(0, 80)}`);
        importReport.warnings.push(`Phase 1 (infrastructure) failed: ${e.message.slice(0, 200)}`);
      }

      // === Phase 2: Pattern extraction (via Claude) ===
      try {
        console.log(`  ├─ Extracting patterns from ${imp.name}...`);
        await dispatch({
          prompt: `You are the Pattern Extraction agent. Analyze this imported codebase to find reusable learnings.

Project: ${imp.name} (${imp.slug})
Scan Report: ${JSON.stringify(scanReport, null, 2)}

Read the actual code and extract patterns that would benefit other Hive companies.
Look for: checkout/pricing patterns, email templates, onboarding flows, SEO structure, tech patterns.

For each pattern, write to the playbook table via the Hive API:
POST ${HIVE_API}/playbook with { domain, insight, source_company_id: "${imp.company_id}", confidence }

Confidence: 0.8-1.0 = proven with results, 0.5-0.7 = reasonable but untested.`,
          cwd: companyCwd,
        });
        importReport.phases_completed.push("pattern_extraction");
        console.log(`  ├─ ✓ Phase 2: Pattern extraction`);
      } catch (e: any) {
        console.log(`  ├─ ⚠ Phase 2 failed: ${e.message.slice(0, 80)}`);
        importReport.warnings.push(`Phase 2 (pattern extraction) failed: ${e.message.slice(0, 200)}`);
      }

      // === Phase 3: Knowledge assimilation (MD files + Claude memory) ===
      try {
        console.log(`  ├─ Assimilating institutional knowledge...`);
        const mdFiles: string[] = [];
        const claudeMemDir = join(process.env.HOME || "", `.claude/projects/-Users-carlos-miranda-Documents-Github-${imp.slug}/memory`);

        for (const fname of ["CLAUDE.md", "MISTAKES.md", "DECISIONS.md", "BACKLOG.md", "MEMORY.md", "PROGRESS.md"]) {
          const fpath = join(companyCwd, fname);
          if (existsSync(fpath)) {
            const content = readFileSync(fpath, "utf-8");
            if (content.trim()) mdFiles.push(`=== ${fname} ===\n${content.slice(0, 3000)}`);
          }
        }

        if (existsSync(claudeMemDir)) {
          try {
            const { readdirSync } = await import("fs");
            for (const f of readdirSync(claudeMemDir).filter(f => f.endsWith(".md"))) {
              const content = readFileSync(join(claudeMemDir, f), "utf-8");
              if (content.trim()) mdFiles.push(`=== claude-memory/${f} ===\n${content.slice(0, 1500)}`);
            }
          } catch {}
        }

        if (mdFiles.length > 0) {
          const hivePlaybook = await getPlaybook();
          await dispatch({
            agent: "ceo",
            prompt: `You are assimilating knowledge from an imported company into Hive.

## Source: ${imp.name} (${imp.slug})
${mdFiles.join("\n\n")}

## Hive's current playbook (top 20):
${hivePlaybook.map((p: any) => `- [${p.domain}] ${p.insight}`).join("\n") || "Empty"}

Compare the imported company's knowledge against Hive's existing knowledge.
For each NEW learning (not already captured), write to playbook via API.
Do NOT duplicate what Hive already knows. Only add genuinely new insights.
Output a brief summary of what was assimilated.`,
            timeoutMs: 5 * 60 * 1000,
          });
          console.log(`    ✓ Assimilated from ${mdFiles.length} knowledge files`);
        }
        importReport.phases_completed.push("knowledge_assimilation");
      } catch (e: any) {
        console.log(`  ├─ ⚠ Phase 3 failed: ${e.message.slice(0, 80)}`);
        importReport.warnings.push(`Phase 3 (knowledge assimilation) failed: ${e.message.slice(0, 200)}`);
      }

      // === Phase 4: Legacy agent absorption (direct file parsing, no Claude needed) ===
      console.log(`  ├─ Absorbing legacy agent state...`);
      try {
        const { readdirSync } = await import("fs");

        // 4a: Absorb agent queue items → Hive directives + approval gates
        const queueDir = join(companyCwd, ".github", "agent-queue");
        if (existsSync(queueDir)) {
          const queueFiles = readdirSync(queueDir).filter(f => f.endsWith(".json"));
          console.log(`    📋 Found ${queueFiles.length} legacy queue items`);

          for (const file of queueFiles) {
            try {
              const raw = readFileSync(join(queueDir, file), "utf-8");
              const item = JSON.parse(raw);

              // Determine if this is a Carlos action or an agent task
              const isCarlosAction = item.needs_carlos === true || 
                item.type === "needs_carlos" ||
                item.assigned_to === "carlos" ||
                file.startsWith("carlos-");
              const title = item.title || item.detail || item.description || file.replace(".json", "").replace(/-/g, " ");
              const detail = item.detail || item.description || item.context || JSON.stringify(item, null, 2);
              const priority = item.priority || "medium";

              if (isCarlosAction) {
                // Manual tasks → approval gates so they show in the dashboard
                await sql`
                  INSERT INTO approvals (company_id, gate_type, title, description, context)
                  VALUES (
                    ${imp.company_id}, 'escalation',
                    ${`[Import] ${title}`},
                    ${`**From legacy agent queue (${file}):**\n\n${typeof detail === "string" ? detail : JSON.stringify(detail, null, 2)}\n\n**Priority:** ${priority}\n**Source:** Legacy agent system, absorbed during Hive import`},
                    ${JSON.stringify({ source: "legacy_import", file, priority, original: item })}
                  )
                `;
                importReport.queue_items_absorbed.approvals_created++;
                importReport.queue_items_absorbed.items.push({ file, type: "approval", title, priority });
                importReport.manual_actions_required.push({
                  title,
                  detail: typeof detail === "string" ? detail.slice(0, 300) : title,
                  priority,
                  source: file,
                });
              } else {
                // Agent tasks → directives (CEO picks them up next cycle)
                await sql`
                  INSERT INTO directives (company_id, text, status)
                  VALUES (
                    ${imp.company_id},
                    ${`[legacy-import] ${title}: ${typeof detail === "string" ? detail.slice(0, 500) : JSON.stringify(detail).slice(0, 500)}`},
                    'open'
                  )
                `;
                importReport.queue_items_absorbed.directives_created++;
                importReport.queue_items_absorbed.items.push({ file, type: "directive", title, priority });
              }
            } catch (parseErr: any) {
              console.log(`      ⚠ Failed to parse ${file}: ${parseErr.message.slice(0, 60)}`);
              importReport.warnings.push(`Failed to parse queue item ${file}: ${parseErr.message.slice(0, 100)}`);
            }
          }
          console.log(`    ✓ Absorbed: ${importReport.queue_items_absorbed.directives_created} directives, ${importReport.queue_items_absorbed.approvals_created} approval gates`);
        } else {
          console.log(`    ⓘ No .github/agent-queue/ found`);
        }

        // 4b: Absorb agent memory files → playbook entries + research_reports
        const memoryDir = join(companyCwd, ".github", "agent-memory");
        if (existsSync(memoryDir)) {
          const memFiles = readdirSync(memoryDir).filter(f => f.endsWith(".json"));
          console.log(`    🧠 Found ${memFiles.length} legacy agent memory files`);

          for (const file of memFiles) {
            try {
              const raw = readFileSync(join(memoryDir, file), "utf-8");
              const mem = JSON.parse(raw);
              const agentName = file.replace("-agent.json", "").replace(".json", "");
              importReport.legacy_agents_found.push({ name: agentName, file, session_count: mem.session_count || 0 });

              // Extract content inventory if present (SEO agent tracks this)
              if (mem.content_library || mem.guides || mem.content_items || mem.pages) {
                const guides = mem.content_library?.guides || mem.guides || [];
                const tools = mem.content_library?.tools || mem.tools || [];
                const pages = mem.pages || [];
                importReport.content_absorbed.guides = guides.length || 0;
                importReport.content_absorbed.tools = tools.length || 0;
                importReport.content_absorbed.pages = pages.length || 0;
                importReport.content_absorbed.total_content_items = (guides.length || 0) + (tools.length || 0) + (pages.length || 0);

                // Store as content_inventory research report
                await sql`
                  INSERT INTO research_reports (company_id, report_type, content, summary)
                  VALUES (${imp.company_id}, 'market_research', 
                    ${JSON.stringify({ 
                      source: "legacy_import", 
                      content_library: mem.content_library || { guides, tools, pages },
                      seo_state: mem.seo_state || mem.indexing || null,
                      backlinks: mem.backlinks || mem.backlink_prs || null,
                    })},
                    ${`Imported from legacy ${agentName}: ${guides.length} guides, ${tools.length} tools, ${pages.length} pages`}
                  )
                  ON CONFLICT (company_id, report_type) DO UPDATE SET
                    content = research_reports.content || ${JSON.stringify({ legacy_import: { guides: guides.length, tools: tools.length, pages: pages.length } })},
                    summary = ${`Updated: ${guides.length} guides, ${tools.length} tools from legacy import`},
                    updated_at = now()
                `;
              }

              // Extract keyword/SEO data if present
              if (mem.keywords || mem.seo_keywords || mem.keyword_tracking) {
                const keywords = mem.keywords || mem.seo_keywords || mem.keyword_tracking || [];
                await sql`
                  INSERT INTO research_reports (company_id, report_type, content, summary)
                  VALUES (${imp.company_id}, 'seo_keywords',
                    ${JSON.stringify({ source: "legacy_import", keywords, imported_from: agentName })},
                    ${`${Array.isArray(keywords) ? keywords.length : Object.keys(keywords).length} keywords from legacy ${agentName}`}
                  )
                  ON CONFLICT (company_id, report_type) DO UPDATE SET
                    content = ${JSON.stringify({ source: "legacy_import", keywords, imported_from: agentName })},
                    updated_at = now()
                `;
              }

              // Extract competitive intelligence if present
              if (mem.competitors || mem.competitive_landscape) {
                await sql`
                  INSERT INTO research_reports (company_id, report_type, content, summary)
                  VALUES (${imp.company_id}, 'competitive_analysis',
                    ${JSON.stringify({ source: "legacy_import", ...(mem.competitors || mem.competitive_landscape) })},
                    ${`Competitive data from legacy ${agentName}`}
                  )
                  ON CONFLICT (company_id, report_type) DO UPDATE SET
                    content = ${JSON.stringify({ source: "legacy_import", ...(mem.competitors || mem.competitive_landscape) })},
                    updated_at = now()
                `;
              }

              // Extract lead/outreach data if present
              if (mem.leads || mem.outreach || mem.lead_list) {
                await sql`
                  INSERT INTO research_reports (company_id, report_type, content, summary)
                  VALUES (${imp.company_id}, 'lead_list',
                    ${JSON.stringify({ source: "legacy_import", leads: mem.leads || mem.lead_list || [], outreach: mem.outreach || null })},
                    ${`Lead data from legacy ${agentName}`}
                  )
                  ON CONFLICT (company_id, report_type) DO UPDATE SET
                    content = ${JSON.stringify({ source: "legacy_import", leads: mem.leads || mem.lead_list || [] })},
                    updated_at = now()
                `;
              }

              // Write a playbook entry for each legacy agent's accumulated learnings
              if (mem.learnings || mem.discoveries || mem.insights) {
                const learnings = mem.learnings || mem.discoveries || mem.insights;
                const entries = Array.isArray(learnings) ? learnings : [learnings];
                for (const learning of entries.slice(0, 10)) {
                  const insight = typeof learning === "string" ? learning : (learning.insight || learning.description || JSON.stringify(learning));
                  if (insight && insight.length > 10) {
                    await sql`
                      INSERT INTO playbook (source_company_id, domain, insight, confidence, evidence)
                      VALUES (${imp.company_id}, ${agentName === "seo" ? "seo" : agentName === "growth" ? "growth" : "general"},
                        ${`[${imp.slug}] ${insight.slice(0, 500)}`}, 0.7,
                        ${JSON.stringify({ source: "legacy_import", agent: agentName })})
                    `;
                    importReport.playbook_entries_created++;
                  }
                }
              }

            } catch (parseErr: any) {
              console.log(`      ⚠ Failed to parse ${file}: ${parseErr.message.slice(0, 60)}`);
            }
          }
          console.log(`    ✓ Legacy agents absorbed: ${importReport.legacy_agents_found.map(a => `${a.name}(${a.session_count} sessions)`).join(", ")}`);
        } else {
          console.log(`    ⓘ No .github/agent-memory/ found`);
        }

        // 4c: Detect content state from live site (count pages, check for common issues)
        const vercelUrl = scanReport.vercel_url || (await sql`SELECT vercel_url FROM companies WHERE id = ${imp.company_id}`)[0]?.vercel_url;
        if (vercelUrl) {
          // Check if GSC is configured (common blocker)
          importReport.manual_actions_required.push({
            title: `Verify Google Search Console for ${imp.name}`,
            detail: `Go to search.google.com/search-console → Add Property → URL prefix → ${vercelUrl}. Without GSC, all SEO content is invisible to Google.`,
            priority: "high",
            source: "import_analysis",
          });
          // Check if sitemap exists
          importReport.recommendations.push(`Verify sitemap.xml is accessible at ${vercelUrl}/sitemap.xml`);
        }

        // 4d: Add recommendation to kill legacy agents
        if (importReport.legacy_agents_found.length > 0) {
          importReport.manual_actions_required.push({
            title: `Unload legacy LaunchAgents for ${imp.name}`,
            detail: `Legacy agents (${importReport.legacy_agents_found.map(a => a.name).join(", ")}) are still running via launchd. ` +
              `Hive's worker dispatch now handles Growth, Outreach, and Ops. Unload them:\n` +
              importReport.legacy_agents_found.map(a => 
                `  launchctl unload ~/Library/LaunchAgents/com.founder.${a.name}.plist`
              ).join("\n") +
              `\n\nKeep the plist files as backup — just unload so they stop running.`,
            priority: "medium",
            source: "import_analysis",
          });
        }

        importReport.phases_completed.push("legacy_absorption");
      } catch (e: any) {
        console.log(`  ├─ ⚠ Phase 4 failed: ${e.message.slice(0, 80)}`);
        importReport.warnings.push(`Phase 4 (legacy absorption) failed: ${e.message.slice(0, 200)}`);
      }

      // === Phase 5: Generate Import Report ===
      console.log(`  ├─ Generating import report...`);
      try {
        // Build the report description
        const reportLines: string[] = [];
        reportLines.push(`# Import Report: ${imp.name} (${imp.slug})`);
        reportLines.push(`**Imported:** ${new Date().toISOString().split("T")[0]}`);
        reportLines.push(`**Phases completed:** ${importReport.phases_completed.join(" → ")}`);
        reportLines.push("");

        if (importReport.content_absorbed.total_content_items > 0) {
          reportLines.push(`## Content absorbed`);
          reportLines.push(`- ${importReport.content_absorbed.guides} SEO guides`);
          reportLines.push(`- ${importReport.content_absorbed.tools} interactive tools`);
          reportLines.push(`- ${importReport.content_absorbed.pages} total pages`);
          reportLines.push("");
        }

        if (importReport.legacy_agents_found.length > 0) {
          reportLines.push(`## Legacy agents found`);
          for (const agent of importReport.legacy_agents_found) {
            reportLines.push(`- **${agent.name}** — ${agent.session_count} sessions (${agent.file})`);
          }
          reportLines.push("");
        }

        if (importReport.queue_items_absorbed.items.length > 0) {
          reportLines.push(`## Queue items absorbed (${importReport.queue_items_absorbed.items.length} total)`);
          reportLines.push(`- ${importReport.queue_items_absorbed.directives_created} → Hive directives (agent will pick up)`);
          reportLines.push(`- ${importReport.queue_items_absorbed.approvals_created} → approval gates (needs your action)`);
          for (const item of importReport.queue_items_absorbed.items) {
            reportLines.push(`  - [${item.type}] ${item.title} _(${item.priority})_`);
          }
          reportLines.push("");
        }

        if (importReport.playbook_entries_created > 0) {
          reportLines.push(`## Playbook entries: ${importReport.playbook_entries_created} new learnings added`);
          reportLines.push("");
        }

        if (importReport.manual_actions_required.length > 0) {
          reportLines.push(`## ⚠ Manual actions required`);
          for (const action of importReport.manual_actions_required) {
            reportLines.push(`### ${action.priority === "high" ? "🔴" : "🟡"} ${action.title}`);
            reportLines.push(action.detail);
            reportLines.push("");
          }
        }

        if (importReport.recommendations.length > 0) {
          reportLines.push(`## Recommendations`);
          for (const rec of importReport.recommendations) {
            reportLines.push(`- ${rec}`);
          }
          reportLines.push("");
        }

        if (importReport.warnings.length > 0) {
          reportLines.push(`## Warnings during import`);
          for (const w of importReport.warnings) {
            reportLines.push(`- ⚠ ${w}`);
          }
          reportLines.push("");
        }

        reportLines.push(`---`);
        reportLines.push(`*Hive will run its first cycle on ${imp.name} during the next nightly loop. The CEO agent will incorporate the absorbed directives and research data automatically.*`);

        const reportText = reportLines.join("\n");

        // Create a high-visibility approval gate with the full import report
        await sql`
          INSERT INTO approvals (company_id, gate_type, title, description, context)
          VALUES (
            ${imp.company_id}, 'new_company',
            ${`📋 Import Report: ${imp.name} — ${importReport.manual_actions_required.length} action(s) needed`},
            ${reportText},
            ${JSON.stringify(importReport)}
          )
        `;

        // Also log the import action
        await sql`
          INSERT INTO agent_actions (company_id, agent, action_type, description, status, output, started_at, finished_at)
          VALUES (${imp.company_id}, 'orchestrator', 'import_complete',
            ${`Imported ${imp.name}: ${importReport.phases_completed.length} phases, ${importReport.queue_items_absorbed.items.length} queue items, ${importReport.manual_actions_required.length} manual actions`},
            'success', ${JSON.stringify(importReport)}, now(), now())
        `;

        // Send digest-style email if configured
        const resendKey = await getSettingValueDirect("resend_api_key");
        const digestTo = await getSettingValueDirect("digest_email");
        if (resendKey && digestTo) {
          const sendingDomain = await getSettingValueDirect("sending_domain");
          const digestFrom = sendingDomain ? `Hive <digest@${sendingDomain}>` : "Hive <onboarding@resend.dev>";
          try {
            await fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                from: digestFrom,
                to: digestTo,
                subject: `🐝 Hive Import: ${imp.name} — ${importReport.manual_actions_required.length} action(s) needed`,
                html: `<div style="max-width:600px;margin:0 auto;padding:24px;font-family:system-ui;color:#333;background:#fafafa">
                  <h1 style="color:#e8b84d;font-size:20px">Import Report: ${imp.name}</h1>
                  <p><strong>${importReport.phases_completed.length}</strong> phases completed • 
                     <strong>${importReport.queue_items_absorbed.items.length}</strong> queue items absorbed • 
                     <strong>${importReport.playbook_entries_created}</strong> playbook entries</p>
                  ${importReport.content_absorbed.total_content_items > 0 ? 
                    `<p>📚 Content: ${importReport.content_absorbed.guides} guides, ${importReport.content_absorbed.tools} tools, ${importReport.content_absorbed.pages} pages</p>` : ""}
                  ${importReport.manual_actions_required.length > 0 ? 
                    `<h2 style="color:#e85050;font-size:16px">⚠ ${importReport.manual_actions_required.length} manual action(s) required</h2>
                     <ul>${importReport.manual_actions_required.map(a => 
                       `<li><strong>${a.title}</strong><br><span style="color:#666;font-size:13px">${a.detail.slice(0, 200)}</span></li>`
                     ).join("")}</ul>` : ""}
                  ${importReport.legacy_agents_found.length > 0 ?
                    `<p style="color:#666;font-size:13px">Legacy agents found: ${importReport.legacy_agents_found.map(a => `${a.name} (${a.session_count} sessions)`).join(", ")}. Remember to unload their LaunchAgents.</p>` : ""}
                  <p style="margin-top:24px"><a href="${process.env.NEXT_PUBLIC_URL || "https://hive-phi.vercel.app"}/company/${imp.slug}" style="color:#e8b84d">Open in Hive dashboard →</a></p>
                </div>`,
              }),
            });
            console.log(`    ✉ Import report emailed to ${digestTo}`);
          } catch { /* non-critical */ }
        }

        importReport.phases_completed.push("report_generated");
        console.log(`  ├─ ✓ Phase 5: Import report generated (${importReport.manual_actions_required.length} manual actions)`);
      } catch (e: any) {
        console.log(`  ├─ ⚠ Phase 5 failed: ${e.message.slice(0, 80)}`);
      }

      // Finalize
      await sql`UPDATE imports SET onboard_status = 'complete' WHERE id = ${imp.id}`;
      const [impCompany] = await sql`SELECT status FROM companies WHERE id = ${imp.company_id}`;
      if (impCompany?.status === "approved" || impCompany?.status === "provisioning") {
        await sql`UPDATE companies SET status = 'mvp', updated_at = now() WHERE id = ${imp.company_id}`;
        console.log(`    ✓ ${imp.name} status → mvp`);
      }
      console.log(`  ✓ ${imp.name} import complete — ${importReport.phases_completed.join(" → ")}`);
    }
  }

  // === COMPANY CYCLES ===
  // Priority order: lowest-scoring companies first (they need the most help)
  // New companies (no cycles yet) go first to get their initial momentum
  const companies = await sql`
    SELECT c.*,
      COALESCE(
        (SELECT COUNT(*) FROM cycles WHERE company_id = c.id),
        0
      ) as cycle_count
    FROM companies c
    WHERE c.status IN ('mvp', 'active')
    ORDER BY
      cycle_count ASC,        -- new companies first (0 cycles)
      c.created_at ASC        -- oldest as tiebreaker
  `;
  const companiesToProcess = SINGLE_COMPANY ? companies.filter((r: any) => r.slug === SINGLE_COMPANY) : companies;
  
  console.log(`\n📋 ${companiesToProcess.length} active companies to process`);
  if (companiesToProcess.length > 0) {
    console.log(`  Priority order: ${companiesToProcess.map((c: any) => `${c.slug}(cycles:${c.cycle_count})`).join(" → ")}`);
  }
  console.log("");

  const results: Array<{ company: string; status: string; duration: number }> = [];

  for (const company of companiesToProcess) {
    const companyStart = Date.now();
    console.log(`\n▸ ${company.name} (${company.slug}) — ${company.status} [cycles: ${company.cycle_count}]`);

    try {
      // Check if there are any running cycles and handle timeouts
      const canCreateCycle = await checkAndHandleRunningCycles(company.id);
      if (!canCreateCycle) {
        results.push({
          company: company.slug,
          status: "skipped",
          duration: Math.round((Date.now() - companyStart) / 1000)
        });
        console.log(`  ⏭ Skipped — previous cycle still running`);
        continue;
      }

      const cycleNumber = await getLatestCycleNumber(company.id);
    const cycleId = await createCycle(company.id, cycleNumber);
    const metrics = await getMetrics(company.id);
    const playbook = await getPlaybook();
    const directives = await getDirectives(company.id);

    // Load research reports for this company (if they exist)
    const researchReports = await sql`
      SELECT report_type, summary, content FROM research_reports
      WHERE company_id = ${company.id}
      ORDER BY report_type
    `;
    const researchContext = researchReports.length > 0
      ? `\nRESEARCH REPORTS:\n${researchReports.map((r: any) =>
          `[${r.report_type}] ${r.summary || JSON.stringify(r.content).slice(0, 300)}`
        ).join("\n")}`
      : "";

    const context = `
COMPANY: ${company.name} (${company.slug})
STATUS: ${company.status}
URL: ${company.vercel_url || "not deployed"}
DESCRIPTION: ${company.description}

RECENT METRICS (last 7 days):
${JSON.stringify(metrics, null, 2)}

PLAYBOOK (top learnings):
${playbook.map(p => `- [${p.domain}] ${p.insight} (confidence: ${p.confidence})`).join("\n")}
${researchContext}
${directives.length > 0 ? `\nDIRECTIVES FROM CARLOS (must address these):
${directives.map(d => `- [#${d.id.slice(0,8)}] ${d.text}${d.agent ? ` (for ${d.agent})` : ""}`).join("\n")}` : ""}
    `.trim();

    const companyCtx = { name: company.name, slug: company.slug };

    // === Research Analyst ===
    // Cycle 0: Full research (market + competitive + SEO) on first run
    // Every 7 cycles: Refresh competitive analysis only (market shifts)
    // On directive: "refresh research" triggers full re-run
    const isFirstCycle = researchReports.length === 0;
    const isRefreshCycle = cycleNumber > 1 && cycleNumber % 7 === 0;
    const hasRefreshDirective = directives.some(d => d.text.toLowerCase().includes("refresh research"));
    const needsResearch = isFirstCycle || isRefreshCycle || hasRefreshDirective;

    if (needsResearch) {
      const researchType = isFirstCycle ? "full (Cycle 0)" : isRefreshCycle ? "competitive refresh" : "directive refresh";
      console.log(`  ├─ 🔬 Research Analyst (${researchType})...`);

      const researchPrompt = await getActivePrompt("scout", companyCtx);

      const reportsToGenerate = isFirstCycle || hasRefreshDirective
        ? "all 3 research reports (market_research, competitive_analysis, seo_keywords)"
        : "a competitive analysis refresh ONLY (just the ===COMPETITIVE_ANALYSIS=== block)";

      const reportMarkers = isFirstCycle || hasRefreshDirective
        ? `Output 3 separate JSON blocks, each wrapped in markers:

===MARKET_RESEARCH===
{...json...}
===END===

===COMPETITIVE_ANALYSIS===
{...json...}
===END===

===SEO_KEYWORDS===
{...json...}
===END===`
        : `Output 1 JSON block wrapped in markers:

===COMPETITIVE_ANALYSIS===
{...json...}
===END===

Focus on: new competitors since last analysis, pricing changes, feature launches, market share shifts.`;

      const researchOutput = await dispatch({
        agent: "scout",
        prompt: researchPrompt + `\n\nProduce ${reportsToGenerate} for this company.

COMPANY: ${company.name}
DESCRIPTION: ${company.description}
TARGET AUDIENCE: ${(company as any).target_audience || "see idea proposal context"}
${researchReports.length > 0 ? `\nEXISTING REPORTS (for reference/update):\n${researchReports.map((r: any) => `[${r.report_type}] ${r.summary}`).join("\n")}` : ""}

Use web search extensively.
${reportMarkers}

After each JSON block, write a 1-2 sentence summary.`,
        allowedTools: ["WebSearch", "WebFetch"],
        maxTurns: isFirstCycle ? 30 : 15,
        timeoutMs: isFirstCycle ? 15 * 60 * 1000 : 10 * 60 * 1000,
      });

      // Parse and store each research report
      const reportTypes = [
        { marker: "MARKET_RESEARCH", type: "market_research" },
        { marker: "COMPETITIVE_ANALYSIS", type: "competitive_analysis" },
        { marker: "SEO_KEYWORDS", type: "seo_keywords" },
      ];

      for (const rt of reportTypes) {
        try {
          const regex = new RegExp(`===${rt.marker}===([\\s\\S]*?)===END===`);
          const match = researchOutput.match(regex);
          if (match) {
            const jsonMatch = match[1].match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const content = JSON.parse(jsonMatch[0]);
              // Extract summary (text after the JSON block), stripping markdown fencing
              const afterJson = match[1].slice(match[1].lastIndexOf("}") + 1).trim();
              const summaryLines = afterJson.split("\n").filter(l => {
                const t = l.trim();
                return t && !t.startsWith("```") && t !== "---";
              });
              const summary = summaryLines[0]?.trim() || null;

              await sql`
                INSERT INTO research_reports (company_id, report_type, content, summary)
                VALUES (${company.id}, ${rt.type}, ${JSON.stringify(content)}, ${summary})
                ON CONFLICT (company_id, report_type) DO UPDATE SET
                  content = ${JSON.stringify(content)}, summary = ${summary}, updated_at = now()
              `;
              console.log(`    ✓ ${rt.type}: ${summary?.slice(0, 60) || "stored"}`);
            }
          }
        } catch (parseErr: any) {
          console.log(`    ⚠ Failed to parse ${rt.type}: ${parseErr.message}`);
        }
      }

      // Log the research action
      await sql`
        INSERT INTO agent_actions (company_id, cycle_id, agent, action_type, description, status, started_at, finished_at)
        VALUES (${company.id}, ${cycleId}, 'scout', 'cycle_0_research',
          ${`Cycle 0 research completed: ${reportTypes.length} reports`}, 'success', now(), now())
      `;
    }

    // Step 1: CEO plans (incorporating directives)
    console.log("  ├─ CEO planning...");

    // Add lifecycle context for CEO mode detection
    const [hasRevenue] = await sql`
      SELECT COALESCE(SUM(revenue), 0) as total FROM metrics WHERE company_id = ${company.id}
    `;
    const [hasCustomers] = await sql`
      SELECT COALESCE(SUM(customers), 0) as total FROM metrics WHERE company_id = ${company.id}
    `;
    const [proposal] = await sql`
      SELECT context FROM approvals
      WHERE company_id = ${company.id} AND gate_type = 'new_company' AND status = 'approved'
      ORDER BY decided_at DESC LIMIT 1
    `;

    const ceoMode = cycleNumber <= 2 || Number(hasCustomers.total) === 0
      ? (cycleNumber <= 2 ? "BUILD" : "LAUNCH")
      : "OPTIMIZE";
    const modeHint = ceoMode === "BUILD"
      ? "BUILD — spec features from research, no metrics to manage yet"
      : ceoMode === "LAUNCH"
      ? "LAUNCH — focus on conversion, get first paying customer"
      : "OPTIMIZE — metrics-driven management";

    // Load waitlist data if available
    const [waitlistStats] = await sql`
      SELECT
        COALESCE(MAX(waitlist_total), 0) as total,
        COALESCE(SUM(waitlist_signups), 0) as recent_signups
      FROM metrics
      WHERE company_id = ${company.id} AND date >= CURRENT_DATE - INTERVAL '7 days'
    `;
    const waitlistLine = Number(waitlistStats.total) > 0
      ? `  Waitlist: ${waitlistStats.total} total, ${waitlistStats.recent_signups} signups last 7 days`
      : "";

    // Load capabilities for agent context (inlined — orchestrator can't import from src/lib/)
    const capKeys = Object.keys(company.capabilities || {});
    const capSummary = capKeys.length > 0
      ? `\nCAPABILITIES: ${capKeys.filter(k => (company.capabilities as any)[k]?.exists).join(", ") || "none assessed"}`
      : "\nCAPABILITIES: Not assessed yet — treat all optional features as unavailable.";

    // Load approved evolver proposals for this company
    let evolverProposalsContext = "";
    try {
      const approvedProposals = await sql`
        SELECT title, diagnosis, proposed_fix, gap_type, severity
        FROM evolver_proposals
        WHERE status = 'approved'
          AND (${company.slug} = ANY(affected_companies) OR cross_company = true)
        ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END
        LIMIT 5
      `;
      if (approvedProposals.length > 0) {
        evolverProposalsContext = `\nAPPROVED EVOLVER PROPOSALS (implement these):\n` +
          approvedProposals.map((p: any) =>
            `- [${p.severity}/${p.gap_type}] ${p.title}: ${p.proposed_fix?.change || p.diagnosis}`
          ).join("\n");
      }
    } catch { /* evolver_proposals table may not exist yet */ }

    const lifecycleContext = `
LIFECYCLE:
  Cycle number: ${cycleNumber}
  Has revenue: ${Number(hasRevenue.total) > 0}
  Has customers: ${Number(hasCustomers.total) > 0}
  Mode: ${modeHint}
${waitlistLine ? waitlistLine + "\n" : ""}${capSummary}${evolverProposalsContext}
${proposal?.context ? `\nORIGINAL PROPOSAL:\n${JSON.stringify(proposal.context.proposal || proposal.context, null, 2)}` : ""}
`;

    const ceoPrompt = await getActivePrompt("ceo", companyCtx);
    const ceoPlan = await executeAgent({
      agent: "ceo",
      companyId: company.id,
      cycleId,
      prompt: ceoPrompt + "\n\n" + lifecycleContext + "\n\nWrite tonight's plan. Use the structured output format with engineering_tasks (id: eng-1, eng-2) and growth_tasks (id: growth-1, growth-2)." +
        (directives.length > 0 ? `\n\nIMPORTANT: Carlos has given ${directives.length} directive(s). These take priority. Incorporate them into your plan and note which directive IDs you're addressing.` : ""),
      context,
    });

    // Parse CEO plan into structured handoff
    const ceoPlanParsed = parseHandoff<any>(ceoPlan.output, ["mode"]);
    const planData = ceoPlanParsed?.plan || ceoPlanParsed;

    // Close directives that the CEO incorporated
    for (const d of directives) {
      await closeDirective(d.id, `Incorporated into cycle ${cycleNumber} plan`);
    }

    // Step 2: Growth pre-spec (build mode only — distribution planning BEFORE engineering)
    const growthPrompt = await getActivePrompt("growth", companyCtx);
    let growthPrespec: any = null;

    if (planData?.mode === "build") {
      console.log("  ├─ Growth pre-spec (distribution planning)...");
      const prespecResult = await executeAgent({
        agent: "growth",
        provider: "claude",  // strategic planning needs Claude, not Gemini Flash
        companyId: company.id,
        cycleId,
        prompt: growthPrompt + `\n\n## PRE-SPEC MODE
You are in PRE-SPEC mode. The CEO has planned the product features below. Your job is NOT to create content yet. Instead, plan HOW you will distribute this product.

CEO PLAN:
${planData ? JSON.stringify(planData, null, 2) : ceoPlan.output.slice(0, 2000)}

Output a distribution pre-spec as JSON following the Pre-Spec output format in your prompt (distribution_channels, seo_requirements, conversion_flow, build_requests).
This informs the Engineer what to build alongside features so distribution is baked in from day 1.`,
        context,
      });

      growthPrespec = parseHandoff<any>(prespecResult.output, ["build_requests"]);
      if (growthPrespec) {
        console.log(`    ✓ Pre-spec: ${(growthPrespec.build_requests || []).length} build requests, ${(growthPrespec.distribution_channels || []).length} channels planned`);
      }
    }

    // Step 3: Engineer executes (with structured plan + growth prespec)
    console.log("  ├─ Engineer executing...");
    const companyCwd = `/Users/carlos.miranda/Documents/Github/${company.slug}`;
    let companyRepoExists = existsSync(companyCwd);
    if (!companyRepoExists) {
      console.log(`    ⚠ Repo not cloned — cloning...`);
      try {
        const githubOwner = await getSettingValueDirect("github_owner") || "carloshmiranda";
        await new Promise<void>((resolve, reject) => {
          const proc = spawn("git", ["clone", `https://github.com/${githubOwner}/${company.slug}.git`, companyCwd], { stdio: ["ignore", "pipe", "pipe"] });
          const timer = setTimeout(() => { proc.kill(); reject(new Error("Clone timed out")); }, 60000);
          proc.on("close", (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`git clone exited ${code}`)); });
          proc.on("error", (err) => { clearTimeout(timer); reject(err); });
        });
        companyRepoExists = existsSync(companyCwd);
        if (companyRepoExists) console.log(`    ✓ Cloned ${company.slug}`);
      } catch (cloneErr: any) { console.log(`    ⚠ Clone failed: ${cloneErr.message.slice(0, 80)}`); }
    }
    const engPrompt = await getActivePrompt("engineer", companyCtx);
    const engResult = await executeAgent({
      agent: "engineer",
      companyId: company.id,
      cycleId,
      prompt: engPrompt +
        `\n\nCEO PLAN (structured):\n${planData ? JSON.stringify(planData, null, 2) : ceoPlan.output.slice(0, 2000)}` +
        (growthPrespec
          ? `\n\nGROWTH DISTRIBUTION PRE-SPEC:\n${JSON.stringify(growthPrespec, null, 2)}\n\n` +
            `IMPORTANT: The Growth agent needs these from you: ${(growthPrespec.build_requests || []).join("; ") || "none specified"}. ` +
            `Build these alongside the CEO's engineering_tasks. Distribution-readiness is part of your acceptance criteria.`
          : "") +
        `\n\nExecute the engineering tasks. Reference task IDs (eng-1, eng-2) in your output.`,
      context,
      cwd: companyCwd, // local repo path
    });

    // Parse engineer result for structured handoff
    const engParsed = parseHandoff<any>(engResult.output, ["tasks_completed"]);

    // Step 4: Growth executes content (inbound: content, SEO, social)
    console.log("  ├─ Growth executing...");
    const growthResult = await executeAgent({
      agent: "growth",
      companyId: company.id,
      cycleId,
      prompt: growthPrompt +
        `\n\nCEO PLAN (structured):\n${planData ? JSON.stringify(planData, null, 2) : ceoPlan.output.slice(0, 2000)}` +
        `\n\nENGINEER RESULTS:\n${engParsed ? JSON.stringify(engParsed, null, 2) : `Status: ${engResult.success ? "SUCCESS" : "FAILED"} — ${engResult.output.slice(0, 500)}`}` +
        `\n\nExecute the growth tasks. Reference task IDs (growth-1, growth-2) in your output. You have access to research reports — use SEO keywords and market research to inform content.`,
      context,
    });

    // Parse growth result for structured handoff
    const growthParsed = parseHandoff<any>(growthResult.output, ["content_created"]);

    // Step 3b: Outreach executes (outbound: lead gen, cold email, community engagement)
    // Skipped for companies with no research reports yet (wait for Cycle 0 to complete)
    if (researchReports.length > 0) {
      console.log("  ├─ Outreach executing...");
      const outreachPrompt = await getActivePrompt("outreach", companyCtx);

      // Load existing lead list and outreach log
      const [leadList] = await sql`
        SELECT content FROM research_reports WHERE company_id = ${company.id} AND report_type = 'lead_list'
      `;
      const [outreachLog] = await sql`
        SELECT content FROM research_reports WHERE company_id = ${company.id} AND report_type = 'outreach_log'
      `;

      const outreachContext = `${context}

EXISTING LEADS: ${leadList ? JSON.stringify(leadList.content) : "None yet — build the lead list first."}

OUTREACH LOG: ${outreachLog ? JSON.stringify(outreachLog.content) : "No outreach yet."}`;

      const outreachResult = await executeAgent({
        agent: "outreach",
        companyId: company.id,
        cycleId,
        prompt: outreachPrompt + `\n\nCEO PLAN: ${ceoPlan.output}\n\n` +
          (leadList ? "Review your existing lead list. Draft new cold emails for uncontacted leads. Plan follow-ups for leads that haven't replied. Find new leads if the list is thin (<10 active leads)."
            : "No lead list yet. Build the initial lead list using web search. Find 10-20 potential customers matching the target audience.") +
          "\n\nOutput your results as JSON. Use the lead_list and outreach_log report type formats from your instructions.",
        context: outreachContext,
        allowedTools: ["WebSearch", "WebFetch"],
      });

      // Parse and store outreach results
      try {
        const output = outreachResult.output;

        // Extract lead list updates
        const leadMatch = output.match(/lead_list['":\s]*(\{[\s\S]*?\})\s*(?:outreach|$)/i) || output.match(/["']leads["']\s*:/);
        const fullJson = output.match(/\{[\s\S]*\}/);
        if (fullJson) {
          const parsed = JSON.parse(fullJson[0]);

          // If it has leads, update lead_list
          if (parsed.leads?.length) {
            await sql`
              INSERT INTO research_reports (company_id, report_type, content, summary)
              VALUES (${company.id}, 'lead_list', ${JSON.stringify(parsed)}, ${`${parsed.leads.length} leads tracked`})
              ON CONFLICT (company_id, report_type) DO UPDATE SET
                content = ${JSON.stringify(parsed)}, summary = ${`${parsed.leads.length} leads tracked`}, updated_at = now()
            `;
            console.log(`    📧 ${parsed.leads.length} leads in pipeline`);
          }

          // If it has emails_drafted, update outreach_log
          if (parsed.emails_drafted?.length) {
            await sql`
              INSERT INTO research_reports (company_id, report_type, content, summary)
              VALUES (${company.id}, 'outreach_log', ${JSON.stringify(parsed)}, ${`${parsed.emails_drafted.length} emails drafted`})
              ON CONFLICT (company_id, report_type) DO UPDATE SET
                content = ${JSON.stringify(parsed)}, summary = ${`${parsed.emails_drafted.length} emails drafted`}, updated_at = now()
            `;

            // Send approved cold emails via Resend
            const resendKey = await getSettingValueDirect("resend_api_key");
            const sendingDomain = await getSettingValueDirect("sending_domain");
            if (resendKey && sendingDomain) {
              // Only auto-send if we've had outreach approved before
              const [outreachApproved] = await sql`
                SELECT id FROM approvals 
                WHERE company_id = ${company.id} AND gate_type = 'outreach_batch' AND status = 'approved'
                LIMIT 1
              `;

              if (outreachApproved) {
                // Auto-send (previously approved approach)
                let sent = 0;
                for (const email of parsed.emails_drafted.filter((e: any) => e.status === "drafted").slice(0, 10)) {
                  if (!email.to || !email.subject || !email.body) continue;
                  try {
                    const res = await fetch("https://api.resend.com/emails", {
                      method: "POST",
                      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
                      body: JSON.stringify({
                        from: `${company.name} <outreach@${sendingDomain}>`,
                        to: email.to,
                        subject: email.subject,
                        html: email.body.replace(/\n/g, "<br>"),
                      }),
                    });
                    if (res.ok) { email.status = "sent"; email.sent_at = new Date().toISOString(); sent++; }
                  } catch { /* individual send failure, continue */ }
                }
                if (sent > 0) {
                  console.log(`    ✉ ${sent} cold emails sent`);
                  // Update the log with sent statuses
                  await sql`
                    UPDATE research_reports SET content = ${JSON.stringify(parsed)}, updated_at = now()
                    WHERE company_id = ${company.id} AND report_type = 'outreach_log'
                  `;
                }
              } else {
                // First outreach batch — needs approval
                await sql`
                  INSERT INTO approvals (company_id, gate_type, title, description, context)
                  VALUES (
                    ${company.id}, 'outreach_batch',
                    ${`Approve cold outreach for ${company.name}`},
                    ${`The Outreach agent drafted ${parsed.emails_drafted.length} cold emails.\n\n` +
                      `**Sample email:**\n` +
                      `To: ${parsed.emails_drafted[0]?.to || "N/A"}\n` +
                      `Subject: ${parsed.emails_drafted[0]?.subject || "N/A"}\n` +
                      `Body: ${(parsed.emails_drafted[0]?.body || "").slice(0, 300)}\n\n` +
                      `Approving this gate allows future batches to auto-send (max 10/day).`},
                    ${JSON.stringify({ email_count: parsed.emails_drafted.length })}
                  )
                `;
                console.log(`    📋 First outreach batch — approval gate created`);
              }
            } else if (!sendingDomain) {
              console.log(`    ⚠ Outreach emails drafted but NOT sent — no verified sending_domain in settings`);
            }
          }
        }
      } catch {
        // Non-critical: if parsing fails, the raw output is still logged by executeAgent
      }
    } else {
      console.log("  ├─ Outreach — skipped (no research reports yet)");
    }

    // Step 4: Ops collects metrics
    console.log("  ├─ Ops collecting metrics...");
    const opsPrompt = await getActivePrompt("ops", companyCtx);
    const opsResult = await executeAgent({
      agent: "ops",
      companyId: company.id,
      cycleId,
      prompt: opsPrompt + "\n\nCollect today's metrics from Stripe, Vercel Analytics, and error logs.",
      context,
    });

    // Step 6: CEO reviews (all structured handoffs)
    console.log("  └─ CEO reviewing cycle...");
    const ceoReview = await executeAgent({
      agent: "ceo",
      companyId: company.id,
      cycleId,
      prompt: ceoPrompt + `\n\nReview tonight's cycle results. Score the cycle 1-10. Grade each agent (A/B/C/F). Include a playbook_entry if you learned something. List next_cycle_priorities.

STRUCTURED RESULTS:
Engineer: ${engParsed ? JSON.stringify(engParsed, null, 2) : `${engResult.success ? "SUCCESS" : "FAILED"} — ${engResult.output.slice(0, 500)}`}
Growth: ${growthParsed ? JSON.stringify(growthParsed, null, 2) : `${growthResult.success ? "SUCCESS" : "FAILED"} — ${growthResult.output.slice(0, 500)}`}
Ops: ${opsResult.success ? "SUCCESS" : "FAILED"} — ${opsResult.output.slice(0, 300)}
${growthPrespec ? `\nGrowth Pre-Spec was: ${JSON.stringify(growthPrespec, null, 2)}` : ""}

Use the structured review output format with agent_grades and next_cycle_priorities.`,
      context,
    });

    // Extract playbook entry and score from CEO review
    let cycleScore: number | null = null;
    try {
      const reviewJson = ceoReview.output.match(/\{[\s\S]*\}/);
      if (reviewJson) {
        const review = JSON.parse(reviewJson[0]);
        const r = review.review || review;

        // Write cycle score
        if (r.score) {
          cycleScore = Number(r.score);
        }

        // Write playbook entry if present
        if (r.playbook_entry?.insight) {
          const entry = r.playbook_entry;
          await sql`
            INSERT INTO playbook (domain, insight, confidence, source_company_id, evidence)
            VALUES (
              ${entry.domain || "general"},
              ${entry.insight},
              ${entry.confidence || 0.5},
              ${company.id},
              ${JSON.stringify({ cycle_id: cycleId, cycle_number: cycleNumber })}
            )
          `;
          console.log(`    📖 Playbook: [${entry.domain}] ${entry.insight.slice(0, 60)}...`);
        }

        // Write kill flag if CEO recommends killing
        if (r.kill_flag === true) {
          await sql`
            INSERT INTO approvals (company_id, gate_type, title, description, context)
            VALUES (
              ${company.id},
              'kill_company',
              ${"Kill Switch: " + company.name},
              ${`CEO agent recommends killing this company.\n\nAssessment: ${r.assessment || "No assessment"}\nScore: ${r.score || "N/A"}/10`},
              ${JSON.stringify(r)}
            )
          `;
          console.log(`    ⚠ Kill flag raised — approval gate created`);
        }
      }
    } catch {
      // Non-critical: if we can't parse the review, just continue
    }

    // Merge capability updates from any agent output this cycle
    for (const output of [engResult.output, growthResult.output, opsResult.output]) {
      try {
        const jsonMatch = output.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.capabilities_updated && typeof parsed.capabilities_updated === "object") {
            const currentCaps = company.capabilities || {};
            const merged = { ...currentCaps, ...parsed.capabilities_updated };
            await sql`
              UPDATE companies SET capabilities = ${JSON.stringify(merged)}::jsonb, last_assessed_at = NOW()
              WHERE id = ${company.id}
            `;
            console.log(`    📋 Capabilities updated from agent output`);
          }
        }
      } catch { /* non-critical */ }
    }

    // Track playbook references from agent outputs
    for (const output of [ceoPlan.output, ceoReview.output, engResult.output, growthResult.output]) {
      try {
        const jsonMatch = output.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (Array.isArray(parsed.playbook_references)) {
            for (const ref of parsed.playbook_references) {
              if (ref.playbook_id) {
                await sql`
                  UPDATE playbook SET last_referenced_at = NOW(), reference_count = reference_count + 1
                  WHERE id = ${ref.playbook_id}
                `;
              }
            }
          }
        }
      } catch { /* non-critical */ }
    }

    // Mark implemented evolver proposals
    try {
      await sql`
        UPDATE evolver_proposals SET status = 'implemented', implemented_at = NOW()
        WHERE status = 'approved'
          AND (${company.slug} = ANY(affected_companies) OR cross_company = true)
      `;
    } catch { /* non-critical */ }

    // Store structured handoffs when available, raw output as fallback
    const reviewParsed = parseHandoff<any>(ceoReview.output, ["score"]);
    await updateCycle(cycleId, {
      status: "completed",
      ceo_plan: planData ? JSON.stringify(planData) : ceoPlan.output,
      ceo_review: reviewParsed ? JSON.stringify(reviewParsed.review || reviewParsed) : ceoReview.output,
    });

    const duration = Math.round((Date.now() - companyStart) / 1000);
    console.log(`  ✓ Cycle ${cycleNumber} complete (${duration}s)`);
    results.push({ company: company.slug, status: "complete", duration });

    } catch (companyError: any) {
      // Graceful skip: log the failure and continue to the next company
      const duration = Math.round((Date.now() - companyStart) / 1000);
      console.log(`  ✗ FAILED after ${duration}s: ${companyError.message}`);
      results.push({ company: company.slug, status: "failed", duration });

      // Collect for self-healing analysis
      runErrors.push({
        company: company.slug,
        companyId: company.id,
        agent: "orchestrator",
        error: companyError.message,
        phase: "company_cycle",
      });

      // Log failure to DB so it shows in the dashboard
      try {
        await sql`
          INSERT INTO agent_actions (company_id, agent, action_type, description, status, error, started_at, finished_at)
          VALUES (${company.id}, 'orchestrator', 'cycle_failed', ${`Company cycle failed: ${companyError.message}`}, 'failed', ${companyError.message}, now(), now())
        `;
      } catch { /* don't let logging failure cascade */ }
    }
  }

  // === SELF-HEALING CYCLE ===
  // Analyzes errors from this run + recent history, dispatches fixes
  const failedCount = results.filter(r => r.status === "failed").length;
  const recentErrors = await sql`
    SELECT aa.agent, aa.error, aa.description, aa.company_id, 
           c.slug as company_slug, c.name as company_name,
           aa.finished_at
    FROM agent_actions aa
    LEFT JOIN companies c ON c.id = aa.company_id
    WHERE aa.status IN ('failed', 'escalated')
      AND aa.started_at > now() - interval '48 hours'
    ORDER BY aa.finished_at DESC
    LIMIT 30
  `;

  if (recentErrors.length > 0 && !SCOUT_ONLY && !DRY_RUN) {
    console.log(`\n🔧 Self-healing — ${recentErrors.length} errors in last 48h`);

    // Classify errors: systemic (same error in multiple companies) vs company-specific
    const errorPatterns: Record<string, { count: number; companies: string[]; error: string; agent: string }> = {};
    for (const err of recentErrors) {
      // Normalize error to find patterns (strip timestamps, IDs, company-specific details)
      const normalized = (err.error || "")
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<ID>")
        .replace(/\d{4}-\d{2}-\d{2}T[\d:.Z]+/g, "<TIMESTAMP>")
        .replace(/https?:\/\/[^\s]+/g, "<URL>")
        .slice(0, 200);
      
      if (!errorPatterns[normalized]) {
        errorPatterns[normalized] = { count: 0, companies: [], error: normalized, agent: err.agent };
      }
      errorPatterns[normalized].count++;
      if (err.company_slug && !errorPatterns[normalized].companies.includes(err.company_slug)) {
        errorPatterns[normalized].companies.push(err.company_slug);
      }
    }

    const systemicErrors = Object.values(errorPatterns).filter(p => p.companies.length > 1 || p.count >= 3);
    const companyErrors = Object.values(errorPatterns).filter(p => p.companies.length === 1 && p.count < 3);

    if (systemicErrors.length > 0) {
      console.log(`  🔴 ${systemicErrors.length} systemic error(s) (affect multiple companies)`);
      for (const pattern of systemicErrors) {
        console.log(`    - [${pattern.agent}] ${pattern.error.slice(0, 80)} (${pattern.count}x across ${pattern.companies.join(", ")})`);
      }
    }

    // Dispatch the Healer agent to fix systemic issues
    // The Healer works on the Hive codebase itself (not company repos)
    if (systemicErrors.length > 0) {
      console.log("  ├─ Dispatching Healer for systemic fixes...");
      try {
        const healerOutput = await dispatch({
          agent: "ops",
          prompt: `You are the Healer agent for Hive. Your job is to fix bugs that are breaking the orchestrator.

## Systemic errors (happening across multiple companies):
${systemicErrors.map(e => `- Agent: ${e.agent} | Error: ${e.error} | Occurrences: ${e.count} | Companies: ${e.companies.join(", ")}`).join("\n")}

## Recent error context:
${recentErrors.slice(0, 10).map(e => `- [${e.agent}] ${e.company_slug || "hive"}: ${(e.error || e.description || "").slice(0, 150)}`).join("\n")}

## Your process:
1. Read the error messages carefully. Identify the ROOT CAUSE.
2. Look at the relevant source files — the error usually tells you which file and line.
3. Fix the actual bug. Common issues:
   - Database queries referencing columns that don't exist
   - JSON parsing errors (agent returned markdown instead of JSON)
   - API calls to endpoints that require auth but don't have it
   - Type errors in TypeScript
   - Missing environment variables
   - Timeout issues (dispatch() default is 5min, some tasks need more)
4. Run \`npm run build\` to verify your fix compiles.
5. If the fix is in orchestrator.ts, just save it — it runs via ts-node next cycle.
6. If the fix is in src/, run \`npm run build\` and commit + push to deploy.

## Rules:
- Fix the SIMPLEST thing that addresses the error. Don't refactor.
- If you can't identify the root cause, write your analysis to MISTAKES.md so the next session can pick it up.
- Never fix by removing functionality. Fix by making the functionality work.
- Always run \`npm run build\` after changes to verify compilation.
- Commit with message format: "fix: [what was broken] — [what you changed]"

Output JSON:
{
  "errors_analyzed": number,
  "fixes_applied": [{ "file": "...", "description": "..." }],
  "could_not_fix": [{ "error": "...", "reason": "..." }],
  "committed": boolean,
  "build_passed": boolean
}`,
          cwd: process.cwd(), // Hive's own repo
          maxTurns: 20,
          timeoutMs: 10 * 60 * 1000,
        });

        // Parse healer output
        try {
          const healerJson = healerOutput.match(/\{[\s\S]*\}/);
          if (healerJson) {
            const result = JSON.parse(healerJson[0]);
            const fixCount = result.fixes_applied?.length || 0;
            const unfixable = result.could_not_fix?.length || 0;
            console.log(`  ✓ Healer: ${fixCount} fix(es) applied, ${unfixable} could not fix, build ${result.build_passed ? "passed" : "FAILED"}`);

            // Log the healing action
            await sql`
              INSERT INTO agent_actions (agent, action_type, description, status, output, started_at, finished_at)
              VALUES ('ops', 'self_heal', ${`Fixed ${fixCount} systemic error(s)${unfixable > 0 ? `, ${unfixable} unfixable` : ""}`}, 
                ${fixCount > 0 ? "success" : "partial"}, ${JSON.stringify(result)}, now(), now())
            `;

            // Write unfixable errors to MISTAKES.md via the healer (it already does this in the prompt)
          }
        } catch {
          console.log("  ⚠ Could not parse Healer output");
        }
      } catch (healErr: any) {
        console.log(`  ⚠ Healer failed: ${healErr.message}`);
      }
    }

    // For company-specific errors, check if the same error was already solved in another company
    for (const pattern of companyErrors.slice(0, 3)) { // max 3 company fixes per night
      const companySlug = pattern.companies[0];
      if (!companySlug) continue;

      // === CROSS-COMPANY ERROR CORRELATION ===
      // Search for successful fixes of similar errors in other companies
      const normalizedError = pattern.error.slice(0, 150);
      const similarFixes = await sql`
        SELECT aa.output, aa.description, c.slug as fixed_in,
               aa.finished_at
        FROM agent_actions aa
        JOIN companies c ON c.id = aa.company_id
        WHERE aa.action_type IN ('self_heal', 'execute_task')
          AND aa.status = 'success'
          AND aa.description ILIKE ${"%" + normalizedError.slice(0, 50) + "%"}
          AND c.slug != ${companySlug}
          AND aa.started_at > now() - interval '60 days'
        ORDER BY aa.finished_at DESC
        LIMIT 3
      `;

      // Also check playbook for relevant entries
      const relevantPlaybook = await sql`
        SELECT p.domain, p.insight, c.slug as source_company, p.confidence
        FROM playbook p LEFT JOIN companies c ON c.id = p.source_company_id
        WHERE p.superseded_by IS NULL
          AND p.domain = ${pattern.agent === "engineer" ? "engineering" : pattern.agent}
          AND p.confidence >= 0.5
        ORDER BY p.confidence DESC
        LIMIT 5
      `;

      const crossCompanyContext = similarFixes.length > 0
        ? `\n## Cross-company intelligence — similar errors were ALREADY FIXED elsewhere:\n${
            similarFixes.map((f: any) => 
              `- **Fixed in ${f.fixed_in}** (${f.finished_at?.toISOString?.() || "recently"}): ${(f.description || "").slice(0, 200)}`
            ).join("\n")
          }\nLook at how these were fixed and apply the same approach if applicable.\n`
        : "";

      const playbookContext = relevantPlaybook.length > 0
        ? `\n## Relevant playbook entries:\n${
            relevantPlaybook.map((p: any) => `- [${p.domain}] ${p.insight} (from ${p.source_company || "unknown"}, confidence: ${p.confidence})`).join("\n")
          }\n`
        : "";

      console.log(`  ├─ Fixing ${companySlug}: ${pattern.error.slice(0, 60)}...`);
      if (similarFixes.length > 0) {
        console.log(`    💡 Found ${similarFixes.length} similar fix(es) from other companies`);
      }

      try {
        await dispatch({
          prompt: `You are the Engineer fixing a bug for ${companySlug}.

Error: ${pattern.error}
Agent: ${pattern.agent}
Occurrences: ${pattern.count}
${crossCompanyContext}${playbookContext}
Read the error, find the file, fix the bug, run \`npm run build\`, and commit if it passes.
Keep the fix minimal — address only this error. Commit message: "fix: [description]"

AFTER fixing: If the fix reveals a reusable pattern (e.g., a common config mistake, a library gotcha),
write it to the Hive playbook via the API:
curl -X POST http://localhost:3000/api/playbook -H "Content-Type: application/json" -d '{
  "domain": "engineering",
  "insight": "[what you learned]",
  "source_company": "${companySlug}",
  "confidence": 0.7
}'`,
          cwd: `/Users/carlos.miranda/Documents/Github/${companySlug}`,
          maxTurns: 15,
          timeoutMs: 8 * 60 * 1000,
        });
        console.log(`  ✓ ${companySlug} fix attempted`);
      } catch (fixErr: any) {
        console.log(`  ⚠ ${companySlug} fix failed: ${fixErr.message}`);
      }
    }
  } else if (!SCOUT_ONLY) {
    console.log(`\n🔧 Self-healing — ${recentErrors.length === 0 ? "no recent errors" : `skipped (${failedCount} failures this run, ${recentErrors.length} in 48h)`}`);
  }

  // === EVOLVER TRIGGER: Check if gap detection should run ===
  // Conditions: error rate >30%, escalation clusters ≥3, stuck companies >14 days, 24h debounce
  if (!SCOUT_ONLY && !DRY_RUN && !SINGLE_COMPANY) {
    try {
      const [evolverLastRun] = await sql`
        SELECT finished_at FROM agent_actions
        WHERE agent = 'evolver' AND action_type = 'gap_analysis' AND status = 'success'
        ORDER BY finished_at DESC LIMIT 1
      `;
      const hoursSinceLastRun = evolverLastRun?.finished_at
        ? (Date.now() - new Date(evolverLastRun.finished_at).getTime()) / 3600000
        : 999;

      if (hoursSinceLastRun > 24) {
        const [errorStats] = await sql`
          SELECT
            COUNT(*) FILTER (WHERE status = 'failed') as failed,
            COUNT(*) FILTER (WHERE status = 'escalated') as escalated,
            COUNT(*) as total
          FROM agent_actions WHERE started_at > now() - interval '48 hours'
        `;
        const errorRate = Number(errorStats.total) > 0 ? Number(errorStats.failed) / Number(errorStats.total) : 0;
        const escalationCount = Number(errorStats.escalated);

        const stuckCompanies = await sql`
          SELECT c.slug FROM companies c
          WHERE c.status IN ('mvp', 'active')
          AND NOT EXISTS (
            SELECT 1 FROM cycles WHERE company_id = c.id AND started_at > now() - interval '14 days'
          )
        `;

        const shouldTrigger = errorRate > 0.3 || escalationCount >= 3 || stuckCompanies.length > 0;

        if (shouldTrigger) {
          console.log(`\n🧬 Evolver trigger detected — error rate: ${Math.round(errorRate * 100)}%, escalations: ${escalationCount}, stuck: ${stuckCompanies.length}`);
          // Dispatch via GitHub Actions
          const ghPat = await getSettingValueDirect("github_token");
          if (ghPat) {
            try {
              await fetch("https://api.github.com/repos/carloshmiranda/hive/dispatches", {
                method: "POST",
                headers: { Authorization: `token ${ghPat}`, Accept: "application/vnd.github.v3+json", "Content-Type": "application/json" },
                body: JSON.stringify({ event_type: "evolve_trigger", client_payload: { focus: "all" } }),
              });
              console.log("  ✓ Evolver workflow dispatched");
            } catch (dispatchErr: any) {
              console.log(`  ⚠ Evolver dispatch failed: ${dispatchErr.message}`);
            }
          }
        }

        // === PROCESS GAP DETECTION ===
        // Lightweight checks that create evolver_proposals directly (no agent dispatch needed)
        console.log(`\n🔍 Process health check...`);
        let processGaps = 0;

        // 1. Scout duplicate rate: ideas killed within 24h of creation (likely duplicates/instant rejections)
        const [scoutStats] = await sql`
          SELECT
            COUNT(*) FILTER (WHERE status = 'killed' AND killed_at < created_at + interval '24 hours') as quick_kills,
            COUNT(*) as total_proposals
          FROM companies
          WHERE created_at > now() - interval '30 days'
            AND id IN (SELECT company_id FROM approvals WHERE gate_type = 'new_company')
        `;
        const totalProposals = Number(scoutStats.total_proposals);
        const quickKills = Number(scoutStats.quick_kills);
        const scoutDuplicateRate = totalProposals > 0 ? quickKills / totalProposals : 0;
        if (scoutDuplicateRate > 0.3 && totalProposals >= 3) {
          await sql`
            INSERT INTO evolver_proposals (gap_type, severity, title, diagnosis, signal_source, signal_data, proposed_fix)
            VALUES (
              'process',
              'medium',
              'Process gap: Scout duplicate/rejection rate too high',
              ${`${quickKills} of ${totalProposals} Scout proposals (${Math.round(scoutDuplicateRate * 100)}%) were killed within 24h of creation in the last 30 days. This suggests the Scout is proposing ideas that are immediately rejected — either duplicates, poor quality, or misaligned with Carlos's preferences.`},
              'companies + approvals tables',
              ${JSON.stringify({ quick_kills: quickKills, total_proposals: totalProposals, rate: scoutDuplicateRate })},
              ${JSON.stringify({ type: "setup_action", description: "Review Scout prompt for idea quality filters. Consider adding market size minimums, duplicate checking against existing companies, or preference learning from past rejections." })}
            )
          `;
          processGaps++;
          console.log(`  ⚠ Scout duplicate rate: ${Math.round(scoutDuplicateRate * 100)}% (${quickKills}/${totalProposals}) — proposal created`);
        }

        // 2. Approval staleness: pending approvals older than 48h
        const staleApprovals = await sql`
          SELECT id, gate_type, title, created_at
          FROM approvals
          WHERE status = 'pending' AND created_at < now() - interval '48 hours'
        `;
        if (staleApprovals.length > 3) {
          await sql`
            INSERT INTO evolver_proposals (gap_type, severity, title, diagnosis, signal_source, signal_data, proposed_fix)
            VALUES (
              'process',
              'high',
              'Process gap: Too many stale approvals',
              ${`${staleApprovals.length} approvals have been pending for >48h. This blocks the pipeline — companies can't be provisioned, prompts can't be upgraded, and growth strategies can't execute. Gate types: ${staleApprovals.map((a: any) => a.gate_type).join(', ')}.`},
              'approvals table',
              ${JSON.stringify({ count: staleApprovals.length, gates: staleApprovals.map((a: any) => ({ id: a.id, gate_type: a.gate_type, title: a.title, age_hours: Math.round((Date.now() - new Date(a.created_at).getTime()) / 3600000) })) })},
              ${JSON.stringify({ type: "setup_action", description: "Review and decide on stale approvals. Consider auto-expiring low-priority gates after 7 days, or batching approval notifications." })}
            )
          `;
          processGaps++;
          console.log(`  ⚠ Stale approvals: ${staleApprovals.length} pending >48h — proposal created`);
        }

        // 3. Stuck approved companies: approved but not provisioned within 3 days
        const stuckApproved = await sql`
          SELECT slug, name, updated_at
          FROM companies
          WHERE status = 'approved' AND updated_at < now() - interval '3 days'
        `;
        if (stuckApproved.length > 0) {
          await sql`
            INSERT INTO evolver_proposals (gap_type, severity, title, diagnosis, signal_source, signal_data, proposed_fix)
            VALUES (
              'process',
              'critical',
              'Process gap: Approved companies stuck without provisioning',
              ${`${stuckApproved.length} company(ies) have been in 'approved' status for >3 days without being provisioned: ${stuckApproved.map((c: any) => c.slug).join(', ')}. The provisioning step (Step 2) is likely broken or being skipped.`},
              'companies table',
              ${JSON.stringify({ companies: stuckApproved.map((c: any) => ({ slug: c.slug, name: c.name, stuck_since: c.updated_at })) })},
              ${JSON.stringify({ type: "setup_action", description: "Investigate provisioning step in orchestrator. Check GitHub API, Neon API, and Vercel API connectivity. Run a manual provisioning cycle with --company flag." })}
            )
          `;
          processGaps++;
          console.log(`  ⚠ Stuck approved: ${stuckApproved.map((c: any) => c.slug).join(', ')} — proposal created`);
        }

        // 4. Cycle gaps: active/mvp companies without a cycle in >7 days
        const cycleGapCompanies = await sql`
          SELECT c.slug, c.name, c.status,
            (SELECT MAX(started_at) FROM cycles WHERE company_id = c.id) as last_cycle
          FROM companies c
          WHERE c.status IN ('mvp', 'active')
          AND NOT EXISTS (
            SELECT 1 FROM cycles WHERE company_id = c.id AND started_at > now() - interval '7 days'
          )
        `;
        if (cycleGapCompanies.length > 0) {
          await sql`
            INSERT INTO evolver_proposals (gap_type, severity, title, diagnosis, signal_source, signal_data, proposed_fix)
            VALUES (
              'process',
              'high',
              'Process gap: Active companies missing nightly cycles',
              ${`${cycleGapCompanies.length} active/mvp company(ies) haven't had a cycle in >7 days: ${cycleGapCompanies.map((c: any) => `${c.slug} (last: ${c.last_cycle ? new Date(c.last_cycle).toISOString().slice(0, 10) : 'never'})`).join(', ')}. These companies are stagnating without CEO planning or engineering work.`},
              'companies + cycles tables',
              ${JSON.stringify({ companies: cycleGapCompanies.map((c: any) => ({ slug: c.slug, status: c.status, last_cycle: c.last_cycle })) })},
              ${JSON.stringify({ type: "setup_action", description: "Check orchestrator logs for skip reasons. Verify company priority ordering. Run manual cycle with --company flag for affected companies." })}
            )
          `;
          processGaps++;
          console.log(`  ⚠ Cycle gaps: ${cycleGapCompanies.map((c: any) => c.slug).join(', ')} — proposal created`);
        }

        if (processGaps === 0) {
          console.log(`  ✓ No process gaps detected`);
        } else {
          console.log(`  📋 ${processGaps} process gap(s) added to evolver proposals`);
        }
      }
    } catch { /* non-critical */ }
  }

  // === VENTURE BRAIN: Portfolio-level analysis ===
  // Only runs when there are 2+ active companies to compare
  const activeForBrain = results.filter(r => r.status === "complete");
  if (activeForBrain.length >= 2) {
    console.log("\n🧠 Venture Brain — portfolio analysis");

    const allMetrics = await sql`
      SELECT c.name, c.slug, c.status, m.* 
      FROM metrics m 
      JOIN companies c ON c.id = m.company_id 
      WHERE m.date >= CURRENT_DATE - INTERVAL '7 days'
      ORDER BY c.slug, m.date DESC
    `;

    // Gather recent playbook entries for cross-pollination analysis
    const recentPlaybook = await sql`
      SELECT p.domain, p.insight, c.slug as source_company, p.confidence, p.created_at
      FROM playbook p LEFT JOIN companies c ON c.id = p.source_company_id
      WHERE p.superseded_by IS NULL
      ORDER BY p.created_at DESC LIMIT 20
    `;

    // Gather recent cycle scores for trend analysis
    const cycleScores = await sql`
      SELECT c.slug, cy.cycle_number, cy.ceo_review, cy.started_at
      FROM cycles cy
      JOIN companies c ON c.id = cy.company_id
      WHERE cy.started_at > now() - interval '14 days' AND cy.status = 'completed'
      ORDER BY c.slug, cy.started_at DESC
    `;

    try {
      await dispatch({
        agent: "ceo",
        prompt: `You are the Venture Brain. Analyze the portfolio:

## Metrics (last 7 days):
${JSON.stringify(allMetrics, null, 2)}

## Cycle scores (last 14 days):
${cycleScores.map((s: any) => {
  let score = "?";
  try { const r = typeof s.ceo_review === "string" ? JSON.parse(s.ceo_review) : s.ceo_review; score = r?.review?.score ?? r?.score ?? "?"; } catch {}
  return `${s.slug}: cycle ${s.cycle_number} → ${score}/10`;
}).join("\n") || "No scored cycles yet"}

## Recent playbook entries:
${recentPlaybook.map((p: any) => `[${p.domain}] ${p.insight} (from ${p.source_company || "unknown"}, confidence: ${p.confidence})`).join("\n") || "No playbook entries yet"}

Tasks:
1. **Compare companies**: which is performing best, which is stalling? Look at score trends, not just latest score.
2. **Kill Switch check**: any company that should be shut down? (criteria: no revenue after 60 days, CAC > 3x LTV for 30 days, no signups for 30 days)
3. **Capital allocation**: should we shift resources between companies?
4. **Cross-pollination**: Are there playbook entries from one company that should be applied to another? 
   For example: if company A discovered a pricing pattern that works, should company B adopt it?
   Write specific directives for companies that should adopt learnings from siblings.
   Use: POST /api/directives with { company_id: "<id>", text: "From Venture Brain: apply [insight] from [source_company]" }
5. If any company should be killed, write to the approvals table via the API.

Output a brief portfolio summary including any cross-pollination directives you created.`,
      });
    } catch (vbErr: any) {
      console.log(`  ⚠ Venture Brain error: ${vbErr.message}`);
    }
  } else {
    console.log(`\n🧠 Venture Brain — skipped (need 2+ active companies, have ${activeForBrain.length})`);
  }

  // === PROMPT EVOLVER: Weekly prompt improvement ===
  // Runs on Wednesdays (offset from Sunday Idea Scout to spread load)
  const isWednesday = new Date().getDay() === 3;
  const hasEnoughData = results.filter(r => r.status === "complete").length > 0;

  if (isWednesday && hasEnoughData && !SINGLE_COMPANY && !SCOUT_ONLY) {
    console.log("\n🧬 Prompt Evolver — analyzing agent performance");

    const agents = ["ceo", "scout", "engineer", "growth", "ops"];

    for (const agent of agents) {
      try {
        // Get performance data for this agent over last 14 days
        const recentActions = await sql`
          SELECT status, error, reflection, description, finished_at
          FROM agent_actions 
          WHERE agent = ${agent} 
            AND started_at > now() - interval '14 days'
          ORDER BY finished_at DESC
          LIMIT 50
        `;

        if (recentActions.length < 5) {
          console.log(`  ⓘ ${agent}: not enough data (${recentActions.length} actions) — skipping`);
          continue;
        }

        const total = recentActions.length;
        const successes = recentActions.filter((a: any) => a.status === "success").length;
        const failures = recentActions.filter((a: any) => a.status === "failed").length;
        const successRate = successes / total;

        // Check when we last evolved this agent's prompt
        const [latestVersion] = await sql`
          SELECT version, created_at FROM agent_prompts 
          WHERE agent = ${agent} 
          ORDER BY version DESC LIMIT 1
        `;
        const daysSinceLastEvolve = latestVersion
          ? Math.floor((Date.now() - new Date(latestVersion.created_at).getTime()) / 86400000)
          : 999;
        const nextVersion = (latestVersion?.version || 0) + 1;

        // Evolve if: success rate < 70%, or hasn't been evolved in 30+ days
        const shouldEvolve = successRate < 0.7 || daysSinceLastEvolve >= 30;

        if (!shouldEvolve) {
          console.log(`  ✓ ${agent}: ${Math.round(successRate * 100)}% success rate (${total} actions) — no evolution needed`);
          continue;
        }

        console.log(`  ├─ ${agent}: ${Math.round(successRate * 100)}% success, ${failures} failures — generating variant...`);

        // Get current prompt
        const currentPrompt = await getActivePrompt(agent);

        // Gather failure patterns
        const failureDetails = recentActions
          .filter((a: any) => a.status === "failed" || a.status === "escalated")
          .slice(0, 10)
          .map((a: any) => `- ${a.description.slice(0, 100)}${a.error ? ` | Error: ${a.error.slice(0, 80)}` : ""}${a.reflection ? ` | Reflection: ${a.reflection.slice(0, 80)}` : ""}`)
          .join("\n");

        // Scout-specific: gather rejection data to feed into evolver prompt
        let scoutRejectionSection = "";
        if (agent === "scout") {
          const rejections = await sql`
            SELECT c.name, c.kill_reason, a.decision_note
            FROM companies c
            LEFT JOIN approvals a ON a.company_id = c.id AND a.gate_type = 'new_company'
            WHERE c.status = 'killed' AND c.killed_at > now() - interval '30 days'
            ORDER BY c.killed_at DESC
            LIMIT 20
          `;
          if (rejections.length > 0) {
            // Group rejection reasons for pattern detection
            const reasonCounts: Record<string, number> = {};
            for (const r of rejections) {
              const reason = (r as any).kill_reason || (r as any).decision_note || "no reason given";
              const normalized = reason.slice(0, 60).toLowerCase();
              reasonCounts[normalized] = (reasonCounts[normalized] || 0) + 1;
            }
            const commonReasons = Object.entries(reasonCounts)
              .sort((a, b) => b[1] - a[1])
              .map(([reason, count]) => `  - "${reason}" (${count}x)`)
              .join("\n");
            const recentList = rejections.slice(0, 10)
              .map((r: any) => `  - ${r.name}: ${r.kill_reason || r.decision_note || "no reason"}`)
              .join("\n");
            scoutRejectionSection = `\n## REJECTION ANALYSIS:
${rejections.length} ideas rejected in last 30 days.
Common rejection reasons:
${commonReasons}
Recent rejections:
${recentList}

Use this rejection data to improve the Scout prompt — address the patterns that lead to rejections.
For example: if rejections cite "too niche", emphasize broader markets. If "already exists", add duplicate checking.\n`;
          }
        }

        const evolverOutput = await dispatch({
          agent: "evolver",
          prompt: `You are the Prompt Evolver. Your job is to improve an agent's system prompt based on its recent performance data.

## Agent: ${agent}
## Performance (last 14 days): ${successes}/${total} success (${Math.round(successRate * 100)}%), ${failures} failures

## Recent failures:
${failureDetails || "No specific failures logged"}
${scoutRejectionSection}
## Current prompt:
${currentPrompt.slice(0, 3000)}

## Your task:
1. Analyze the failure patterns — what's causing the agent to fail?
2. Identify 2-3 specific improvements to the prompt that would prevent these failures
3. Write an IMPROVED version of the full prompt

## Rules:
- Keep the same output JSON schema — downstream parsers depend on it
- Keep the same role and responsibilities — don't change what the agent does
- Focus on: clearer instructions, better edge case handling, stronger guardrails
- The improvement must be specific and traceable to the failure data
- Do NOT add generic filler — every change must address an observed problem

## Output format (JSON):
{
  "analysis": {
    "failure_patterns": ["pattern1", "pattern2"],
    "proposed_changes": ["change1", "change2"]
  },
  "improved_prompt": "The full improved prompt text here"
}`,
          timeoutMs: 10 * 60 * 1000,
        });

        // Parse and store the new prompt version
        try {
          const jsonMatch = evolverOutput.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const result = JSON.parse(jsonMatch[0]);
            if (result.improved_prompt) {
              // Store as new version (not yet active)
              await sql`
                INSERT INTO agent_prompts (agent, version, prompt_text, performance_score, sample_size)
                VALUES (${agent}, ${nextVersion}, ${result.improved_prompt}, ${successRate}, ${total})
              `;

              // Create approval gate
              await sql`
                INSERT INTO approvals (gate_type, title, description, context)
                VALUES (
                  'prompt_upgrade',
                  ${`Upgrade ${agent} prompt to v${nextVersion}`},
                  ${`Current performance: ${Math.round(successRate * 100)}% success over ${total} actions.\n\n` +
                    `**Failure patterns:**\n${(result.analysis?.failure_patterns || []).map((p: string) => `- ${p}`).join("\n")}\n\n` +
                    `**Proposed changes:**\n${(result.analysis?.proposed_changes || []).map((c: string) => `- ${c}`).join("\n")}\n\n` +
                    `Review the new prompt in the agent_prompts table (version ${nextVersion}).`},
                  ${JSON.stringify({ agent, version: nextVersion, previous_score: successRate, sample_size: total })}
                )
              `;

              console.log(`  ✓ ${agent} v${nextVersion} proposed — awaiting approval`);
            }
          }
        } catch {
          console.log(`  ⚠ Failed to parse evolver output for ${agent}`);
        }
      } catch (evolveErr: any) {
        console.log(`  ⚠ ${agent} evolution failed: ${evolveErr.message}`);
      }
    }
  } else if (!SINGLE_COMPANY && !SCOUT_ONLY) {
    const reason = !isWednesday ? "not Wednesday" : "no completed cycles to analyze";
    console.log(`\n🧬 Prompt Evolver — skipped (${reason})`);
  }

  // === DAILY DIGEST EMAIL ===
  console.log("\n📧 Sending daily digest...");
  const pendingApprovals = await getPendingApprovals();

  try {
    const resendKey = await getSettingValueDirect("resend_api_key");
    const digestTo = await getSettingValueDirect("digest_email");
    const dashboardUrl = process.env.NEXT_PUBLIC_URL || "http://localhost:3000";

    if (digestTo && resendKey) {
      // Gather portfolio metrics
      const portfolioMetrics = await sql`
        SELECT 
          COALESCE(SUM(m.mrr), 0) as total_mrr,
          COALESCE(SUM(m.customers), 0) as total_customers
        FROM metrics m
        JOIN companies c ON c.id = m.company_id
        WHERE c.status IN ('mvp', 'active')
          AND m.date >= CURRENT_DATE - 1
      `;

      const totalMrr = Number(portfolioMetrics[0]?.total_mrr || 0);
      const totalCustomers = Number(portfolioMetrics[0]?.total_customers || 0);
      const durationStr = `${Math.round((Date.now() - startTime) / 1000)}s`;
      const dateStr = new Date().toLocaleDateString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

      // Build company results rows
      const companyRows = results.map(r => {
        const statusColor = r.status === "complete" ? "#1D9E75" : "#E24B4A";
        const statusIcon = r.status === "complete" ? "✓" : "✗";
        return `<tr><td style="padding:10px 16px;border-bottom:1px solid #2C2C2A">
          <strong style="color:#F0F0EC">${r.company}</strong>
          <span style="margin-left:8px;padding:2px 8px;border-radius:10px;font-size:12px;background:${statusColor};color:#fff">${statusIcon} ${r.status}</span>
          <span style="color:#888780;font-size:12px;margin-left:8px">${r.duration}s</span>
        </td></tr>`;
      }).join("");

      // Build approvals rows
      const approvalRows = pendingApprovals.length
        ? pendingApprovals.map((a: any) =>
          `<tr><td style="padding:8px 16px;border-bottom:1px solid #2C2C2A;color:#F0F0EC;font-size:14px">
            <span style="padding:2px 8px;border-radius:4px;background:#534AB7;color:#fff;font-size:12px;margin-right:8px">${a.gate_type}</span>${a.title}
          </td></tr>`).join("")
        : `<tr><td style="padding:8px 16px;color:#888780;font-size:14px">No pending approvals</td></tr>`;

      // Build error section
      const failedCompanies = results.filter(r => r.status === "failed");
      const errorsHtml = failedCompanies.length
        ? `<div style="margin:16px 0;padding:12px 16px;border-left:3px solid #E24B4A;background:#1a1a18">
            <strong style="color:#E24B4A">Errors:</strong>
            <ul style="margin:4px 0 0;padding-left:18px;font-size:13px;color:#F09595">${failedCompanies.map(r => `<li>${r.company} cycle failed</li>`).join("")}</ul>
          </div>` : "";

      const digestHtml = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0a0a09;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#B4B2A9">
        <div style="max-width:600px;margin:0 auto;padding:24px">
          <div style="text-align:center;margin-bottom:24px">
            <h1 style="color:#EF9F27;font-size:20px;margin:8px 0 0">Hive nightly digest</h1>
            <div style="color:#888780;font-size:13px">${dateStr} — ${durationStr}</div>
          </div>
          <table style="width:100%;margin-bottom:16px"><tr>
            <td style="text-align:center;padding:12px;background:#1a1a18;border-radius:8px"><div style="color:#EF9F27;font-size:22px;font-weight:600">€${totalMrr}</div><div style="color:#888780;font-size:12px">MRR</div></td>
            <td style="width:8px"></td>
            <td style="text-align:center;padding:12px;background:#1a1a18;border-radius:8px"><div style="color:#5DCAA5;font-size:22px;font-weight:600">${totalCustomers}</div><div style="color:#888780;font-size:12px">Customers</div></td>
            <td style="width:8px"></td>
            <td style="text-align:center;padding:12px;background:#1a1a18;border-radius:8px"><div style="color:#AFA9EC;font-size:22px;font-weight:600">${results.length}</div><div style="color:#888780;font-size:12px">Companies</div></td>
          </tr></table>
          ${errorsHtml}
          <h2 style="color:#F0F0EC;font-size:16px;margin:20px 0 8px">Company results</h2>
          <table style="width:100%;border-collapse:collapse;background:#111110;border-radius:8px;overflow:hidden">${companyRows || `<tr><td style="padding:12px 16px;color:#888780">No active companies</td></tr>`}</table>
          <h2 style="color:#F0F0EC;font-size:16px;margin:20px 0 8px">Awaiting your decision</h2>
          <table style="width:100%;border-collapse:collapse;background:#111110;border-radius:8px;overflow:hidden">${approvalRows}</table>
          <div style="text-align:center;margin-top:24px;padding-top:16px;border-top:1px solid #2C2C2A">
            <a href="${dashboardUrl}" style="color:#EF9F27;text-decoration:none;font-size:13px">Open Hive dashboard</a>
          </div>
        </div></body></html>`;

      // Send via Resend API
      const sendingDomain = await getSettingValueDirect("sending_domain");
      const digestFrom = sendingDomain
        ? `Hive <digest@${sendingDomain}>`
        : "Hive <onboarding@resend.dev>"; // test mode — only delivers to Resend account owner
      const emailRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: digestFrom,
          to: digestTo,
          subject: `🐝 Hive Digest — ${new Date().toLocaleDateString()}`,
          html: digestHtml,
        }),
      });

      if (emailRes.ok) {
        console.log(`  ✓ Digest sent to ${digestTo}`);
      } else {
        const emailErr = await emailRes.text();
        console.log(`  ⚠ Digest failed: ${emailErr}`);
      }
    } else {
      console.log(`  ⓘ Skipped — ${!resendKey ? "no resend_api_key" : "no digest_email"} in settings`);
    }
  } catch (digestErr: any) {
    console.log(`  ⚠ Digest error: ${digestErr.message}`);
  }

  const totalDuration = Math.round((Date.now() - startTime) / 1000);

  // === STEP 9: OPERATIONAL REFLECTION ===
  // The orchestrator reflects on its own run, updates BRIEFING.md, checks ROADMAP.md milestones,
  // and self-diagnoses recurring issues. This is what makes Hive self-aware.
  if (!DRY_RUN && !SCOUT_ONLY) {
    console.log("\n📝 Operational Reflection — updating platform context");
    try {
      // Gather run data for the reflection
      const completedCount = results.filter(r => r.status === "complete").length;
      const failedCompanies = results.filter(r => r.status === "failed");
      
      const allCompaniesNow = await sql`SELECT name, slug, status, description FROM companies`;
      const activeNow = allCompaniesNow.filter((c: any) => ["mvp", "active"].includes(c.status));
      const pipelineNow = allCompaniesNow.filter((c: any) => ["idea", "approved", "provisioning", "mvp", "active"].includes(c.status));

      const pendingApprovals = await sql`
        SELECT a.gate_type, a.title, c.slug as company_slug
        FROM approvals a LEFT JOIN companies c ON c.id = a.company_id
        WHERE a.status = 'pending'
      `;

      // Get recent errors for self-diagnosis
      const recurringErrors = await sql`
        SELECT agent, error, COUNT(*) as cnt, 
               array_agg(DISTINCT c.slug) as affected_companies
        FROM agent_actions aa
        LEFT JOIN companies c ON c.id = aa.company_id
        WHERE aa.status = 'failed' AND aa.started_at > now() - interval '7 days'
        GROUP BY agent, error
        HAVING COUNT(*) >= 2
        ORDER BY cnt DESC LIMIT 5
      `;

      // Get latest cycle scores
      const latestScores = await sql`
        SELECT DISTINCT ON (c.slug) c.slug, cy.ceo_review, cy.cycle_number
        FROM cycles cy JOIN companies c ON c.id = cy.company_id
        WHERE cy.ceo_review IS NOT NULL
        ORDER BY c.slug, cy.started_at DESC
      `;

      // Check which settings are configured
      const settings = await sql`SELECT key FROM settings`;
      const configuredKeys = settings.map((s: any) => s.key);
      const missingCritical = ["resend_api_key", "digest_email", "sending_domain", "gemini_api_key", "groq_api_key"]
        .filter(k => !configuredKeys.includes(k));

      // Get playbook count
      const [playbookCount] = await sql`SELECT COUNT(*) as cnt FROM playbook WHERE superseded_by IS NULL`;

      // Build the reflection context
      const reflectionData = {
        run: {
          date: new Date().toISOString().split("T")[0],
          duration: `${Math.floor(totalDuration / 60)}m ${totalDuration % 60}s`,
          companies_processed: `${completedCount}/${results.length}`,
          failures: failedCompanies.map((f: any) => f.company),
        },
        portfolio: {
          active: activeNow.map((c: any) => `${c.name} (${c.slug}) — ${c.status}`),
          pipeline_total: pipelineNow.length,
          pending_approvals: pendingApprovals.map((a: any) => `[${a.gate_type}] ${a.title}`),
        },
        health: {
          recurring_errors: recurringErrors.map((e: any) => ({
            agent: e.agent,
            error: (e.error || "").slice(0, 100),
            count: Number(e.cnt),
            companies: e.affected_companies,
          })),
          missing_settings: missingCritical,
        },
        scores: latestScores.map((s: any) => {
          let score = "?";
          try { const r = typeof s.ceo_review === "string" ? JSON.parse(s.ceo_review) : s.ceo_review; score = r?.review?.score ?? r?.score ?? "?"; } catch {}
          return `${s.slug}: ${score}/10 (cycle ${s.cycle_number})`;
        }),
        playbook_entries: Number(playbookCount.cnt),
      };

      await dispatch({
        agent: "ceo", // uses Claude — this is strategic reflection
        prompt: `You are the Hive Operational Reflector. After each nightly run, you update Hive's institutional memory.

## Tonight's run data:
${JSON.stringify(reflectionData, null, 2)}

## Your tasks (execute ALL of them):

### 1. Update BRIEFING.md "Current State" section
Rewrite the "## Current State" section in BRIEFING.md with tonight's actual data:
- Phase (based on ROADMAP.md — which phase are we in?)
- Production URL (https://hive-phi.vercel.app)
- Active companies list with status
- Pipeline count
- Blockers (recurring errors, missing settings, any company stuck for 3+ cycles)
- What was resolved tonight

### 2. Append to BRIEFING.md "Recent Context"
Add a new entry at the top of the "## Recent Context" section:
\`\`\`
### ${new Date().toISOString().split("T")[0]} [orch] Nightly run summary
[Write 2-3 sentences: what happened, what worked, what's concerning]
\`\`\`

### 3. Check ROADMAP.md milestones
Read ROADMAP.md. For each unchecked milestone, check if the condition is now met:
- "First nightly cycle completes successfully" → if completedCount > 0 and failures = 0, check it
- "Configure API keys" → if gemini + groq + resend are all configured, check it
- "First company deployed to production" → if any company has status 'active', check it
- "Cross-company playbook has 20+ entries" → if playbook count >= 20, check it
- etc.
Change \`- [ ]\` to \`- [x]\` for any newly completed milestones.

### 4. Self-diagnose recurring issues
If any error appears 3+ times in the last 7 days:
- Write it to BRIEFING.md as a blocker
- If it's a code bug you can fix, add it to BACKLOG.md as P0
- If it reveals a pattern, write to MISTAKES.md

### 5. Update BRIEFING.md "What's Next"
Based on tonight's data + ROADMAP.md phase, rewrite "What's Next" with the actual next priorities.
Don't copy from a Chat session — derive this from the data you see.

### 6. Commit
\`\`\`bash
git add BRIEFING.md ROADMAP.md MISTAKES.md BACKLOG.md
git commit -m "orch: nightly reflection — ${new Date().toISOString().split("T")[0]}"
\`\`\`
Only commit files that actually changed.

## Rules:
- Be factual. Write what happened, not what should have happened.
- If CEO scores are all N/A, flag it as a problem to investigate (don't ignore it).
- If the same error keeps recurring, escalate it — don't just log it again.
- Keep BRIEFING.md entries concise. Trim the Recent Context section to last 10 entries.
- Don't touch CLAUDE.md or DECISIONS.md — those change only during architecture sessions.`,
        cwd: process.cwd(), // Hive repo
        maxTurns: 15,
        timeoutMs: 5 * 60 * 1000,
      });

      console.log("  ✓ Reflection complete — BRIEFING.md + ROADMAP.md updated");
    } catch (reflectErr: any) {
      console.log(`  ⚠ Reflection failed: ${reflectErr.message}`);
      // Non-critical — the run still succeeded, we just didn't update context
    }
  }

  console.log(`\n🐝 Nightly cycle complete in ${totalDuration}s`);
  console.log(`${"─".repeat(50)}\n`);
}

// === RUN ===
runNightlyCycle().catch(err => {
  console.error("❌ Orchestrator crashed:", err);
  process.exit(1);
});
