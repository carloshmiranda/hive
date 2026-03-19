import { getDb, json } from "@/lib/db";

// This endpoint is the "catch me up" URL for any Claude session.
// Paste it into a new Chat: "Read https://hive-phi.vercel.app/api/briefing and catch up"
// Claude Code can curl it at session start.
// Returns: current state, recent decisions, open questions, blockers, recent context log.

export async function GET() {
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

  return json(briefing);
}
