import { getDb, json, err } from "@/lib/db";
import { dispatchEvent } from "@/lib/dispatch";
import { invalidatePlaybook } from "@/lib/redis-cache";
import { setSentryTags, addDispatchBreadcrumb } from "@/lib/sentry-tags";

export const dynamic = "force-dynamic";

// POST /api/agents/consolidate
// Called after CEO review completes a cycle. Feeds outcomes back into the playbook.
// Three functions:
//   1. Extract playbook_entry from CEO review and write to playbook table
//   2. Boost confidence for playbook entries used in high-scoring cycles (8+)
//   3. Decay confidence for playbook entries used in low-scoring cycles (≤3)

export async function POST(req: Request) {
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    const { validateOIDC } = await import("@/lib/oidc");
    const result = await validateOIDC(req);
    if (result instanceof Response) return result;
  }

  const body = await req.json();
  const { company_slug, cycle_id } = body;

  if (!company_slug && !cycle_id) {
    return err("Missing company_slug or cycle_id", 400);
  }

  setSentryTags({ agent: "sentinel", action_type: "cycle_consolidation", route: "/api/agents/consolidate" });

  const sql = getDb();
  const results = {
    playbook_entries_created: 0,
    confidence_boosts: 0,
    confidence_decays: 0,
    cycle_score: null as number | null,
    error_patterns_learned: 0,
    healer_dispatched: false,
  };

  // Find the most recent completed cycle for this company
  let cycle;
  if (cycle_id) {
    [cycle] = await sql`
      SELECT cy.id, cy.company_id, cy.ceo_review, cy.cycle_number,
        c.slug, c.id as cid, c.content_language
      FROM cycles cy JOIN companies c ON c.id = cy.company_id
      WHERE cy.id = ${cycle_id} LIMIT 1
    `.catch(() => []);
  } else {
    const [company] = await sql`
      SELECT id FROM companies WHERE slug = ${company_slug} LIMIT 1
    `.catch(() => []);
    if (!company) return err("Company not found", 404);

    [cycle] = await sql`
      SELECT cy.id, cy.company_id, cy.ceo_review, cy.cycle_number,
        c.slug, c.id as cid, c.content_language
      FROM cycles cy JOIN companies c ON c.id = cy.company_id
      WHERE cy.company_id = ${company.id}
      ORDER BY cy.started_at DESC LIMIT 1
    `.catch(() => []);
  }

  if (!cycle || !cycle.ceo_review) {
    return json({ ok: true, ...results, note: "No completed cycle with review found" });
  }

  const review = typeof cycle.ceo_review === "string"
    ? JSON.parse(cycle.ceo_review)
    : cycle.ceo_review;

  // Could be nested under "review" key or flat
  const reviewData = review.review || review;
  const score = reviewData.score;
  results.cycle_score = score;

  addDispatchBreadcrumb({
    category: "dispatch",
    message: "Consolidating cycle",
    data: { company: cycle.slug, cycle_number: cycle.cycle_number, score },
  });

  // --- 1. Extract and write playbook entry from CEO review ---
  const entry = reviewData.playbook_entry;
  if (entry && entry.domain && entry.insight) {
    // Deduplicate: check if similar insight already exists
    const [existing] = await sql`
      SELECT id FROM playbook
      WHERE source_company_id = ${cycle.company_id}
        AND domain = ${entry.domain}
        AND insight = ${entry.insight}
      LIMIT 1
    `.catch(() => []);

    if (!existing) {
      await sql`
        INSERT INTO playbook (source_company_id, domain, insight, evidence, confidence, content_language)
        VALUES (
          ${cycle.company_id},
          ${entry.domain},
          ${entry.insight},
          ${JSON.stringify({
            cycle_number: cycle.cycle_number,
            cycle_score: score,
            source: "ceo_review_consolidation",
          })}::jsonb,
          ${Math.min(1, Math.max(0, entry.confidence || 0.6))},
          ${cycle.content_language || null}
        )
      `.catch(() => {});
      results.playbook_entries_created++;
    }
  }

  // Also extract insights from wins array if present
  const wins = reviewData.wins || reviewData.briefing?.wins || [];
  if (Array.isArray(wins) && wins.length > 0 && score >= 7) {
    for (const win of wins.slice(0, 2)) {
      const winText = typeof win === "string" ? win : win?.description || win?.text;
      if (!winText || winText.length < 10) continue;

      // Determine domain from context
      const domain = inferDomain(winText);

      const [existing] = await sql`
        SELECT id FROM playbook
        WHERE source_company_id = ${cycle.company_id}
          AND domain = ${domain}
          AND insight = ${winText}
        LIMIT 1
      `.catch(() => []);

      if (!existing) {
        await sql`
          INSERT INTO playbook (source_company_id, domain, insight, evidence, confidence, content_language)
          VALUES (
            ${cycle.company_id},
            ${domain},
            ${winText},
            ${JSON.stringify({
              cycle_number: cycle.cycle_number,
              cycle_score: score,
              source: "win_extraction",
            })}::jsonb,
            ${score >= 9 ? 0.8 : 0.6},
            ${cycle.content_language || null}
          )
        `.catch(() => {});
        results.playbook_entries_created++;
      }
    }
  }

  // Invalidate playbook cache after any new entries or confidence changes
  if (results.playbook_entries_created > 0) {
    await invalidatePlaybook();
    addDispatchBreadcrumb({
      category: "db",
      message: "Playbook entries written",
      data: { count: results.playbook_entries_created, company: cycle.slug },
    });
  }

  // --- 2 & 3. Confidence boost/decay based on cycle score ---
  // Find which playbook entries were available during this cycle's planning
  // (entries that existed before the cycle started and had confidence >= 0.6)
  if (score !== null && score !== undefined) {
    const cycleStart = await sql`
      SELECT started_at FROM cycles WHERE id = ${cycle.id}
    `.catch(() => []);

    if (cycleStart[0]?.started_at) {
      const referencedEntries = await sql`
        SELECT id, confidence FROM playbook
        WHERE created_at < ${cycleStart[0].started_at}
          AND confidence >= 0.5
          AND (source_company_id = ${cycle.company_id} OR source_company_id IS NULL)
        ORDER BY confidence DESC LIMIT 10
      `.catch(() => []);

      if (referencedEntries.length > 0) {
        if (score >= 8) {
          // High score: boost confidence of entries that were in context
          const boostAmount = score >= 9 ? 0.05 : 0.03;
          for (const entry of referencedEntries) {
            const newConfidence = Math.min(1, Number(entry.confidence) + boostAmount);
            await sql`
              UPDATE playbook
              SET confidence = ${newConfidence},
                  last_referenced_at = NOW(),
                  reference_count = COALESCE(reference_count, 0) + 1
              WHERE id = ${entry.id}
            `.catch(() => {});
            results.confidence_boosts++;
          }
        } else if (score <= 3) {
          // Low score: decay confidence of entries that were in context
          const decayAmount = score <= 2 ? 0.08 : 0.05;
          for (const entry of referencedEntries) {
            const newConfidence = Math.max(0, Number(entry.confidence) - decayAmount);
            await sql`
              UPDATE playbook
              SET confidence = ${newConfidence},
                  last_referenced_at = NOW(),
                  reference_count = COALESCE(reference_count, 0) + 1
              WHERE id = ${entry.id}
            `.catch(() => {});
            results.confidence_decays++;
          }
        }
        // Scores 4-7: neutral, no confidence change
      }
    }
  }

  // Invalidate playbook cache after confidence changes
  if (results.confidence_boosts > 0 || results.confidence_decays > 0) {
    await invalidatePlaybook();
  }

  // --- 4. Extract and learn error patterns from CEO review ---
  const errorPatterns = reviewData.error_patterns || [];
  if (Array.isArray(errorPatterns) && errorPatterns.length > 0) {
    let criticalHighCount = 0;
    const baseUrl = process.env.NEXT_PUBLIC_URL || "https://hive-phi.vercel.app";

    for (const pattern of errorPatterns.slice(0, 5)) {
      if (!pattern.error_text || !pattern.agent || !pattern.fix_summary) continue;
      try {
        const epRes = await fetch(`${baseUrl}/api/agents/error-patterns`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${process.env.CRON_SECRET}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            action: "learn",
            error_text: pattern.error_text,
            agent: pattern.agent,
            fix_summary: pattern.fix_summary,
            fix_detail: pattern.fix_detail || null,
            auto_fixable: pattern.auto_fixable ?? false,
          }),
          signal: AbortSignal.timeout(5000),
        });
        if (epRes.ok) results.error_patterns_learned++;
      } catch (e) {
        console.warn(`[consolidate] Error pattern learn failed: ${e instanceof Error ? e.message : "unknown"}`);
      }

      if (pattern.severity === "critical" || pattern.severity === "high") {
        criticalHighCount++;
      }
    }

    // Dispatch healer if 2+ critical/high patterns diagnosed
    if (criticalHighCount >= 2) {
      try {
        const autoFixablePatterns = errorPatterns
          .filter((p: { auto_fixable?: boolean; severity?: string }) =>
            p.auto_fixable && (p.severity === "critical" || p.severity === "high")
          )
          .map((p: { error_text: string; agent: string; fix_summary: string }) => ({
            error_text: p.error_text,
            agent: p.agent,
            fix_summary: p.fix_summary,
          }));

        await dispatchEvent("healer_trigger", {
          reason: `CEO diagnosed ${criticalHighCount} critical/high error patterns in cycle ${cycle.cycle_number}`,
          company_slug: cycle.slug,
          company_id: cycle.company_id,
          patterns: autoFixablePatterns,
        });
        results.healer_dispatched = true;
        addDispatchBreadcrumb({
          category: "dispatch",
          message: "Healer dispatched from consolidation",
          data: { critical_patterns: criticalHighCount, company: cycle.slug },
        });
      } catch (e) {
        console.warn(`[consolidate] Healer dispatch failed: ${e instanceof Error ? e.message : "unknown"}`);
      }
    }
  }

  // --- 5. Compute roadmap theme progress ---
  let themeProgress: Record<string, number> = {};
  try {
    const themeRows = await sql`
      SELECT COALESCE(theme, 'uncategorized') as theme,
        count(*)::int as total,
        count(*) FILTER (WHERE status = 'done')::int as done,
        count(*) FILTER (WHERE status NOT IN ('done', 'rejected'))::int as active
      FROM hive_backlog
      WHERE theme IS NOT NULL AND theme != 'uncategorized'
      GROUP BY theme
    `;
    for (const r of themeRows) {
      const total = r.done + r.active;
      themeProgress[r.theme] = total > 0 ? Math.round((r.done / total) * 100) : 0;
    }
  } catch { /* non-critical */ }

  // Log the consolidation
  await sql`
    INSERT INTO agent_actions (company_id, agent, action_type, description, status, output, started_at, finished_at)
    VALUES (
      ${cycle.company_id}, 'sentinel', 'cycle_consolidation',
      ${`Cycle ${cycle.cycle_number} (score: ${score}): ${results.playbook_entries_created} entries written, ${results.confidence_boosts} boosts, ${results.confidence_decays} decays`},
      'success',
      ${JSON.stringify({ ...results, theme_progress: themeProgress })}::jsonb,
      NOW(), NOW()
    )
  `.catch(() => {});

  return json({ ok: true, ...results, theme_progress: themeProgress });
}

function inferDomain(text: string): string {
  const lower = text.toLowerCase();
  if (lower.match(/seo|content|blog|article|keyword|traffic|page view/)) return "growth";
  if (lower.match(/landing|waitlist|signup|conversion|cta/)) return "growth";
  if (lower.match(/revenue|payment|stripe|pricing|mrr|customer/)) return "strategy";
  if (lower.match(/deploy|build|error|fix|bug|api|database/)) return "engineering";
  if (lower.match(/email|outreach|lead|prospect/)) return "outreach";
  return "strategy";
}
