import { NextRequest } from "next/server";
import { getDb, json, err } from "@/lib/db";
import { SkillsBackporter } from "@/lib/skills-backport";
import { getTargetCompanyRepos } from "@/lib/company-repos";

export async function POST(req: NextRequest) {
  const sql = getDb();

  try {
    // Get target company repos for backporting
    const companies = await getTargetCompanyRepos();

    if (companies.length === 0) {
      return err("No target company repos found for backporting", 404);
    }

    // Log start of backport process
    await sql`
      INSERT INTO agent_actions (agent, action_type, description, status, input)
      VALUES (
        'engineer',
        'feature_request',
        'Backport skills to company repos',
        'running',
        ${JSON.stringify({ companies: companies.map(c => ({ name: c.name, slug: c.slug, repo: c.github_repo })) })}
      )
    `;

    // Initialize backporter and process repos
    const backporter = new SkillsBackporter();
    const results = await backporter.backportToMultipleRepos(companies);

    // Analyze results
    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);
    const totalSkills = successful.reduce((sum, r) => sum + r.skillsInstalled.length, 0);

    const summary = {
      total_repos: companies.length,
      successful_repos: successful.length,
      failed_repos: failed.length,
      total_skills_installed: totalSkills,
      results
    };

    const overallSuccess = failed.length === 0;
    const status = overallSuccess ? 'success' : (successful.length > 0 ? 'completed' : 'failed');

    // Log completion
    await sql`
      INSERT INTO agent_actions (agent, action_type, description, status, output)
      VALUES (
        'engineer',
        'feature_request',
        ${`Backport skills completed: ${successful.length}/${companies.length} repos successful`},
        ${status},
        ${JSON.stringify(summary)}
      )
    `;

    return json(summary);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Log error
    await sql`
      INSERT INTO agent_actions (agent, action_type, description, status, error)
      VALUES (
        'engineer',
        'feature_request',
        'Backport skills to company repos',
        'failed',
        ${errorMessage}
      )
    `;

    console.error("Skills backport error:", error);
    return err(`Skills backport failed: ${errorMessage}`, 500);
  }
}

// GET endpoint to check status and see which companies would be affected
export async function GET() {
  try {
    const companies = await getTargetCompanyRepos();

    const preview = {
      target_companies: companies.map(c => ({
        name: c.name,
        slug: c.slug,
        github_repo: c.github_repo
      })),
      total_count: companies.length,
      missing_repos: companies.filter(c => !c.github_repo).length
    };

    return json(preview);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return err(`Failed to get target companies: ${errorMessage}`, 500);
  }
}