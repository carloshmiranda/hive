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

// Agent → Provider mapping
const AGENT_PROVIDER: Record<string, Provider> = {
  // Brain tier — Claude (strategic decisions, tool use, web search, code execution)
  ceo: "claude",
  idea_scout: "claude",
  venture_brain: "claude",
  healer: "claude",
  research_analyst: "claude",
  prompt_evolver: "claude",
  // Worker tier — free LLMs (content gen, simple analysis, no tool use)
  engineer: "gemini",    // Gemini 2.5 Flash (code)
  growth: "gemini",      // Gemini Flash-Lite (content)
  outreach: "gemini",    // Gemini Flash-Lite (emails)
  ops: "groq",           // Groq Llama 3.3 (fast inference for health checks)
};

// NOTE: Engineer agent uses Gemini for PLANNING/OUTPUT only.
// Actual code execution (git, npm, deploy) MUST go through Claude Code CLI.
// When the Engineer needs tool use, the executeAgent function should override to "claude".

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

  const spawnOpts: any = { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] };
  if (opts.cwd) spawnOpts.cwd = opts.cwd;

  return new Promise((resolve, reject) => {
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
  // Flash for code/complex, Flash-Lite for content/simple
  const model = opts.agent === "engineer" ? "gemini-2.5-flash" : "gemini-2.5-flash-lite";
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

  // Decrypt AES-256-GCM (colon-separated format: iv_hex:tag_hex:encrypted_hex)
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
  } catch {
    return null;
  }
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

// === AGENT EXECUTION WITH RETRY + SELF-HEAL ===
async function executeAgent(opts: {
  agent: string;
  companyId: string;
  cycleId: string;
  prompt: string;
  context: string;
  cwd?: string;
  allowedTools?: string[];
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
    const killedCompanies = allCompanies.filter(c => c.status === "killed");
    const liveCompanies = allCompanies.filter(c => ["mvp", "active"].includes(c.status));

    const ideaScoutOutput = await dispatch({
      agent: "idea_scout",
      prompt: `You are the Idea Scout agent for Hive, a venture orchestrator owned by Carlos Miranda.

YOUR JOB: Research the market using web search and propose THREE business ideas that Carlos should consider building next. He will pick one (or none).

## Carlos's profile
- 15+ years IT experience (identity/access management, device management, SaaS operations, onboarding automation)
- Based in Lisbon, Portugal
- Solo entrepreneur — all companies are run by AI agents with his approval
- Interests: personal finance, crypto/DeFi, developer tools, automation
- Existing tech stack: Next.js, Vercel, Neon, Stripe, Tailwind

## Current portfolio (${liveCompanies.length} active):
${liveCompanies.map(c => `- ${c.name} (${c.slug}): ${c.description}`).join("\n") || "No active companies yet"}

## Previously killed (avoid similar ideas):
${killedCompanies.map(c => `- ${c.name}: ${c.description} — killed because too similar or no traction`).join("\n") || "None"}

## Playbook learnings (what works):
${playbook.slice(0, 10).map(p => `- [${p.domain}] ${p.insight} (confidence: ${p.confidence})`).join("\n") || "No playbook entries yet"}

## Constraints:
- Must be buildable as a SaaS or digital product (no physical goods)
- MVP must be shippable in 1-2 weeks by AI agents
- Must have a clear monetisation path (subscription, one-time, or usage-based)
- Must NOT overlap with existing portfolio companies
- Prefer niches where Carlos's IT/SaaS background is an advantage
- Prefer markets with validated demand (people already searching for solutions)
- Target: €500-€5,000 MRR within 3 months if the idea works

## MANDATORY MIX: You MUST propose exactly 3 ideas with this market distribution:
1. **Portuguese market** — solve a challenge specific to Portugal (regulatory, cultural, language, local infrastructure gap)
2. **Global/English market** — broad SaaS play, English-first
3. **Your best pick** — whichever market you think has the strongest opportunity based on your research

## RESEARCH METHODOLOGY (you must follow this):

You have access to web search. USE IT. Do not rely on your training data alone.

### Phase 1: Portuguese market discovery (3-5 searches)
Search for CURRENT pain points in Portugal. Example queries:
- "Portugal small business challenges ${new Date().getFullYear()}"
- "Portugal housing crisis rental market ${new Date().getFullYear()}"
- "Portugal freelancer tax compliance problems"
- "Portugal digital transformation SME gaps"
- "Portugal new laws regulations ${new Date().getFullYear()}"
Look for: regulatory changes creating new compliance burdens, underserved demographics, 
markets where existing tools are foreign/generic and don't understand Portuguese specifics,
pain points people complain about on forums and social media.

### Phase 2: Global market discovery (3-5 searches)
Search for trending SaaS niches, underserved developer/business tools, emerging needs:
- "micro SaaS ideas trending ${new Date().getFullYear()}"
- "SaaS tool gaps developer tools ${new Date().getFullYear()}"
- "underserved B2B niches small business"
- Look at Product Hunt, Indie Hackers, Hacker News for signals

### Phase 3: Competition analysis (2-3 searches per niche)
For each niche you identify, search for existing solutions:
- "[niche] software" (add "Portugal" for Portuguese ideas)
- "[niche] SaaS tool"
- Search competitor names you find, check their pricing, reviews, feature gaps
You want niches where competitors are: too expensive, too generic (not PT-localised), 
enterprise-only, or simply don't exist yet.

### Phase 4: Demand validation (1-2 searches per niche)
Search for evidence people actually want this:
- Search volume proxies: "how to [solve problem]" queries
- Forum complaints, Reddit threads, social media frustration
- Government data on market size (number of landlords, freelancers, SMEs, etc.)
- News articles about the problem growing

### Phase 5: Rank and build 3 proposals
Score each niche on: demand strength, competition gap, timing (regulatory tailwind?), 
MVP feasibility (can AI agents ship it in 1-2 weeks?), Carlos's skill match.
Pick the top 3 respecting the mandatory mix above.

## Output format (JSON only, no markdown wrapping):
{
  "research": {
    "searches_performed": ["query1", "query2", ...],
    "niches_considered": [
      { 
        "niche": "...", 
        "market": "Portugal" or "Global",
        "demand_evidence": "what you found in search results",
        "competitors_found": ["name: pricing — gaps"],
        "timing": "why now",
        "verdict": "pursue / pass — reason"
      }
    ]
  },
  "proposals": [
    {
      "name": "Product Name",
      "slug": "product-slug",
      "description": "One-line pitch",
      "market": "Portugal" or "Global",
      "target_audience": "Who this is for",
      "problem": "What pain point it solves",
      "solution": "How it solves it",
      "monetisation": "Pricing model and target",
      "mvp_scope": "What the first version includes (bullet points)",
      "competitive_advantage": "Why this wins against alternatives",
      "estimated_tam": "Total addressable market estimate with source",
      "confidence": 0.0-1.0
    }
  ]
}

IMPORTANT: The "proposals" array MUST contain exactly 3 items.
At least 1 must have "market": "Portugal".
At least 1 must have "market": "Global".
Order them by your confidence score, highest first.`,
      allowedTools: ["WebSearch", "WebFetch"],
      maxTurns: 30, // more turns for broader research
      timeoutMs: 20 * 60 * 1000, // 20 min — researching 3 ideas takes longer
    });

    // Parse the output and create approval gate with all 3 proposals
    try {
      // Extract JSON from the output (Claude may wrap it in markdown)
      const jsonMatch = ideaScoutOutput.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const idea = JSON.parse(jsonMatch[0]);
        const proposals = idea.proposals || (idea.proposal ? [idea.proposal] : []);

        if (proposals.length > 0) {
          // Create each company in 'idea' status
          const createdCompanies: Array<{ id: string; name: string; slug: string; idx: number }> = [];
          for (let i = 0; i < proposals.length; i++) {
            const p = proposals[i];
            if (!p?.name || !p?.slug) continue;
            const [newCompany] = await sql`
              INSERT INTO companies (name, slug, description, status)
              VALUES (${p.name}, ${p.slug}, ${p.description}, 'idea')
              ON CONFLICT (slug) DO NOTHING
              RETURNING *
            `;
            if (newCompany) {
              createdCompanies.push({ id: newCompany.id, name: p.name, slug: p.slug, idx: i });
            }
          }

          if (createdCompanies.length > 0) {
            // Build a single approval gate describing all 3 options
            const researchSummary = idea.research ? [
              idea.research.searches_performed?.length 
                ? `**Searches performed:** ${idea.research.searches_performed.length} web queries` : "",
              ...(idea.research.niches_considered || []).map((n: any) =>
                `- **${n.niche}** (${n.market || "unknown"}): ${n.verdict}`
              ),
            ].filter(Boolean).join("\n") : "";

            const proposalDescriptions = proposals.map((p: any, i: number) => {
              const num = i + 1;
              const marketTag = p.market === "Portugal" ? "🇵🇹 PT" : "🌍 Global";
              return `### Option ${num}: ${p.name} [${marketTag}]\n` +
                `**${p.description}**\n` +
                `- **Problem:** ${p.problem}\n` +
                `- **Solution:** ${p.solution}\n` +
                `- **Target:** ${p.target_audience}\n` +
                `- **Monetisation:** ${p.monetisation}\n` +
                `- **MVP scope:** ${p.mvp_scope}\n` +
                `- **Competitive advantage:** ${p.competitive_advantage || "N/A"}\n` +
                `- **TAM:** ${p.estimated_tam}\n` +
                `- **Confidence:** ${Math.round((p.confidence || 0.5) * 100)}%`;
            }).join("\n\n---\n\n");

            // Create ONE approval per proposal (so Carlos can approve individually)
            for (const cc of createdCompanies) {
              const p = proposals[cc.idx];
              const num = cc.idx + 1;
              const marketTag = p.market === "Portugal" ? "🇵🇹 PT" : "🌍 Global";
              await sql`
                INSERT INTO approvals (company_id, gate_type, title, description, context)
                VALUES (
                  ${cc.id},
                  'new_company',
                  ${"Option " + num + ": Launch " + p.name + " [" + marketTag + "]"},
                  ${`**${p.description}**\n\n` +
                    `**Market:** ${p.market || "Global"}\n` +
                    `**Problem:** ${p.problem}\n` +
                    `**Solution:** ${p.solution}\n` +
                    `**Target:** ${p.target_audience}\n` +
                    `**Monetisation:** ${p.monetisation}\n` +
                    `**MVP scope:** ${p.mvp_scope}\n` +
                    `**Competitive advantage:** ${p.competitive_advantage || "N/A"}\n` +
                    `**TAM:** ${p.estimated_tam}\n` +
                    `**Confidence:** ${Math.round((p.confidence || 0.5) * 100)}%\n\n` +
                    `---\n### Research trail\n${researchSummary}`},
                  ${JSON.stringify({ proposal: p, all_proposals: proposals, research: idea.research })}
                )
              `;
            }

            console.log(`  ✓ Proposed ${createdCompanies.length} ideas — awaiting approval:`);
            createdCompanies.forEach(cc => {
              const p = proposals[cc.idx];
              console.log(`    ${cc.idx + 1}. ${p.name} (${p.slug}) [${p.market || "Global"}] — ${Math.round((p.confidence || 0.5) * 100)}%`);
            });
            if (idea.research?.searches_performed?.length) {
              console.log(`    Research: ${idea.research.searches_performed.length} web searches, ${(idea.research.niches_considered || []).length} niches evaluated`);
            }

            // Log the action
            await sql`
              INSERT INTO agent_actions (company_id, agent, action_type, description, status, output, started_at, finished_at)
              VALUES (${null}, 'idea_scout', 'generate_ideas', ${`Proposed ${proposals.length} ideas: ${proposals.map((p: any) => `${p.name} [${p.market}]`).join(", ")} (${(idea.research?.searches_performed || []).length} searches)`}, 'success', ${JSON.stringify(idea)}, now(), now())
            `;
          } else {
            console.log(`  ⓘ All proposed slugs already exist — skipping`);
          }
        }
      }
    } catch (e: any) {
      console.log(`  ⚠ Failed to parse Idea Scout output: ${e.message}`);
      console.log(`    Output length: ${ideaScoutOutput.length}`);
      console.log(`    Raw preview: ${ideaScoutOutput.slice(0, 300)}`);
      // Still log the raw output so it's not lost
      await sql`
        INSERT INTO agent_actions (company_id, agent, action_type, description, status, error, output, started_at, finished_at)
        VALUES (${null}, 'idea_scout', 'generate_ideas', 'Failed to parse idea proposals', 'failed', ${e.message}, ${JSON.stringify({ raw: ideaScoutOutput })}, now(), now())
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
        SELECT domain, insight, source_company, confidence 
        FROM playbook WHERE superseded_by IS NULL AND confidence >= 0.6
        ORDER BY confidence DESC LIMIT 30
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
7. Set environment variables in Vercel: DATABASE_URL, STRIPE_SECRET_KEY, NEXT_PUBLIC_URL
8. Create a Stripe product + price tagged with hive_company: ${company.slug}
9. Record all resource IDs in the infra table via the Hive API
10. Update company status to 'mvp' and set vercel_url

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
        cwd: `/Users/carlos.miranda/Documents/Github/${imp.slug}`,
      });

      // Phase 2: Pattern extraction
      console.log(`  ├─ Extracting patterns from ${imp.name}...`);
      await dispatch({
        prompt: `You are the Pattern Extraction agent. Analyze this imported codebase to find reusable learnings.

Project: ${imp.name} (${imp.slug})
Scan Report: ${JSON.stringify(scanReport, null, 2)}

Read the actual code and extract patterns that would benefit other Hive companies.
Look for:

1. CHECKOUT/PRICING: How does this project handle payments? What's the pricing model?
   Write playbook entries under domain "pricing" or "payments".

2. EMAIL/COMMS: Are there email templates, drip sequences, notification patterns?
   Write playbook entries under domain "email_marketing".

3. ONBOARDING: How does the product onboard new users? What's the activation flow?
   Write playbook entries under domain "onboarding".

4. SEO/GROWTH: Meta tags, sitemap, social cards, content strategy, analytics setup?
   Write playbook entries under domain "seo" or "growth".

5. TECH PATTERNS: Auth setup, API design, cron jobs, deployment config, error handling?
   Write playbook entries under domain "engineering".

For each pattern, write to the playbook table via the Hive API:
POST /api/playbook with { domain, insight, source_company, confidence }

Confidence guide:
- 0.8-1.0: proven pattern with measurable results
- 0.5-0.7 : reasonable pattern, untested at scale

If you find patterns that should update the Hive boilerplate, create a directive via:
POST /api/directives with { text: "hive: [suggestion]" }`,
        cwd: `/Users/carlos.miranda/Documents/Github/${imp.slug}`,
      });

      // Phase 3: Knowledge Assimilation
      console.log(`  ├─ Assimilating knowledge from ${imp.name}...`);
      try {
        const companyDir = `/Users/carlos.miranda/Documents/Github/${imp.slug}`;
        const claudeMemDir = join(process.env.HOME || "", `.claude/projects/-Users-carlos-miranda-Documents-Github-${imp.slug}/memory`);

        const mdFiles: string[] = [];
        for (const fname of ["CLAUDE.md", "MISTAKES.md", "DECISIONS.md", "BACKLOG.md", "MEMORY.md"]) {
          const fpath = join(companyDir, fname);
          if (existsSync(fpath)) {
            const content = readFileSync(fpath, "utf-8");
            if (content.trim()) mdFiles.push(`=== ${fname} ===\n${content.slice(0, 3000)}`);
          }
        }

        if (existsSync(claudeMemDir)) {
          try {
            const { readdirSync } = await import("fs");
            for (const f of readdirSync(claudeMemDir).filter(f => f.endsWith(".md") && f !== "MEMORY.md")) {
              const content = readFileSync(join(claudeMemDir, f), "utf-8");
              if (content.trim()) mdFiles.push(`=== memory/${f} ===\n${content.slice(0, 1500)}`);
            }
          } catch {}
        }

        if (mdFiles.length > 0) {
          const hiveDir = `/Users/carlos.miranda/Documents/Github/hive`;
          const hiveMistakes = existsSync(join(hiveDir, "MISTAKES.md")) ? readFileSync(join(hiveDir, "MISTAKES.md"), "utf-8").slice(0, 2000) : "";
          const hivePlaybook = await getPlaybook();

          await dispatch({
            agent: "ceo",
            prompt: `You are assimilating knowledge from an imported company into Hive's institutional memory.

## Source: ${imp.name} (${imp.slug})
${mdFiles.join("\n\n")}

## Hive's current knowledge:
### MISTAKES.md (last 2000 chars):
${hiveMistakes}

### Playbook entries (top 20):
${hivePlaybook.map((p: any) => `- [${p.domain}] ${p.insight}`).join("\n") || "Empty"}

## Your task:
Compare the imported company's knowledge against Hive's existing knowledge.
For each NEW learning (not already captured):
1. If it's a reusable pattern → write to playbook via POST /api/playbook
2. If it's a mistake/gotcha → note it for MISTAKES.md
3. If it's an architectural decision → note it for DECISIONS.md

Do NOT duplicate what Hive already knows. Only add genuinely new insights.
Output a brief summary of what was assimilated.`,
            timeoutMs: 5 * 60 * 1000,
          });
          console.log(`    ✓ Knowledge assimilated from ${mdFiles.length} files`);
        }
      } catch (kaErr: any) {
        console.log(`    ⚠ Knowledge assimilation failed: ${kaErr.message.slice(0, 80)}`);
      }

      await sql`UPDATE imports SET onboard_status = 'complete' WHERE id = ${imp.id}`;
      const [impCompany] = await sql`SELECT status FROM companies WHERE id = ${imp.company_id}`;
      if (impCompany?.status === "approved" || impCompany?.status === "provisioning") {
        await sql`UPDATE companies SET status = 'mvp', updated_at = now() WHERE id = ${imp.company_id}`;
        console.log(`    ✓ ${imp.name} status → mvp`);
      }
      console.log(`  ✓ ${imp.name} onboarded with patterns extracted + knowledge assimilated`);
    }
  }

  // === COMPANY CYCLES ===
  // Priority order: lowest-scoring companies first (they need the most help)
  // New companies (no cycles yet) go first to get their initial momentum
  const companies = await sql`
    SELECT c.*, 
      COALESCE(
        (SELECT score FROM cycles WHERE company_id = c.id ORDER BY started_at DESC LIMIT 1),
        0
      ) as last_score,
      COALESCE(
        (SELECT COUNT(*) FROM cycles WHERE company_id = c.id),
        0
      ) as cycle_count
    FROM companies c
    WHERE c.status IN ('mvp', 'active')
    ORDER BY 
      cycle_count ASC,        -- new companies first (0 cycles)
      last_score ASC,         -- struggling companies next (low score)
      c.created_at ASC        -- oldest as tiebreaker
  `;
  const companiesToProcess = SINGLE_COMPANY ? companies.filter((r: any) => r.slug === SINGLE_COMPANY) : companies;
  
  console.log(`\n📋 ${companiesToProcess.length} active companies to process`);
  if (companiesToProcess.length > 0) {
    console.log(`  Priority order: ${companiesToProcess.map((c: any) => `${c.slug}(score:${c.last_score || "new"},cycles:${c.cycle_count})`).join(" → ")}`);
  }
  console.log("");

  const results: Array<{ company: string; status: string; duration: number }> = [];

  for (const company of companiesToProcess) {
    const companyStart = Date.now();
    console.log(`\n▸ ${company.name} (${company.slug}) — ${company.status} [score: ${company.last_score || "new"}, cycles: ${company.cycle_count}]`);

    try {
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

      const researchPrompt = await getActivePrompt("research_analyst", companyCtx);

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
        agent: "research_analyst",
        allowedTools: ["WebSearch", "WebFetch"],
        prompt: researchPrompt + `\n\nProduce ${reportsToGenerate} for this company.

COMPANY: ${company.name}
DESCRIPTION: ${company.description}
TARGET AUDIENCE: ${(company as any).target_audience || "see idea proposal context"}
${researchReports.length > 0 ? `\nEXISTING REPORTS (for reference/update):\n${researchReports.map((r: any) => `[${r.report_type}] ${r.summary}`).join("\n")}` : ""}

Use web search extensively.
${reportMarkers}

After each JSON block, write a 1-2 sentence summary.`,
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
              // Extract summary (text after the JSON block)
              const afterJson = match[1].slice(match[1].lastIndexOf("}") + 1).trim();
              const summaryLines = afterJson.split("\n").filter(l => {
                const t = l.trim();
                return t && !t.startsWith("```") && t !== "---";
              });
              const summary = summaryLines[0]?.trim() || Object.keys(content).slice(0, 3).join(", ") || null;

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
        VALUES (${company.id}, ${cycleId}, 'research_analyst', 'cycle_0_research',
          ${`Cycle 0 research completed: ${reportTypes.length} reports`}, 'success', now(), now())
      `;
    }

    // Step 1: CEO plans (incorporating directives)
    console.log("  ├─ CEO planning...");
    const ceoPrompt = await getActivePrompt("ceo", companyCtx);
    const ceoPlan = await executeAgent({
      agent: "ceo",
      companyId: company.id,
      cycleId,
      prompt: ceoPrompt + "\n\nWrite tonight's plan." + 
        (directives.length > 0 ? `\n\nIMPORTANT: Carlos has given ${directives.length} directive(s). These take priority. Incorporate them into your plan and note which directive IDs you're addressing.` : ""),
      context,
    });

    // Close directives that the CEO incorporated
    for (const d of directives) {
      await closeDirective(d.id, `Incorporated into cycle ${cycleNumber} plan`);
    }

    // Step 2: Engineer executes
    console.log("  ├─ Engineer executing...");
    const engPrompt = await getActivePrompt("engineer", companyCtx);
    // Pre-clone repo if not present (Gemini agents can't use git)
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
    const engResult = await executeAgent({
      agent: "engineer",
      companyId: company.id,
      cycleId,
      prompt: engPrompt + `\n\nCEO PLAN: ${ceoPlan.output}\n\nExecute the engineering tasks.`,
      context,
      cwd: companyRepoExists ? companyCwd : undefined,
    });

    // Step 3: Growth executes (inbound: content, SEO, social)
    console.log("  ├─ Growth executing...");
    const growthPrompt = await getActivePrompt("growth", companyCtx);
    const growthResult = await executeAgent({
      agent: "growth",
      companyId: company.id,
      cycleId,
      prompt: growthPrompt + `\n\nCEO PLAN: ${ceoPlan.output}\n\nExecute the growth tasks. You have access to research reports — use SEO keywords and market research to inform content.`,
      context,
    });

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
        allowedTools: ["WebSearch", "WebFetch"],
        prompt: outreachPrompt + `\n\nCEO PLAN: ${ceoPlan.output}\n\n` +
          (leadList ? "Review your existing lead list. Draft new cold emails for uncontacted leads. Plan follow-ups for leads that haven't replied. Find new leads if the list is thin (<10 active leads)."
            : "No lead list yet. Build the initial lead list using web search. Find 10-20 potential customers matching the target audience.") +
          "\n\nOutput your results as JSON. Use the lead_list and outreach_log report type formats from your instructions.",
        context: outreachContext,
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

    // Step 5: CEO reviews (pass cycle results directly — non-interactive mode can't fetch APIs)
    console.log("  └─ CEO reviewing cycle...");
    const cycleResults = `
TONIGHT'S CYCLE RESULTS (for your review):
ENGINEER (${engResult.success ? "success" : "failed"}):
${engResult.output.slice(0, 500)}
GROWTH (${growthResult.success ? "success" : "failed"}):
${growthResult.output.slice(0, 500)}
OPS (${opsResult.success ? "success" : "failed"}):
${opsResult.output.slice(0, 500)}`.trim();

    const ceoReview = await executeAgent({
      agent: "ceo",
      companyId: company.id,
      cycleId,
      prompt: ceoPrompt + `\n\n${cycleResults}\n\nReview tonight's cycle results. Score the cycle 1-10. Write assessment. Include a playbook_entry if you learned something worth sharing across companies.`,
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

    await updateCycle(cycleId, { status: "completed", ceo_plan: ceoPlan.output, ceo_review: ceoReview.output });

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
          agent: "healer",
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
              VALUES ('healer', 'self_heal', ${`Fixed ${fixCount} systemic error(s)${unfixable > 0 ? `, ${unfixable} unfixable` : ""}`}, 
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
        SELECT domain, insight, source_company, confidence
        FROM playbook 
        WHERE superseded_by IS NULL 
          AND domain = ${pattern.agent === "engineer" ? "engineering" : pattern.agent}
          AND confidence >= 0.5
        ORDER BY confidence DESC
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
      SELECT domain, insight, source_company, confidence, created_at
      FROM playbook WHERE superseded_by IS NULL
      ORDER BY created_at DESC LIMIT 20
    `;

    // Gather recent cycle scores for trend analysis
    const cycleScores = await sql`
      SELECT c.slug, cy.cycle_number, cy.score, cy.started_at
      FROM cycles cy
      JOIN companies c ON c.id = cy.company_id
      WHERE cy.started_at > now() - interval '14 days' AND cy.score IS NOT NULL
      ORDER BY c.slug, cy.started_at DESC
    `;

    try {
      await dispatch({
        agent: "venture_brain",
        prompt: `You are the Venture Brain. Analyze the portfolio:

## Metrics (last 7 days):
${JSON.stringify(allMetrics, null, 2)}

## Cycle scores (last 14 days):
${cycleScores.map((s: any) => `${s.slug}: cycle ${s.cycle_number} → ${s.score}/10`).join("\n") || "No scored cycles yet"}

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

    const agents = ["ceo", "engineer", "growth", "ops"];

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

        const evolverOutput = await dispatch({
          agent: "prompt_evolver",
          prompt: `You are the Prompt Evolver. Your job is to improve an agent's system prompt based on its recent performance data.

## Agent: ${agent}
## Performance (last 14 days): ${successes}/${total} success (${Math.round(successRate * 100)}%), ${failures} failures

## Recent failures:
${failureDetails || "No specific failures logged"}

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

  // === LOG CONTEXT ENTRY ===
  // Write a summary of this run to context_log for cross-tool visibility
  if (!DRY_RUN) {
    try {
      const completedCount = results.filter(r => r.status === "complete").length;
      const failedCompanies = results.filter(r => r.status === "failed").map(r => r.company);
      const summary = [
        `Nightly cycle: ${completedCount}/${results.length} companies processed in ${totalDuration}s`,
        failedCompanies.length > 0 ? `Failed: ${failedCompanies.join(", ")}` : null,
        failedCount > 0 ? `Self-healing addressed ${failedCount} error(s)` : null,
      ].filter(Boolean).join(". ");

      await sql`
        INSERT INTO context_log (source, category, summary, tags)
        VALUES ('orch', 'milestone', ${summary}, ${`{nightly,cycle}`})
      `;
    } catch { /* non-critical */ }
  }

  console.log(`\n🐝 Nightly cycle complete in ${totalDuration}s`);
  console.log(`${"─".repeat(50)}\n`);
}

// === RUN ===
runNightlyCycle().catch(err => {
  console.error("❌ Orchestrator crashed:", err);
  process.exit(1);
});
