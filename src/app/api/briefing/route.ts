import { getDb, json } from "@/lib/db";
import { NextRequest } from "next/server";

// This endpoint is the "catch me up" URL for any Claude session.
// JSON: curl https://hive-phi.vercel.app/api/briefing
// HTML: https://hive-phi.vercel.app/api/briefing?format=html (for Claude Chat web_fetch)
// Returns: current state, recent decisions, open questions, blockers, recent context log.

export async function GET(req: NextRequest) {
  const sql = getDb();

  // Portfolio state
  const companies = await sql`
    SELECT name, slug, status, description, created_at, killed_at, kill_reason
    FROM companies ORDER BY created_at DESC
  `;

  // Pending approvals
  const approvals = await sql`
    SELECT a.gate_type, a.title, a.status, c.slug as company_slug, a.created_at
    FROM approvals a
    LEFT JOIN companies c ON c.id = a.company_id
    WHERE a.status = 'pending'
    ORDER BY a.created_at DESC LIMIT 10
  `;

  // Recent context log (last 20 entries from all sources)
  let contextLog: any[] = [];
  try {
    contextLog = await sql`
      SELECT source, category, summary, detail, related_adr, tags, created_at
      FROM context_log ORDER BY created_at DESC LIMIT 20
    `;
  } catch {
    // Table might not exist yet
  }

  // Recent errors (last 48h)
  const recentErrors = await sql`
    SELECT aa.agent, aa.error, aa.description,
           c.slug as company_slug, aa.finished_at
    FROM agent_actions aa
    LEFT JOIN companies c ON c.id = aa.company_id
    WHERE aa.status IN ('failed', 'escalated')
      AND aa.started_at > now() - interval '48 hours'
    ORDER BY aa.finished_at DESC LIMIT 10
  `;

  // Latest cycle scores (cycles table has no score column — extract from ceo_review JSON)
  const cycleScores = await sql`
    SELECT c.slug, cy.cycle_number, cy.ceo_review, cy.started_at
    FROM cycles cy
    JOIN companies c ON c.id = cy.company_id
    WHERE cy.started_at > now() - interval '7 days' AND cy.status = 'completed'
    ORDER BY cy.started_at DESC LIMIT 20
  `;

  // Playbook highlights (top confidence)
  const playbook = await sql`
    SELECT p.domain, p.insight, c.slug as source_company, p.confidence
    FROM playbook p
    LEFT JOIN companies c ON c.id = p.source_company_id
    WHERE p.superseded_by IS NULL AND p.confidence >= 0.7
    ORDER BY p.confidence DESC LIMIT 10
  `;

  // Settings status (which keys are configured, not the values)
  const settings = await sql`SELECT key FROM settings`;
  const configuredKeys = settings.map((s: any) => s.key);

  const active = companies.filter((c: any) => ["mvp", "active"].includes(c.status));
  const pipeline = companies.filter((c: any) => ["idea", "approved", "provisioning", "mvp", "active"].includes(c.status));

  const briefing = {
    _readme: "This is the Hive context endpoint. Read this to understand the current state of the platform. For full architecture, read CLAUDE.md in the repo.",
    _updated: new Date().toISOString(),

    current_state: {
      phase: active.length === 0 ? "Pre-launch — no companies running yet" : `${active.length} active companies`,
      production_url: "https://hive-phi.vercel.app",
      active_companies: active.map((c: any) => ({ name: c.name, slug: c.slug, status: c.status })),
      pipeline_companies: pipeline.map((c: any) => ({ name: c.name, slug: c.slug, status: c.status })),
      pending_approvals: approvals.map((a: any) => ({ type: a.gate_type, title: a.title, company: a.company_slug })),
      configured_settings: configuredKeys,
      missing_settings: ["gemini_api_key", "groq_api_key", "resend_api_key", "digest_email", "sending_domain"]
        .filter(k => !configuredKeys.includes(k)),
    },

    recent_context: contextLog.map((c: any) => ({
      source: c.source,
      category: c.category,
      summary: c.summary,
      date: c.created_at,
    })),

    health: {
      recent_errors: recentErrors.length,
      errors: recentErrors.map((e: any) => ({
        agent: e.agent,
        company: e.company_slug,
        error: (e.error || e.description || "").slice(0, 150),
      })),
    },

    performance: {
      cycle_scores: cycleScores.map((s: any) => {
        let score = null;
        try {
          const review = typeof s.ceo_review === "string" ? JSON.parse(s.ceo_review) : s.ceo_review;
          score = review?.review?.score || review?.score || null;
        } catch {}
        return { company: s.slug, cycle: s.cycle_number, score };
      }),
    },

    knowledge: {
      playbook_entries: playbook.length,
      top_learnings: playbook.map((p: any) => ({
        domain: p.domain,
        insight: p.insight,
        from: p.source_company,
        confidence: p.confidence,
      })),
    },

    key_files: {
      briefing: "BRIEFING.md — read me first, current state + recent decisions",
      roadmap: "ROADMAP.md — strategic phases and milestones",
      architecture: "CLAUDE.md — full architecture, rules, flows",
      state: "MEMORY.md — deployment details, gotchas",
      learnings: "MISTAKES.md — production learnings (read before making changes)",
      backlog: "BACKLOG.md — task-level improvements",
      decisions: "DECISIONS.md — architectural decision records (ADR-001 through ADR-010)",
    },

    how_to_update_context: {
      from_chat: "POST to /api/context with {source:'chat', category:'decision|learning|brainstorm', summary:'...', detail:'...'}",
      from_code: "Edit BRIEFING.md + commit. Or POST to /api/context with source:'code'",
      from_manual: "POST to /api/context with source:'carlos'. Or edit BRIEFING.md directly.",
    },
  };

  // HTML mode for Claude Chat (web_fetch works better with HTML than raw JSON)
  const wantsHtml = req.nextUrl.searchParams.get("format") === "html"
    || req.headers.get("accept")?.includes("text/html");

  if (wantsHtml) {
    const state = briefing.current_state;
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Hive Briefing</title></head><body>
<h1>Hive Briefing</h1>
<p><em>Updated: ${briefing._updated}</em></p>
<p>${briefing._readme}</p>

<h2>Current State</h2>
<p><strong>Phase:</strong> ${state.phase}</p>
<p><strong>URL:</strong> ${state.production_url}</p>

<h3>Active Companies</h3>
<ul>${state.active_companies.map((c: any) => `<li><strong>${c.name}</strong> (${c.slug}) — ${c.status}</li>`).join("") || "<li>None</li>"}</ul>

<h3>Pipeline</h3>
<ul>${state.pipeline_companies.map((c: any) => `<li>${c.name} (${c.slug}) — ${c.status}</li>`).join("") || "<li>Empty</li>"}</ul>

<h3>Pending Approvals</h3>
<ul>${state.pending_approvals.map((a: any) => `<li>[${a.type}] ${a.title}${a.company ? ` (${a.company})` : ""}</li>`).join("") || "<li>None</li>"}</ul>

<h3>Settings</h3>
<p><strong>Configured (${state.configured_settings.length}):</strong> ${state.configured_settings.join(", ")}</p>
<p><strong>Missing:</strong> ${state.missing_settings.join(", ") || "None"}</p>

<h2>Health</h2>
<p><strong>Recent errors:</strong> ${briefing.health.recent_errors}</p>
${briefing.health.errors.length > 0 ? `<ul>${briefing.health.errors.map((e: any) => `<li>[${e.agent}] ${e.company || "hive"}: ${e.error}</li>`).join("")}</ul>` : ""}

<h2>Recent Context</h2>
${briefing.recent_context.length > 0 ? `<ul>${briefing.recent_context.map((c: any) => `<li>[${c.source}/${c.category}] ${c.summary} <em>(${c.date})</em></li>`).join("")}</ul>` : "<p>No context entries yet.</p>"}

<h2>Performance</h2>
${briefing.performance.cycle_scores.length > 0 ? `<ul>${briefing.performance.cycle_scores.map((s: any) => `<li>${s.company} cycle ${s.cycle}: score ${s.score ?? "N/A"}/10</li>`).join("")}</ul>` : "<p>No scored cycles yet.</p>"}

<h2>Knowledge (${briefing.knowledge.playbook_entries} entries)</h2>
<ul>${briefing.knowledge.top_learnings.map((p: any) => `<li><strong>[${p.domain}]</strong> ${p.insight} <em>(from ${p.from || "unknown"}, confidence: ${p.confidence})</em></li>`).join("") || "<li>No playbook entries yet</li>"}</ul>

<h2>Key Files</h2>
<ul>${Object.entries(briefing.key_files).map(([k, v]) => `<li><strong>${k}:</strong> ${v}</li>`).join("")}</ul>

<h2>How to Update Context</h2>
<ul>${Object.entries(briefing.how_to_update_context).map(([k, v]) => `<li><strong>${k}:</strong> ${v}</li>`).join("")}</ul>
</body></html>`;

    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  return json(briefing);
}
