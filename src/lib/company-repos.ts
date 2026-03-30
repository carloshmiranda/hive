import { getDb } from "@/lib/db";

export interface CompanyRepo {
  id: string;
  name: string;
  slug: string;
  github_repo?: string;
}

/**
 * Get all active company repos that need skills backported
 */
export async function getActiveCompanyRepos(): Promise<CompanyRepo[]> {
  const sql = getDb();

  // Get active companies with GitHub repos
  const companies = await sql`
    SELECT id, name, slug, github_repo
    FROM companies
    WHERE status IN ('mvp', 'active')
    AND github_repo IS NOT NULL
    ORDER BY slug
  `;

  return companies as CompanyRepo[];
}

/**
 * Get target company repos for backporting (the 4 mentioned companies)
 */
export async function getTargetCompanyRepos(): Promise<CompanyRepo[]> {
  const sql = getDb();

  const targetSlugs = ['verdedesk', 'senhorio', 'flolio', 'ciberPME'];

  const companies = await sql`
    SELECT id, name, slug, github_repo
    FROM companies
    WHERE slug = ANY(${targetSlugs})
    AND github_repo IS NOT NULL
    ORDER BY slug
  `;

  return companies as CompanyRepo[];
}

/**
 * Get GitHub owner from settings or environment
 */
export function getGitHubOwner(): string {
  // Try environment first, fallback to hard-coded for now
  return process.env.GITHUB_OWNER || 'hiveventures';
}