/**
 * Scout Chain Dispatch — TypeScript replacement for the bash chain dispatch block
 * in hive-scout.yml.
 *
 * Usage: npx tsx scripts/scout-chain-dispatch.ts
 *
 * Required env vars:
 *   EXECUTION_FILE    — path to claude-code-action execution JSON
 *   GH_TOKEN          — GitHub PAT for repository_dispatch calls
 *   CRON_SECRET       — Hive API auth token
 *   HIVE_URL          — Hive base URL (e.g. https://hive-phi.vercel.app)
 *   TRIGGER           — Scout trigger string (from steps.context.outputs.trigger)
 *   DISPATCH_PAYLOAD  — raw JSON of github.event.client_payload
 *   GITHUB_REPOSITORY — e.g. carloshmiranda/hive
 */

import { readFileSync } from "fs";

// ─── Helpers (shared pattern with chain-dispatch.ts) ─────────────────────────

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

function parseLastAssistantText(execFile: string): string {
  try {
    const raw = readFileSync(execFile, "utf-8");
    const entries: unknown[] = JSON.parse(raw);
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

/**
 * Extract the last valid JSON object from agent text output.
 * Handles: markdown code blocks, bare JSON at any nesting depth.
 */
function extractJSONFromText(text: string): Record<string, unknown> {
  const codeBlockMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1].trim());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through
    }
  }

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
      // not valid JSON
    }
  }

  return candidates[candidates.length - 1] ?? {};
}

function checkSignal(
  result: string,
  signal: string,
  parsed?: Record<string, unknown>
): boolean {
  const obj = parsed ?? extractJSONFromText(result);
  return obj[signal] === true;
}

function extractCompany(
  result: string,
  payload: Record<string, unknown>
): { company: string; companyId: string; parsed: Record<string, unknown> } {
  const parsed = extractJSONFromText(result);
  const company = String(parsed["company"] ?? payload.company ?? "");
  const companyId = String(parsed["company_id"] ?? payload.company_id ?? "");
  return { company, companyId, parsed };
}

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
    trigger: "scout_research",
  };
  if (traceId) body.trace_id = traceId;
  const { status } = await post(
    `${hiveUrl}/api/agents/dispatch`,
    { Authorization: `Bearer ${cronSecret}` },
    body
  );
  console.log(`  Worker ${agent}: HTTP ${status}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const execFile =
    env("EXECUTION_FILE") ||
    "/home/runner/work/_temp/claude-execution-output.json";
  const ghToken = env("GH_TOKEN");
  const cronSecret = env("CRON_SECRET");
  const hiveUrl = env("HIVE_URL", "https://hive-phi.vercel.app");
  const trigger = env("TRIGGER");
  const dispatchPayloadRaw = env("DISPATCH_PAYLOAD", "{}");
  const repo = env("GITHUB_REPOSITORY");

  const dispatchPayload: Record<string, unknown> = (() => {
    try {
      return JSON.parse(dispatchPayloadRaw);
    } catch {
      return {};
    }
  })();

  const result = parseLastAssistantText(execFile);
  const traceId = String(dispatchPayload.trace_id ?? "");

  console.log(`Scout chain dispatch parsing last assistant output (${result.length} chars)`);
  console.log(`Trigger: ${trigger}`);
  console.log(`Trace ID: ${traceId}`);

  const { company, companyId, parsed } = extractCompany(result, dispatchPayload);
  console.log(`Company: ${company} | Company ID: ${companyId}`);

  if (!company) {
    console.log("WARNING: No company slug found in output or payload — skipping dispatches");
    console.log("Scout chain dispatch complete (no company)");
    return;
  }

  const basePayload: Record<string, string> = {
    company,
    ...(companyId ? { company_id: companyId } : {}),
    ...(traceId ? { trace_id: traceId } : {}),
  };

  // research_delivered: check JSON signal OR trigger-based fallback
  // (if trigger was research_request and agent succeeded, research was delivered)
  const researchDelivered =
    checkSignal(result, "research_delivered", parsed) ||
    trigger === "research_request";

  console.log(`Research delivered: ${researchDelivered}`);

  if (researchDelivered) {
    // Chain to CEO for cycle planning + Growth worker in parallel
    await Promise.all([
      dispatchGithub(repo, "cycle_start", { source: "scout_research", ...basePayload }, ghToken),
      dispatchWorker("growth", company, traceId, hiveUrl, cronSecret),
    ]);
  }

  // Chain to Outreach if leads found
  if (checkSignal(result, "leads_found", parsed)) {
    await dispatchWorker("outreach", company, traceId, hiveUrl, cronSecret);
  }

  console.log("Scout chain dispatch complete");
}

main().catch((err) => {
  console.error("Scout chain dispatch error:", err);
  process.exit(1);
});
