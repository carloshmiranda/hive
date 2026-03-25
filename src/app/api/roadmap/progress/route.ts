import { getDb, json } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET /api/roadmap/progress
// Returns theme-based progress for the Hive roadmap.
// Each theme maps to a ROADMAP.md milestone. Progress = done / (done + active).

const THEME_PHASES: Record<string, { phase: number; label: string }> = {
  dispatch_chain: { phase: 1, label: "Reliable end-to-end work execution" },
  first_revenue: { phase: 1, label: "Any Hive company earns money" },
  zero_intervention: { phase: 2, label: "System runs without babysitting" },
  self_healing: { phase: 2, label: "Hive fixes its own bugs" },
  self_improving: { phase: 3, label: "Hive gets smarter over time" },
  code_quality: { phase: 3, label: "Companies ship reliable code" },
  portfolio_intelligence: { phase: 3, label: "Data-driven portfolio decisions" },
  full_autonomy: { phase: 4, label: "10+ companies, <15 min/day" },
};

export async function GET() {
  const sql = getDb();

  const rows = await sql`
    SELECT
      COALESCE(theme, 'uncategorized') as theme,
      count(*)::int as total,
      count(*) FILTER (WHERE status = 'done')::int as done,
      count(*) FILTER (WHERE status NOT IN ('done', 'rejected'))::int as active,
      count(*) FILTER (WHERE priority = 'P0' AND status NOT IN ('done', 'rejected'))::int as p0_active,
      count(*) FILTER (WHERE status = 'blocked')::int as blocked
    FROM hive_backlog
    GROUP BY theme
    ORDER BY total DESC
  `;

  const themes = rows.map((r) => {
    const meta = THEME_PHASES[r.theme] || { phase: 0, label: r.theme };
    const total = r.done + r.active;
    return {
      theme: r.theme,
      phase: meta.phase,
      label: meta.label,
      done: r.done,
      active: r.active,
      blocked: r.blocked,
      p0_active: r.p0_active,
      total,
      pct: total > 0 ? Math.round((r.done / total) * 100) : 0,
    };
  });

  // Compute phase-level progress
  const phases = [1, 2, 3, 4].map((p) => {
    const phaseThemes = themes.filter((t) => t.phase === p);
    const done = phaseThemes.reduce((s, t) => s + t.done, 0);
    const active = phaseThemes.reduce((s, t) => s + t.active, 0);
    const total = done + active;
    return {
      phase: p,
      done,
      active,
      total,
      pct: total > 0 ? Math.round((done / total) * 100) : 0,
      themes: phaseThemes.map((t) => t.theme),
    };
  });

  // Current phase = lowest phase with < 80% completion
  const currentPhase = phases.find((p) => p.total > 0 && p.pct < 80)?.phase || 4;

  return json({
    ok: true,
    current_phase: currentPhase,
    phases,
    themes: themes.sort((a, b) => a.phase - b.phase || b.active - a.active),
  });
}
