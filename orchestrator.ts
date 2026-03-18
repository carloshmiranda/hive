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
import { createDecipheriv } from "crypto";
import { neon } from "@neondatabase/serverless";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

// === CONFIG ===
const HIVE_API = process.env.HIVE_API_URL || "http://localhost:3000/api";
const DATABASE_URL = process.env.DATABASE_URL!;
const MAX_RETRIES = 3;
const REFLECTION_ATTEMPTS = 2;
const MESSAGES_PER_COMPANY = 40; // budget from Max 5x window
const DRY_RUN = process.argv.includes("--dry-run");
const SINGLE_COMPANY = process.argv.find((_, i, a) => a[i - 1] === "--company");
const FORCE_SCOUT = process.argv.includes("--scout"); // Force idea generation
const SCOUT_ONLY = process.argv.includes("--scout-only"); // Run only idea scout, skip companies

const sql = neon(DATABASE_URL);

// === DISPATCH: The abstraction layer for cloud migration ===
interface DispatchOptions {
  prompt: string;
  cwd?: string;
  allowedTools?: string[];
  maxTurns?: number;
  timeoutMs?: number; // default 5min, research tasks need more
}

async function dispatch(opts: DispatchOptions): Promise<string> {
  if (DRY_RUN) {
    console.log(`[DRY RUN] Would dispatch: ${opts.prompt.slice(0, 100)}...`);
    return "[DRY RUN] No output";
  }

  // Build args
  const args = ["-p", opts.prompt, "--output-format", "text"];
  if (opts.cwd) args.push("--cwd", opts.cwd);
  if (opts.allowedTools?.length) args.push("--allowedTools", opts.allowedTools.join(","));
  if (opts.maxTurns) args.push("--max-turns", opts.maxTurns.toString());

  const timeout = opts.timeoutMs || 5 * 60 * 1000;

  return new Promise((resolve, reject) => {
    const proc = spawn("claude", args, {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let killed = false;

    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      killed = true;
      proc.kill("SIGTERM");
      setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
    }, timeout);

    proc.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (killed) reject(new Error(`Dispatch timed out after ${Math.round(timeout / 1000)}s`));
      else if (code !== 0) reject(new Error(`Dispatch exited ${code}: ${stderr.slice(0, 500)}`));
      else resolve(stdout.trim());
    });

    proc.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(new Error(`Dispatch spawn failed: ${err.message}`));
    });
  });
}

// === DATABASE HELPERS ===

// Direct settings reader for orchestrator (can't import from Next.js app)
async function getSettingValueDirect(key: string): Promise<string | null> {
  const [row] = await sql`SELECT value, is_secret FROM settings WHERE key = ${key}`;
  if (!row) return null;
  if (!row.is_secret) return row.value;

  // Decrypt AES-256-GCM (format: iv_hex:tag_hex:encrypted_hex — must match src/lib/crypto.ts)
  const encKey = process.env.ENCRYPTION_KEY;
  if (!encKey) return null;
  try {
    const [ivHex, tagHex, encryptedHex] = row.value.split(":");
    if (!ivHex || !tagHex || !encryptedHex) return null;
    const iv = Buffer.from(ivHex, "hex");
    const tag = Buffer.from(tagHex, "hex");
    const decipher = createDecipheriv("aes-256-gcm", Buffer.from(encKey, "hex"), iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(encryptedHex, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
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

// === AGENT EXECUTION WITH RETRY + REFLECTION ===
async function executeAgent(opts: {
  agent: string;
  companyId: string;
  cycleId: string;
  prompt: string;
  context: string;
  cwd?: string;
}): Promise<{ success: boolean; output: string }> {
  let lastReflection = "";

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const fullPrompt = attempt === 1
        ? `${opts.context}\n\n${opts.prompt}`
        : `${opts.context}\n\nPREVIOUS ATTEMPT FAILED. Reflection: ${lastReflection}\n\nTry a different approach.\n\n${opts.prompt}`;

      const output = await dispatch({
        prompt: fullPrompt,
        cwd: opts.cwd,
        maxTurns: 10,
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
      // Reflection on attempts 1 and 2
      if (attempt <= REFLECTION_ATTEMPTS) {
        try {
          lastReflection = await dispatch({
            prompt: `The ${opts.agent} agent failed with error: ${error.message}\n\nReflect on why this failed and suggest a different approach. Be specific and actionable. Output plain text.`,
          });
        } catch {
          lastReflection = "Reflection failed. Will retry with original approach.";
        }

        await logAction({
          cycleId: opts.cycleId,
          companyId: opts.companyId,
          agent: opts.agent,
          actionType: "cycle_task",
          description: `Attempt ${attempt} failed`,
          status: "failed",
          error: error.message,
          reflection: lastReflection,
          retryCount: attempt,
        });
      }

      // Final attempt: escalate
      if (attempt === MAX_RETRIES) {
        await logAction({
          cycleId: opts.cycleId,
          companyId: opts.companyId,
          agent: opts.agent,
          actionType: "cycle_task",
          description: `All ${MAX_RETRIES} attempts failed — escalating`,
          status: "escalated",
          error: error.message,
          retryCount: attempt,
        });

        await createApproval({
          companyId: opts.companyId,
          gateType: "escalation",
          title: `${opts.agent} agent failed for ${opts.companyId}`,
          description: `Failed after ${MAX_RETRIES} attempts. Last error: ${error.message}`,
          context: { agent: opts.agent, lastReflection, error: error.message },
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

  // === IDEA SCOUT: Generate new business ideas ===
  // Runs weekly (Sunday) or when portfolio has fewer than MAX_ACTIVE_COMPANIES
  const MAX_ACTIVE_COMPANIES = 5;
  const isWeekly = new Date().getDay() === 0; // Sunday
  const allCompanies = await sql`SELECT id, slug, name, status, description FROM companies`;
  const activeCount = allCompanies.filter(c => ["mvp", "active", "provisioning", "approved"].includes(c.status)).length;
  const pendingIdeas = await sql`SELECT count(*) as cnt FROM approvals WHERE gate_type = 'new_company' AND status = 'pending'`;
  const hasPendingIdea = Number(pendingIdeas[0].cnt) > 0;

  const shouldScout = FORCE_SCOUT || SCOUT_ONLY || ((isWeekly || activeCount < MAX_ACTIVE_COMPANIES) && !hasPendingIdea && !SINGLE_COMPANY);

  if (shouldScout) {
    console.log("\n💡 Idea Scout — searching for opportunities");

    const playbook = await getPlaybook();
    const killedCompanies = allCompanies.filter(c => c.status === "killed");
    const liveCompanies = allCompanies.filter(c => ["mvp", "active"].includes(c.status));

    const ideaScoutOutput = await dispatch({
      prompt: `You are the Idea Scout agent for Hive, a venture orchestrator owned by Carlos Miranda.

YOUR JOB: Research the market using web search and propose ONE business idea that Carlos should build next.

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
- MANDATORY: At least 1 of the 3 niches MUST solve a challenge specific to the Portuguese market

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

### Phase 2: Competition analysis (2-3 searches per niche)
For each niche you identify, search for existing solutions:
- "[niche] software Portugal"
- "[niche] SaaS tool"
- Search competitor names you find, check their pricing, reviews, feature gaps
You want niches where competitors are: too expensive, too generic (not PT-localised), 
enterprise-only, or simply don't exist yet.

### Phase 3: Demand validation (1-2 searches per niche)
Search for evidence people actually want this:
- Search volume proxies: "how to [solve problem]" queries
- Forum complaints, Reddit threads, social media frustration
- Government data on market size (number of landlords, freelancers, SMEs, etc.)
- News articles about the problem growing

### Phase 4: Pick the winner and build the proposal
Score each niche on: demand strength, competition gap, timing (regulatory tailwind?), 
MVP feasibility (can AI agents ship it in 1-2 weeks?), Carlos's skill match.

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
  "proposal": {
    "name": "Product Name",
    "slug": "product-slug",
    "description": "One-line pitch",
    "target_audience": "Who this is for",
    "problem": "What pain point it solves",
    "solution": "How it solves it",
    "monetisation": "Pricing model and target",
    "mvp_scope": "What the first version includes (bullet points)",
    "competitive_advantage": "Why this wins against alternatives",
    "estimated_tam": "Total addressable market estimate with source",
    "confidence": 0.0-1.0
  }
}`,
      maxTurns: 25,
      timeoutMs: 15 * 60 * 1000, // 15 min — research agent does many web searches
    });

    // Parse the output and create the company + approval gate
    try {
      // Extract JSON from the output (Claude may wrap it in markdown)
      const jsonMatch = ideaScoutOutput.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const idea = JSON.parse(jsonMatch[0]);
        const proposal = idea.proposal;

        if (proposal?.name && proposal?.slug) {
          // Create the company in 'idea' status
          const [newCompany] = await sql`
            INSERT INTO companies (name, slug, description, status)
            VALUES (${proposal.name}, ${proposal.slug}, ${proposal.description}, 'idea')
            ON CONFLICT (slug) DO NOTHING
            RETURNING *
          `;

          if (newCompany) {
            // Build research summary for the approval gate
            const researchSummary = idea.research ? [
              idea.research.searches_performed?.length 
                ? `**Searches performed:** ${idea.research.searches_performed.length} web queries` : "",
              ...(idea.research.niches_considered || []).map((n: any) =>
                `- **${n.niche}** (${n.market || "unknown market"}): ${n.verdict}`
              ),
            ].filter(Boolean).join("\n") : "";

            // Create the approval gate with full context + research trail
            await sql`
              INSERT INTO approvals (company_id, gate_type, title, description, context)
              VALUES (
                ${newCompany.id},
                'new_company',
                ${"Launch " + proposal.name},
                ${`**${proposal.description}**\n\n` +
                  `**Problem:** ${proposal.problem}\n` +
                  `**Solution:** ${proposal.solution}\n` +
                  `**Target:** ${proposal.target_audience}\n` +
                  `**Monetisation:** ${proposal.monetisation}\n` +
                  `**MVP scope:** ${proposal.mvp_scope}\n` +
                  `**Competitive advantage:** ${proposal.competitive_advantage || "N/A"}\n` +
                  `**TAM:** ${proposal.estimated_tam}\n` +
                  `**Confidence:** ${Math.round((proposal.confidence || 0.5) * 100)}%\n\n` +
                  `---\n### Research trail\n${researchSummary}`},
                ${JSON.stringify(idea)}
              )
            `;

            console.log(`  ✓ Proposed: ${proposal.name} (${proposal.slug}) — awaiting approval`);
            if (idea.research?.searches_performed?.length) {
              console.log(`    Research: ${idea.research.searches_performed.length} web searches, ${(idea.research.niches_considered || []).length} niches evaluated`);
            }

            // Log the action with full research output
            await sql`
              INSERT INTO agent_actions (company_id, agent, action_type, description, status, output, started_at, finished_at)
              VALUES (${newCompany.id}, 'idea_scout', 'generate_idea', ${`Proposed: ${proposal.name} — ${proposal.description} (${(idea.research?.searches_performed || []).length} searches, confidence: ${proposal.confidence})`}, 'success', ${JSON.stringify(idea)}, now(), now())
            `;
          } else {
            console.log(`  ⓘ Slug "${proposal.slug}" already exists — skipping`);
          }
        }
      }
    } catch (e: any) {
      console.log(`  ⚠ Failed to parse Idea Scout output: ${e.message}`);
      // Still log the raw output so it's not lost
      await sql`
        INSERT INTO agent_actions (company_id, agent, action_type, description, status, error, output, started_at, finished_at)
        VALUES (${null}, 'idea_scout', 'generate_idea', 'Failed to parse idea proposal', 'failed', ${e.message}, ${JSON.stringify({ raw: ideaScoutOutput })}, now(), now())
      `;
    }
  } else if (!SINGLE_COMPANY) {
    const reason = hasPendingIdea ? "pending idea awaiting approval" : 
                   activeCount >= MAX_ACTIVE_COMPANIES ? `at capacity (${activeCount}/${MAX_ACTIVE_COMPANIES})` :
                   "not weekly scout day";
    console.log(`\n💡 Idea Scout — skipped (${reason})`);
  }

  // If scout-only mode, exit before company processing
  if (SCOUT_ONLY) {
    const totalDuration = Math.round((Date.now() - startTime) / 1000);
    console.log(`\n🐝 Scout-only run complete in ${totalDuration}s`);
    return;
  }

  const companies = await getActiveCompanies();
  console.log(`\n📋 ${companies.length} active companies to process\n`);

  const results: Array<{ company: string; status: string; duration: number }> = [];

  for (const company of companies) {
    const companyStart = Date.now();
    console.log(`\n▸ ${company.name} (${company.slug}) — ${company.status}`);

    try {
    const cycleNumber = await getLatestCycleNumber(company.id);
    const cycleId = await createCycle(company.id, cycleNumber);
    const metrics = await getMetrics(company.id);
    const playbook = await getPlaybook();
    const directives = await getDirectives(company.id);

    const context = `
COMPANY: ${company.name} (${company.slug})
STATUS: ${company.status}
URL: ${company.vercel_url || "not deployed"}
DESCRIPTION: ${company.description}

RECENT METRICS (last 7 days):
${JSON.stringify(metrics, null, 2)}

PLAYBOOK (top learnings):
${playbook.map(p => `- [${p.domain}] ${p.insight} (confidence: ${p.confidence})`).join("\n")}

${directives.length > 0 ? `DIRECTIVES FROM CARLOS (must address these):
${directives.map(d => `- [#${d.id.slice(0,8)}] ${d.text}${d.agent ? ` (for ${d.agent})` : ""}`).join("\n")}` : ""}
    `.trim();

    // Step 1: CEO plans (incorporating directives)
    console.log("  ├─ CEO planning...");
    const companyCtx = { name: company.name, slug: company.slug };
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
    await executeAgent({
      agent: "engineer",
      companyId: company.id,
      cycleId,
      prompt: engPrompt + `\n\nCEO PLAN: ${ceoPlan.output}\n\nExecute the engineering tasks.`,
      context,
      cwd: `/Users/carlos/code/${company.slug}`, // local repo path
    });

    // Step 3: Growth executes
    console.log("  ├─ Growth executing...");
    const growthPrompt = await getActivePrompt("growth", companyCtx);
    await executeAgent({
      agent: "growth",
      companyId: company.id,
      cycleId,
      prompt: growthPrompt + `\n\nCEO PLAN: ${ceoPlan.output}\n\nExecute the growth tasks.`,
      context,
    });

    // Step 4: Ops collects metrics
    console.log("  ├─ Ops collecting metrics...");
    const opsPrompt = await getActivePrompt("ops", companyCtx);
    await executeAgent({
      agent: "ops",
      companyId: company.id,
      cycleId,
      prompt: opsPrompt + "\n\nCollect today's metrics from Stripe, Vercel Analytics, and error logs.",
      context,
    });

    // Step 5: CEO reviews
    console.log("  └─ CEO reviewing cycle...");
    const ceoReview = await executeAgent({
      agent: "ceo",
      companyId: company.id,
      cycleId,
      prompt: ceoPrompt + "\n\nReview tonight's cycle results. Score the cycle 1-10. Write assessment. Include a playbook_entry if you learned something worth sharing across companies.",
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

      // Log failure to DB so it shows in the dashboard
      try {
        await sql`
          INSERT INTO agent_actions (company_id, agent, action_type, description, status, error, started_at, finished_at)
          VALUES (${company.id}, 'orchestrator', 'cycle_failed', ${`Company cycle failed: ${companyError.message}`}, 'failed', ${companyError.message}, now(), now())
        `;
      } catch { /* don't let logging failure cascade */ }
    }
  }

  // === PROVISION APPROVED COMPANIES ===
  const approvedCompanies = await sql`SELECT * FROM companies WHERE status = 'approved'`;
  if (approvedCompanies.length > 0) {
    console.log(`\n🔧 Provisioning ${approvedCompanies.length} approved companies`);
    for (const company of approvedCompanies) {
      console.log(`  ▸ Provisioning ${company.name}...`);
      await sql`UPDATE companies SET status = 'provisioning', updated_at = now() WHERE id = ${company.id}`;

      await dispatch({
        prompt: `You are the Provisioner agent. Set up infrastructure for a new Hive company.

Company: ${company.name} (${company.slug})
Description: ${company.description}

Execute these steps using the APIs available to you:
1. Create GitHub repo: carlos-miranda/${company.slug} (use GitHub API)
2. Push the boilerplate template from templates/boilerplate/ (replace {{SLUG}}, {{COMPANY_NAME}}, {{DESCRIPTION}} placeholders)
3. Generate a CLAUDE.md from templates/company-claude.md with the company details filled in
4. Create Neon project: hive-${company.slug} (use Neon API)
5. Create Vercel project linked to the GitHub repo (use Vercel API)
6. Set environment variables in Vercel: DATABASE_URL, STRIPE_SECRET_KEY, NEXT_PUBLIC_URL
7. Create a Stripe product + price tagged with hive_company: ${company.slug}
8. Record all resource IDs in the infra table via the Hive API
9. Update company status to 'mvp' and set vercel_url

Report what was created and any issues encountered.`,
        cwd: `/Users/carlos/code/hive`,
      });
    }
  }

  // === ONBOARD IMPORTED PROJECTS ===
  const pendingImports = await getPendingImports();
  if (pendingImports.length > 0) {
    console.log(`\n📥 Onboarding ${pendingImports.length} imported projects`);
    for (const imp of pendingImports) {
      console.log(`  ▸ Onboarding ${imp.name} from ${imp.source_url}...`);
      await sql`UPDATE imports SET onboard_status = 'in_progress' WHERE id = ${imp.id}`;

      const scanReport = imp.scan_report || {};

      await dispatch({
        prompt: `You are the Onboarding agent. An existing project is being imported into Hive.

Project: ${imp.name} (${imp.slug})
Source: ${imp.source_url}
Scan Report: ${JSON.stringify(scanReport, null, 2)}

This is an EXISTING project, not a new one. Do NOT re-create infrastructure.
Instead:
1. Clone the repo locally to /Users/carlos/code/${imp.slug}
2. If CLAUDE.md doesn't exist, generate one based on the scan report and actual code
3. If .env.example doesn't exist, create one by scanning the code for env var usage
4. Verify the project builds (npm install && npm run build)
5. Check if it's already on Vercel — if not, create a Vercel project linked to the existing repo
6. Record infrastructure details in the Hive infra table
7. Update the company record with vercel_url, github_repo, neon_project_id (if applicable)
8. If there's no Stripe integration and the project needs one, create a product + price

Key difference from new companies: RESPECT the existing codebase. Don't overwrite files.
Add Hive integration alongside what's already there.

IMPORTANT — Scheduling conflict detection:
9. Check for existing agent scheduling that would conflict with Hive's orchestrator:

   CLOUD-BASED (disable directly — you have the credentials):
   - GitHub Actions that run AI agents or Claude CLI on a schedule: disable these workflow files via GitHub API
   - Vercel cron entries that trigger agent/AI logic: remove those entries from vercel.json
   - Do NOT disable standard CI/CD (build, test, lint, deploy) — each company keeps its own deployment pipeline
   - Do NOT disable Vercel's auto-deploy-on-push — that's how company code gets deployed

   LOCAL (escalate — only Carlos can do this):
   - launchd plist files (*.plist): if found in the repo or referenced in docs, create an escalation
     approval via POST /api/approvals with:
     { gate_type: "escalation", company_id: "${imp.company_id || ""}", title: "Local launchd schedule detected in ${imp.name}", description: "Found plist files: [list files]. Carlos needs to manually unload: launchctl unload ~/Library/LaunchAgents/[filename]" }

   Log all findings (both resolved and escalated) in the action output.`,
        cwd: `/Users/carlos/code/${imp.slug}`,
      });

      // Phase 2: Pattern extraction — learn from the imported codebase
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

3. SEO: Does the project have good meta tags, sitemap, structured data, content strategy?
   Write playbook entries under domain "seo".

4. LANDING PAGE: What's the hero structure, CTA placement, social proof approach?
   Write playbook entries under domain "landing_page".

5. ARCHITECTURE: Are there deployment, auth, error handling, or testing patterns
   that are better than what's in Hive's current boilerplate template?
   If yes, write a directive suggesting the boilerplate be updated: "hive: update boilerplate template — [description of improvement]"

6. GROWTH: Any referral systems, onboarding flows, retention hooks?
   Write playbook entries under domain "growth".

For each finding, write to the Hive API:
POST /api/playbook with { source_company_id, domain, insight, evidence, confidence }

Only write genuinely useful patterns. Confidence should reflect how proven the pattern is:
- 0.9+ : measurably successful (has metrics, has users)
- 0.7-0.9 : well-implemented, likely effective
- 0.5-0.7 : reasonable pattern, untested at scale

If you find patterns that should update the Hive boilerplate, create a directive via:
POST /api/directives with { text: "hive: [suggestion]" }`,
        cwd: `/Users/carlos/code/${imp.slug}`,
      });

      await sql`UPDATE imports SET onboard_status = 'complete' WHERE id = ${imp.id}`;
      console.log(`  ✓ ${imp.name} onboarded with patterns extracted`);
    }
  }

  // === VENTURE BRAIN: Portfolio-level analysis ===
  console.log("\n🧠 Venture Brain — portfolio analysis");

  const allMetrics = await sql`
    SELECT c.name, c.slug, c.status, m.* 
    FROM metrics m 
    JOIN companies c ON c.id = m.company_id 
    WHERE m.date >= CURRENT_DATE - INTERVAL '7 days'
    ORDER BY c.slug, m.date DESC
  `;

  await dispatch({
    prompt: `You are the Venture Brain. Analyze the portfolio:

${JSON.stringify(allMetrics, null, 2)}

Tasks:
1. Compare companies: which is performing best, which is stalling?
2. Kill Switch check: any company that should be shut down? (criteria: no revenue after 60 days, CAC > 3x LTV for 30 days, no signups for 30 days)
3. Capital allocation: should we shift resources between companies?
4. If any company should be killed, write to the approvals table via the API.

Output a brief portfolio summary.`,
  });

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
          AND m.date >= CURRENT_DATE
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
      const emailRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "Hive <noreply@hive.local>",
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
  console.log(`\n🐝 Nightly cycle complete in ${totalDuration}s`);
  console.log(`${"─".repeat(50)}\n`);
}

// === RUN ===
runNightlyCycle().catch(err => {
  console.error("❌ Orchestrator crashed:", err);
  process.exit(1);
});
