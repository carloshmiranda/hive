import { getDb, json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { dispatchEvent } from "@/lib/dispatch";
import { getGitHubToken } from "@/lib/github-app";
import { setSentryApiTags, extractRoutePath } from "@/lib/sentry-tags";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const { id } = await params;

  // Set Sentry tags for error context and triage
  setSentryApiTags({
    route: extractRoutePath(req),
    action_type: "approval_decide",
  });

  const body = await req.json();
  const { decision, note } = body;

  if (!decision || !["approved", "rejected"].includes(decision)) {
    return err("decision must be 'approved' or 'rejected'");
  }

  const sql = getDb();

  // Verify it's still pending
  const [existing] = await sql`SELECT * FROM approvals WHERE id = ${id}`;
  if (!existing) return err("Approval not found", 404);
  if (existing.status !== "pending") return err(`Already ${existing.status}`);

  // Update the approval
  const [approval] = await sql`
    UPDATE approvals SET
      status = ${decision},
      decided_at = now(),
      decision_note = ${note || null}
    WHERE id = ${id}
    RETURNING *
  `;

  // Side effects based on gate type + decision
  if (decision === "approved") {
    switch (approval.gate_type) {
      case "new_company":
        // Move company from 'idea' to 'approved' — but don't downgrade imports already at 'mvp'
        if (approval.company_id) {
          await sql`UPDATE companies SET status = 'approved', updated_at = now() WHERE id = ${approval.company_id} AND status = 'idea'`;
        }
        // Dispatch directly to Engineer for provisioning (skip CEO middleman)
        const [newComp] = await sql`SELECT slug FROM companies WHERE id = ${approval.company_id}`;
        await dispatchEvent("new_company", { source: "approval", company_id: approval.company_id, company: newComp?.slug });
        break;

      case "kill_company":
        // Mark company as killed and dispatch teardown + notification
        if (approval.company_id) {
          const [killedComp] = await sql`
            UPDATE companies SET
              status = 'killed',
              killed_at = now(),
              kill_reason = ${note || "Approved by Kill Switch"},
              updated_at = now()
            WHERE id = ${approval.company_id}
            RETURNING slug
          `;
          // Notify Scout (to avoid similar ideas) and Engineer (to teardown infra)
          await dispatchEvent("company_killed", { company: killedComp?.slug, company_id: approval.company_id });
          await dispatchEvent("ops_escalation", { gate_type: "kill_teardown", company: killedComp?.slug, company_id: approval.company_id });
        }
        break;

      case "spend_approval":
        // Budget approved — dispatch to the requesting agent
        if (approval.company_id) {
          const spendCtx = approval.context as { agent?: string; amount?: number } | null;
          const [spendComp] = await sql`SELECT slug FROM companies WHERE id = ${approval.company_id}`;
          await dispatchEvent("agent_dispatch", {
            agent: spendCtx?.agent || "growth",
            company: spendComp?.slug,
            budget_approved: spendCtx?.amount || 0,
            source: "spend_approval",
          });
        }
        break;

      case "growth_strategy":
        // Growth strategy approved — dispatch to Growth agent with approved plan
        if (approval.company_id) {
          const [stratComp] = await sql`SELECT slug FROM companies WHERE id = ${approval.company_id}`;
          await dispatchEvent("growth_trigger", {
            source: "approved_strategy",
            company: stratComp?.slug,
            approval_id: approval.id,
          });
        }
        break;

      case "prompt_upgrade":
        // Activate the proposed prompt version
        const ctx = approval.context as { agent?: string; version?: number } | null;
        if (ctx?.agent && ctx?.version) {
          await sql`UPDATE agent_prompts SET is_active = false WHERE agent = ${ctx.agent}`;
          await sql`UPDATE agent_prompts SET is_active = true, promoted_at = now() WHERE agent = ${ctx.agent} AND version = ${ctx.version}`;
        }
        break;

      case "vercel_pro_upgrade": {
        // Vercel doesn't have a plan upgrade API — log the manual action required
        const upgradeCtx = approval.context as { project_slug?: string; vercel_project_id?: string } | null;
        if (approval.company_id) {
          await sql`
            INSERT INTO agent_actions (company_id, agent, action_type, description, status, started_at, finished_at)
            VALUES (
              ${approval.company_id}, 'orchestrator', 'vercel_upgrade_approved',
              ${`Vercel Pro upgrade approved. Manual action: go to https://vercel.com/${upgradeCtx?.project_slug || "dashboard"}/settings/billing and upgrade to Pro.`},
              'pending_manual', now(), now()
            )
          `;
        }
        break;
      }

      case "capability_migration": {
        // Boilerplate migration approved — dispatch to company repo's hive-build.yml (free Actions)
        const migCtx = approval.context as {
          company?: string;
          github_repo?: string;
          boilerplate_version?: string;
          gaps?: Array<{ id: string; capability: string; description: string; files: string[]; sql?: string }>;
        } | null;

        if (migCtx?.github_repo && migCtx?.gaps?.length) {
          const ghPat = await getGitHubToken() || process.env.GH_PAT;
          if (ghPat) {
            // Build migration task description for the Engineer
            const migrationTasks = migCtx.gaps.map(g => {
              let task = `Add ${g.description}`;
              if (g.sql) task += `\nSQL: ${g.sql}`;
              task += `\nFiles: ${g.files.join(", ")}`;
              return task;
            }).join("\n\n");

            const taskSummary = `Boilerplate migration: add ${migCtx.gaps.length} features (${migCtx.gaps.map(g => g.id).join(", ")})`;

            // Dispatch to company repo's hive-build.yml
            await fetch(`https://api.github.com/repos/${migCtx.github_repo}/actions/workflows/hive-build.yml/dispatches`, {
              method: "POST",
              headers: {
                Authorization: `token ${ghPat}`,
                Accept: "application/vnd.github.v3+json",
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                ref: "main",
                inputs: {
                  task_summary: taskSummary,
                  company_slug: migCtx.company || "",
                  trigger: "boilerplate_migration",
                  payload: JSON.stringify({
                    migration_tasks: migrationTasks,
                    gaps: migCtx.gaps,
                    boilerplate_version: migCtx.boilerplate_version,
                  }),
                },
              }),
            });

            // Log the dispatch
            if (approval.company_id) {
              await sql`
                INSERT INTO agent_actions (company_id, agent, action_type, status, description, started_at, finished_at)
                VALUES (${approval.company_id}, 'engineer', 'boilerplate_migration', 'success',
                  ${`Dispatched migration to ${migCtx.github_repo}: ${migCtx.gaps.map(g => g.id).join(", ")}`},
                  now(), now())
              `;
            }
          }
        }
        break;
      }

      case "first_revenue": {
        // First paying customer — graduate from mvp to active + create Vercel Pro upgrade gate
        if (approval.company_id) {
          const [comp] = await sql`SELECT slug FROM companies WHERE id = ${approval.company_id}`;
          await sql`UPDATE companies SET status = 'active', updated_at = NOW() WHERE id = ${approval.company_id} AND status = 'mvp'`;
          await sql`
            INSERT INTO approvals (company_id, gate_type, title, description, context)
            VALUES (
              ${approval.company_id},
              'vercel_pro_upgrade',
              ${`Upgrade ${comp?.slug || "company"} to Vercel Pro`},
              ${`This company has its first paying customer. Vercel Hobby plan is non-commercial — it must be upgraded to Pro (€20/mo). Go to the Vercel dashboard to upgrade.`},
              ${JSON.stringify({ project_slug: comp?.slug })}
            )
          `;
        }
        break;
      }
    }
  }

  // Rejection side effects
  if (decision === "rejected") {
    switch (approval.gate_type) {
      case "new_company":
        // Clean up rejected idea — mark as killed so it doesn't clutter the dashboard
        if (approval.company_id) {
          await sql`
            UPDATE companies SET 
              status = 'killed', 
              killed_at = now(), 
              kill_reason = ${note || "Idea rejected by Carlos"},
              updated_at = now() 
            WHERE id = ${approval.company_id} AND status = 'idea'
          `;
        }
        break;
    }
  }

  return json(approval);
}

