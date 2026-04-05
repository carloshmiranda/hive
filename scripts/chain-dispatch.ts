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
 * Extract the last valid JSON object from agent text output.
 * Handles: markdown code blocks (```json ... ```), bare JSON objects
 * at any nesting depth. Returns {} on failure — never throws.
 */
function extractJSONFromText(text: string): Record<string, unknown> {
  // 1. Try markdown code block: ```json\n...\n``` or ```\n...\n```
  const codeBlockMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1].trim());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through to next strategy
    }
  }

  // 2. Balanced-brace extraction — handles arbitrary nesting depth.
  // Scan for every '{', track depth with a proper parser that respects
  // string literals and escape sequences, collect all valid JSON objects,
  // then return the last one (most likely the CEO's final signal output).
  const candidates: Record<string, unknown>[] = [];
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

  return candidates[candidates.length - 1] ?? {};
}

// ─── Signal detection ────────────────────────────────────────────────────────

function checkSignal(
  result: string,
  signal: string,
  parsed?: Record<string, unknown>
): boolean {
  const obj = parsed ?? extractJSONFromText(result);
  return obj[signal] === true;
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
  fallbackAgent: string,
  company: string,
  githubRepo: string,
  traceId: string,
  ghToken: string,
  hiveUrl: string,
  cronSecret: string
): Promise<void> {
  if (githubRepo) {
    const inputs: Record<string, string> = {
      company_slug: company,
      trigger: "ceo_plan",
      task_summary: summary,
    };
    const { status } = await post(
      `https://api.github.com/repos/${githubRepo}/actions/workflows/${workflow}/dispatches`,
      {
        Authorization: `token ${ghToken}`,
        Accept: "application/vnd.github.v3+json",
      },
      { ref: "main", inputs }
    );
    console.log(`  Company ${workflow}: HTTP ${status}`);
    if (status >= 400 && fallbackAgent) {
      await dispatchWorker(
        fallbackAgent,
        company,
        traceId,
        hiveUrl,
        cronSecret
      );
    }
  } else if (fallbackAgent) {
    await dispatchWorker(fallbackAgent, company, traceId, hiveUrl, cronSecret);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const execFile =
    env("EXECUTION_FILE") ||
    "/home/runner/work/_temp/claude-execution-output.json";
  const ghToken = env("GH_TOKEN");
  const cronSecret = env("CRON_SECRET");
  const hiveUrl = env("HIVE_URL", "https://hive-phi.vercel.app");
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

    // Chain to Engineer → company repo hive-build.yml (fallback: Hive feature_request)
    await dispatchToCompanyRepo(
      "hive-build.yml",
      `Feature build for ${company}`,
      "",
      company,
      githubRepo,
      traceId,
      ghToken,
      hiveUrl,
      cronSecret
    );
    if (!githubRepo) {
      await dispatchGithub(repo, "feature_request", { source: "ceo", ...basePayload }, ghToken);
    }

    // Parallel worker dispatches (Growth + Outreach) — these use free models, fire concurrently
    await Promise.all([
      checkSignal(result, "dispatch_growth", parsed)
        ? dispatchToCompanyRepo(
            "hive-growth.yml",
            `Growth cycle for ${company}`,
            "growth",
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
