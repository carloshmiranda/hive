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

import { execSync } from "child_process";
import { neon } from "@neondatabase/serverless";

// === CONFIG ===
const HIVE_API = process.env.HIVE_API_URL || "http://localhost:3000/api";
const DATABASE_URL = process.env.DATABASE_URL!;
const MAX_RETRIES = 3;
const REFLECTION_ATTEMPTS = 2;
const MESSAGES_PER_COMPANY = 40; // budget from Max 5x window
const DRY_RUN = process.argv.includes("--dry-run");
const SINGLE_COMPANY = process.argv.find((_, i, a) => a[i - 1] === "--company");

const sql = neon(DATABASE_URL);

// === DISPATCH: The abstraction layer for cloud migration ===
interface DispatchOptions {
  prompt: string;
  cwd?: string;
  allowedTools?: string[];
  maxTurns?: number;
}

async function dispatch(opts: DispatchOptions): Promise<string> {
  // TODAY: Claude Code CLI with subscription auth
  // TOMORROW: Claude Agent SDK with API key (one function swap)
  const args = [
    "claude", "-p", `"${opts.prompt.replace(/"/g, '\\"')}"`,
    "--output-format", "text",
  ];
  if (opts.cwd) args.push("--cwd", opts.cwd);
  if (opts.allowedTools?.length) {
    args.push("--allowedTools", opts.allowedTools.join(","));
  }
  if (opts.maxTurns) args.push("--max-turns", opts.maxTurns.toString());

  if (DRY_RUN) {
    console.log(`[DRY RUN] Would dispatch: ${opts.prompt.slice(0, 100)}...`);
    return "[DRY RUN] No output";
  }

  try {
    const result = execSync(args.join(" "), {
      encoding: "utf-8",
      timeout: 5 * 60 * 1000, // 5 min per dispatch
      env: { ...process.env }, // inherits Claude auth
    });
    return result.trim();
  } catch (error: any) {
    throw new Error(`Dispatch failed: ${error.message}`);
  }
}

// === DATABASE HELPERS ===
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

async function getActivePrompt(agent: string) {
  const [row] = await sql`
    SELECT prompt_text FROM agent_prompts 
    WHERE agent = ${agent} AND is_active = true 
    LIMIT 1
  `;
  return row?.prompt_text || getDefaultPrompt(agent);
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

// === DEFAULT PROMPTS (used before Prompt Evolver creates versions) ===
function getDefaultPrompt(agent: string): string {
  const prompts: Record<string, string> = {
    ceo: `You are the CEO agent for this company. Your job is to evaluate the current state, 
decide priorities for tonight's cycle, and review results at the end. 
Read the metrics, check what's working, and write a clear plan with 2-3 priorities.
Output JSON: { plan: { priorities: string[], reasoning: string }, review?: { assessment: string, score: number } }`,
    
    engineer: `You are the Engineer agent. Execute the coding tasks from the CEO's plan.
Write clean TypeScript, push to GitHub, and deploy via Vercel.
Use the project's CLAUDE.md for context and coding standards.
Output JSON: { tasks_completed: string[], commits: string[], tests_passed: boolean, errors?: string[] }`,
    
    growth: `You are the Growth agent. Execute marketing tasks from the CEO's plan.
Check the playbook for proven strategies before trying new ones.
Generate content, schedule social posts, send emails.
Output JSON: { content_created: string[], emails_sent: number, posts_scheduled: number, learnings?: string }`,
    
    ops: `You are the Ops agent. Ensure infrastructure health and fill metric gaps.
Stripe metrics (revenue, MRR, customers) are already collected by webhooks in real-time.
Vercel Analytics (page views) is collected by a twice-daily cron.
Your job: check for gaps in today's metrics, pull anything missing, monitor error logs,
verify deploys are healthy, and flag any infrastructure issues.
Output JSON: { metrics_filled: string[], issues?: string[], deploys_healthy: boolean }`,
  };
  return prompts[agent] || "Execute the assigned task and return results as JSON.";
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

  const companies = await getActiveCompanies();
  console.log(`📋 ${companies.length} active companies to process\n`);

  const results: Array<{ company: string; status: string; duration: number }> = [];

  for (const company of companies) {
    const companyStart = Date.now();
    console.log(`\n▸ ${company.name} (${company.slug}) — ${company.status}`);

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
    const ceoPrompt = await getActivePrompt("ceo");
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
    const engPrompt = await getActivePrompt("engineer");
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
    const growthPrompt = await getActivePrompt("growth");
    await executeAgent({
      agent: "growth",
      companyId: company.id,
      cycleId,
      prompt: growthPrompt + `\n\nCEO PLAN: ${ceoPlan.output}\n\nExecute the growth tasks.`,
      context,
    });

    // Step 4: Ops collects metrics
    console.log("  ├─ Ops collecting metrics...");
    const opsPrompt = await getActivePrompt("ops");
    await executeAgent({
      agent: "ops",
      companyId: company.id,
      cycleId,
      prompt: opsPrompt + "\n\nCollect today's metrics from Stripe, Vercel Analytics, and error logs.",
      context,
    });

    // Step 5: CEO reviews
    console.log("  └─ CEO reviewing cycle...");
    await executeAgent({
      agent: "ceo",
      companyId: company.id,
      cycleId,
      prompt: ceoPrompt + "\n\nReview tonight's cycle results. Score each agent 0-1. Write assessment.",
      context,
    });

    await updateCycle(cycleId, { status: "completed", ceo_plan: ceoPlan.output });

    const duration = Math.round((Date.now() - companyStart) / 1000);
    console.log(`  ✓ Cycle ${cycleNumber} complete (${duration}s)`);
    results.push({ company: company.slug, status: "complete", duration });
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
Add Hive integration alongside what's already there.`,
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

  await dispatch({
    prompt: `Send a daily digest email via the Resend API.

Results from tonight:
${results.map(r => `- ${r.company}: ${r.status} (${r.duration}s)`).join("\n")}

Pending approvals: ${pendingApprovals.length}
${pendingApprovals.map(a => `- [${a.gate_type}] ${a.title}`).join("\n")}

Use the Resend SDK to send to carlos@hive.dev with subject "🐝 Hive Digest — ${new Date().toLocaleDateString()}".
Keep it scannable: company results, pending approvals, key metrics.`,
  });

  const totalDuration = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n🐝 Nightly cycle complete in ${totalDuration}s`);
  console.log(`${"─".repeat(50)}\n`);
}

// === RUN ===
runNightlyCycle().catch(err => {
  console.error("❌ Orchestrator crashed:", err);
  process.exit(1);
});
