/**
 * CEO Chain Dispatch — TypeScript replacement for the bash chain dispatch block
 * in hive-ceo.yml.
 *
 * Usage: npx tsx scripts/chain-dispatch.ts
 *
 * Required env vars:
 *   EXECUTION_FILE    — path to claude-code-action execution JSON
 *   GH_TOKEN          — GitHub PAT for repository_dispatch calls
 *   CRON_SECRET       — Hive API auth token
 *   HIVE_URL          — Hive base URL (e.g. https://hive-phi.vercel.app)
 *   DATABASE_URL      — Neon connection string (for company repo lookup)
 *   TRIGGER           — CEO trigger string (from steps.context.outputs.trigger)
 *   DISPATCH_PAYLOAD  — raw JSON of github.event.client_payload
 *   GITHUB_REPOSITORY — e.g. carloshmiranda/hive
 *   GITHUB_RUN_ID     — current workflow run ID
 *   GITHUB_SERVER_URL — e.g. https://github.com
 */

import { readFileSync } from "fs";
import { neon } from "@neondatabase/serverless";

// ─── Helpers ────────────────────────────────────────────────────────────────

function env(key: string, fallback = ""): string {
  return process.env[key] ?? fallback;
}

async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown
): Promise<{ status: number; text: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text };
}

/**
 * Fetch a GitHub Actions OIDC token for direct use as a Bearer token
 * when calling Hive API endpoints. This eliminates the need for CRON_SECRET
 * in workflow-to-Hive communication — GitHub handles rotation automatically.
 */
async function getOidcToken(hiveUrl: string): Promise<string> {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) {
    console.warn("  [oidc] OIDC env vars not available — Hive API calls will be unauthenticated");
    return "";
  }
  try {
    const res = await fetch(`${requestUrl}&audience=${hiveUrl}`, {
      headers: { Authorization: `bearer ${requestToken}` },
    });
    const data = await res.json() as { value?: string };
    return data.value ?? "";
  } catch (e) {
    console.warn(`  [oidc] Failed to get OIDC token: ${e instanceof Error ? e.message : "unknown"}`);
    return "";
  }
}

// ─── Parse execution file ────────────────────────────────────────────────────

function parseLastAssistantText(execFile: string): string {
  try {
    const raw = readFileSync(execFile, "utf-8");
    const entries: unknown[] = JSON.parse(raw);
    // Find last assistant entry with text content
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i] as Record<string, unknown>;
      if (entry.type !== "assistant") continue;
      const msg = entry.message as Record<string, unknown> | undefined;
      if (!msg) continue;
      const content = msg.content as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(content)) continue;
      const texts = content
        .filter((c) => c.type === "text")
        .map((c) => c.text as string)
        .join("\n");
      if (texts) return texts;
    }
  } catch {
    // ignore parse errors
  }
  return "{}";
}

function parseExecutionMeta(execFile: string): { turns: number; cost: number } {
  try {
    const raw = readFileSync(execFile, "utf-8");
    const entries: unknown[] = JSON.parse(raw);
    const last = entries[entries.length - 1] as Record<string, unknown>;
    return {
      turns: Number(last?.num_turns ?? 0),
      cost: Number(last?.total_cost_usd ?? 0),
    };
  } catch {
    return { turns: 0, cost: 0 };
  }
}

// ─── Robust JSON extraction ──────────────────────────────────────────────────

/**
 * Extract ALL valid JSON objects from agent text output using balanced-brace
 * scanning. Respects string literals and escape sequences. Never throws.
 */
function extractAllCandidates(text: string): Record<string, unknown>[] {
  const candidates: Record<string, unknown>[] = [];

  // Try markdown code block first: ```json\n...\n``` or ```\n...\n```
  const codeBlockMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1].trim());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        candidates.push(parsed as Record<string, unknown>);
      }
    } catch {
      // fall through to balanced-brace scan
    }
  }

  // Balanced-brace extraction — handles arbitrary nesting depth.
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escape = false;
    let end = -1;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (escape) { escape = false; continue; }
      if (ch === "\\" && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}") { if (--depth === 0) { end = j; break; } }
    }
    if (end === -1) continue;
    try {
      const parsed = JSON.parse(text.slice(i, end + 1));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        candidates.push(parsed as Record<string, unknown>);
      }
    } catch {
      // not valid JSON — skip
    }
  }

  return candidates;
}

/**
 * Extract the last valid JSON object from agent text output.
 * Returns {} on failure — never throws.
 */
function extractJSONFromText(text: string): Record<string, unknown> {
  const candidates = extractAllCandidates(text);
  return candidates[candidates.length - 1] ?? {};
}

// ─── Signal detection ────────────────────────────────────────────────────────

/**
 * Check if a dispatch signal is true anywhere in the CEO's output.
 *
 * CEO outputs two JSON formats:
 *   (a) Simple summary (hive-ceo.yml prompt):
 *       { "company": "slug", "needs_feature": true, "needs_research": false, ... }
 *   (b) Full plan (ceo.md prompt):
 *       { "plan": { ..., "dispatch_signals": { "dispatch_growth": true, ... } } }
 *
 * `parsed` (the last JSON object) is usually format (a), which lacks dispatch_growth.
 * This function falls back to scanning all JSON objects for the signal at:
 *   - top level of any candidate
 *   - plan.dispatch_signals (ceo.md nested format)
 *   - dispatch_signals directly (if the sub-object is the last extracted)
 */
function checkSignal(
  result: string,
  signal: string,
  parsed?: Record<string, unknown>
): boolean {
  const obj = parsed ?? extractJSONFromText(result);
  // Fast path: signal at top level of last JSON object
  if (obj[signal] === true) return true;

  // Fallback: scan all JSON candidates for the signal
  for (const candidate of extractAllCandidates(result)) {
    // Top-level on any candidate
    if (candidate[signal] === true) return true;
    // Nested: plan.dispatch_signals (ceo.md format)
    const plan = candidate["plan"] as Record<string, unknown> | undefined;
    const ds = plan?.["dispatch_signals"] as Record<string, unknown> | undefined;
    if (ds?.[signal] === true) return true;
    // Nested: dispatch_signals directly (if the sub-object is the last candidate)
    const directDs = candidate["dispatch_signals"] as Record<string, unknown> | undefined;
    if (directDs?.[signal] === true) return true;
  }

  return false;
}

/**
 * Extract the first engineering task from CEO output JSON candidates.
 * Returns null if no engineering_tasks array is found.
 */
function extractFirstEngineeringTask(
  result: string
): Record<string, unknown> | null {
  for (const candidate of extractAllCandidates(result)) {
    // Direct: { engineering_tasks: [...] }
    const direct = candidate["engineering_tasks"] as unknown[] | undefined;
    if (Array.isArray(direct) && direct.length > 0) {
      return direct[0] as Record<string, unknown>;
    }
    // Nested: { plan: { engineering_tasks: [...] } }
    const plan = candidate["plan"] as Record<string, unknown> | undefined;
    const nested = plan?.["engineering_tasks"] as unknown[] | undefined;
    if (Array.isArray(nested) && nested.length > 0) {
      return nested[0] as Record<string, unknown>;
    }
  }
  return null;
}

// ─── Company extraction ──────────────────────────────────────────────────────

function extractCompany(
  result: string,
  payload: Record<string, unknown>
): { company: string; companyId: string; parsed: Record<string, unknown> } {
  const parsed = extractJSONFromText(result);

  const company = String(parsed["company"] ?? payload.company ?? "");
  const companyId = String(parsed["company_id"] ?? payload.company_id ?? "");

  return { company, companyId, parsed };
}

// ─── DB lookup for company repo ──────────────────────────────────────────────

async function getCompanyGithubRepo(
  company: string,
  dbUrl: string
): Promise<string> {
  if (!dbUrl || !company) return "";
  try {
    const sql = neon(dbUrl);
    const rows = await sql`SELECT github_repo FROM companies WHERE slug = ${company} LIMIT 1` as { github_repo: string }[];
    return rows[0]?.github_repo ?? "";
  } catch {
    return "";
  }
}

// ─── Dispatch functions ───────────────────────────────────────────────────────

async function dispatchGithub(
  repo: string,
  eventType: string,
  clientPayload: Record<string, unknown>,
  ghToken: string
): Promise<void> {
  const { status } = await post(
    `https://api.github.com/repos/${repo}/dispatches`,
    {
      Authorization: `token ${ghToken}`,
      Accept: "application/vnd.github.v3+json",
    },
    { event_type: eventType, client_payload: clientPayload }
  );
  console.log(`  Dispatched: ${eventType} (HTTP ${status})`);
}

async function dispatchWorker(
  agent: string,
  company: string,
  traceId: string,
  hiveUrl: string,
  cronSecret: string
): Promise<void> {
  const body: Record<string, string> = {
    company_slug: company,
    agent,
    trigger: "ceo_plan",
  };
  if (traceId) body.trace_id = traceId;
  const { status } = await post(
    `${hiveUrl}/api/agents/dispatch`,
    { Authorization: `Bearer ${cronSecret}` },
    body
  );
  console.log(`  Worker ${agent}: HTTP ${status}`);
}

async function dispatchToCompanyRepo(
  workflow: string,
  summary: string,
  company: string,
  githubRepo: string,
  traceId: string,
  ghToken: string,
  hiveUrl: string,
  cronSecret: string,
  taskPayload?: Record<string, unknown>
): Promise<void> {
  if (githubRepo) {
    const inputs: Record<string, string> = {
      company_slug: company,
      trigger: "ceo_plan",
      task_summary: summary,
    };
    if (taskPayload) {
      inputs.payload = JSON.stringify(taskPayload);
    }
    const { status } = await post(
      `https://api.github.com/repos/${githubRepo}/actions/workflows/${workflow}/dispatches`,
      {
        Authorization: `token ${ghToken}`,
        Accept: "application/vnd.github.v3+json",
      },
      { ref: "main", inputs }
    );
    console.log(`  Company ${workflow}: HTTP ${status}`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const execFile =
    env("EXECUTION_FILE") ||
    "/home/runner/work/_temp/claude-execution-output.json";
  const ghToken = env("GH_TOKEN");
  const hiveUrl = env("HIVE_URL", "https://hive-phi.vercel.app");

  // Use GitHub OIDC token for all Hive API calls — no stored secret needed.
  // Falls back to CRON_SECRET if OIDC env vars are unavailable (local dev / manual runs).
  const oidcToken = await getOidcToken(hiveUrl);
  const cronSecret = oidcToken || env("CRON_SECRET");
  const dbUrl = env("DATABASE_URL");
  const trigger = env("TRIGGER");
  const dispatchPayloadRaw = env("DISPATCH_PAYLOAD", "{}");
  const repo = env("GITHUB_REPOSITORY");
  const runId = env("GITHUB_RUN_ID");
  const serverUrl = env("GITHUB_SERVER_URL", "https://github.com");

  const dispatchPayload: Record<string, unknown> = (() => {
    try {
      return JSON.parse(dispatchPayloadRaw);
    } catch {
      return {};
    }
  })();

  const result = parseLastAssistantText(execFile);
  const traceId = String(dispatchPayload.trace_id ?? "");

  console.log(`Chain dispatch parsing last assistant output (${result.length} chars)`);
  console.log(`Trigger: ${trigger}`);
  console.log(`Trace ID: ${traceId}`);

  const { company, companyId, parsed } = extractCompany(result, dispatchPayload);
  console.log(`Company: ${company} | Company ID: ${companyId}`);

  if (!company) {
    console.log("WARNING: No company slug found in output or payload — skipping dispatches");
    console.log("Chain dispatch complete (no company)");
    return;
  }

  const basePayload: Record<string, string> = {
    company,
    ...(companyId ? { company_id: companyId } : {}),
    ...(traceId ? { trace_id: traceId } : {}),
  };

  const isCycleStart = trigger.includes("cycle_start");
  const isGateApproved = trigger.includes("gate_approved");
  const isCycleComplete = /cycle_complete|ceo_review/.test(trigger);

  if (isCycleStart) {
    // Provision new company if needed
    if (checkSignal(result, "needs_provisioning", parsed)) {
      await dispatchGithub(repo, "new_company", { source: "ceo", ...basePayload }, ghToken);
    }

    // Chain to Scout for research
    if (checkSignal(result, "needs_research", parsed)) {
      await dispatchGithub(repo, "research_request", { source: "ceo", ...basePayload }, ghToken);
    }

    // Look up company's GitHub repo (for free company-repo Actions)
    const githubRepo = await getCompanyGithubRepo(company, dbUrl);

    // Phase gate: skip engineer dispatch when CEO signals no feature work
    // Check 1: CEO output explicitly sets needs_feature=false
    let skipEngineer = false;
    if (parsed["needs_feature"] === false) {
      console.log(`[chain-dispatch] phase_gate_blocked: skipping engineer for ${company} — needs_feature=false`);
      skipEngineer = true;
    }

    // Check 2: DB fallback — latest cycle has engineering_tasks=[] (CEO freeze directive)
    // Essential for gate_approved trigger path where CEO may omit needs_feature
    if (!skipEngineer && companyId && dbUrl) {
      try {
        const sql = neon(dbUrl);
        const cycleRows = await sql`
          SELECT jsonb_array_length(ceo_plan->'engineering_tasks') AS et_count
          FROM cycles
          WHERE company_id = ${companyId}
          AND ceo_plan IS NOT NULL
          AND ceo_plan ? 'engineering_tasks'
          ORDER BY started_at DESC
          LIMIT 1
        ` as { et_count: number }[];
        const etCount = cycleRows[0]?.et_count;
        if (typeof etCount === "number" && etCount === 0) {
          console.log(`[chain-dispatch] phase_gate_blocked: skipping engineer for ${company} — engineering_tasks=[]`);
          skipEngineer = true;
        }
      } catch (e) {
        console.warn(`[chain-dispatch] engineering_tasks check failed: ${e instanceof Error ? e.message : e}`);
      }
    }

    // Chain to Engineer → company repo hive-build.yml (fallback: Hive feature_request)
    if (!skipEngineer) {
      // Extract first engineering task from CEO output to pass as binding context.
      // This prevents the engineer from browsing the backlog and implementing off-plan tasks.
      const task = extractFirstEngineeringTask(result);
      const taskPayload = task
        ? {
            task_id: task["id"],
            task: task["task"],
            description: task["task"],
            files_allowed: task["files_allowed"],
            files_forbidden: task["files_forbidden"],
            acceptance_criteria: task["acceptance_criteria"],
            complexity: task["complexity"],
          }
        : undefined;
      await dispatchToCompanyRepo(
        "hive-build.yml",
        task ? String(task["task"] ?? `Feature build for ${company}`) : `Feature build for ${company}`,
        company,
        githubRepo,
        traceId,
        ghToken,
        hiveUrl,
        cronSecret,
        taskPayload
      );
      if (!githubRepo) {
        await dispatchGithub(repo, "feature_request", { source: "ceo", ...basePayload }, ghToken);
      }
    }

    // Parallel worker dispatches (Growth + Outreach) — these use free models, fire concurrently
    await Promise.all([
      checkSignal(result, "dispatch_growth", parsed)
        ? dispatchToCompanyRepo(
            "hive-growth.yml",
            `Growth cycle for ${company}`,
            company,
            githubRepo,
            traceId,
            ghToken,
            hiveUrl,
            cronSecret
          )
        : Promise.resolve(),
      checkSignal(result, "dispatch_outreach", parsed)
        ? dispatchWorker("outreach", company, traceId, hiveUrl, cronSecret)
        : Promise.resolve(),
    ]);

  }

  if (isGateApproved) {
    if (checkSignal(result, "needs_provisioning", parsed)) {
      await dispatchGithub(repo, "new_company", { source: "ceo", ...basePayload }, ghToken);
    }
  }

  if (isCycleComplete) {
    console.log("Triggering post-cycle consolidation...");
    const consolidateRes = await post(
      `${hiveUrl}/api/agents/consolidate`,
      { Authorization: `Bearer ${cronSecret}` },
      { company_slug: company }
    );
    console.log(`  Consolidation: HTTP ${consolidateRes.status}`);

    console.log("Chaining to next company cycle...");
    const chainRes = await post(
      `${hiveUrl}/api/dispatch/cycle-complete`,
      { Authorization: `Bearer ${cronSecret}` },
      {
        agent: "ceo",
        company,
        status: "cycle_complete",
        action_type: "cycle_review",
      }
    );
    console.log(`  Chain result: ${chainRes.text}`);
  }

  // Notify via Telegram
  const { turns, cost } = parseExecutionMeta(execFile);
  const runUrl = `${serverUrl}/${repo}/actions/runs/${runId}`;
  await post(
    `${hiveUrl}/api/notify`,
    { Authorization: `Bearer ${cronSecret}` },
    {
      agent: "ceo",
      action: trigger,
      company,
      status: "success",
      summary: `Completed in ${turns} turns ($${cost})`,
      run_url: runUrl,
      duration_s: turns * 60,
    }
  ).catch(() => {}); // non-fatal

  console.log("Chain dispatch complete");
}

main().catch((err) => {
  console.error("Chain dispatch error:", err);
  process.exit(1);
});
