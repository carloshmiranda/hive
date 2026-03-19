import { getDb, json, err } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { getSettingValue } from "@/lib/settings";

// GET: list all imports
export async function GET() {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const sql = getDb();
  const imports = await sql`
    SELECT i.*, c.name as company_name, c.slug as company_slug
    FROM imports i LEFT JOIN companies c ON c.id = i.company_id
    ORDER BY i.created_at DESC
  `;
  return json(imports);
}

// POST: start importing a project
// Body: { source_type, source_url, name, slug, description }
export async function POST(req: Request) {
  const session = await requireAuth();
  if (!session) return err("Unauthorized", 401);

  const body = await req.json();
  const { source_type, source_url, name, slug, description } = body;

  if (!source_type || !name || !slug) {
    return err("source_type, name, and slug are required");
  }

  const sql = getDb();

  // 1. Create or reuse the company record
  let [company] = await sql`SELECT * FROM companies WHERE slug = ${slug}`;
  if (company) {
    // Update existing record with latest info
    [company] = await sql`
      UPDATE companies SET name = ${name}, description = COALESCE(${description || null}, description),
        github_repo = COALESCE(${source_url || null}, github_repo),
        status = CASE WHEN status IN ('idea', 'approved') THEN 'mvp' ELSE status END
      WHERE slug = ${slug} RETURNING *
    `;
  } else {
    [company] = await sql`
      INSERT INTO companies (name, slug, description, status, github_repo)
      VALUES (${name}, ${slug}, ${description || null}, 'mvp', ${source_url || null})
      RETURNING *
    `;
  }

  // 2. Create the import record (clear any stale previous imports for this company)
  await sql`DELETE FROM imports WHERE company_id = ${company.id} AND onboard_status = 'pending'`;
  const [importRecord] = await sql`
    INSERT INTO imports (company_id, source_type, source_url, scan_status, onboard_status)
    VALUES (${company.id}, ${source_type}, ${source_url || null}, 'pending', 'pending')
    RETURNING *
  `;

  // 3. If it's a GitHub repo, try to scan it immediately
  if (source_type === "github_repo" && source_url) {
    try {
      const scanReport = await scanGitHubRepo(source_url);
      await sql`
        UPDATE imports SET scan_status = 'scanned', scan_report = ${JSON.stringify(scanReport)}
        WHERE id = ${importRecord.id}
      `;

      // Auto-fill company fields from scan
      if (scanReport.vercel_url) {
        await sql`UPDATE companies SET vercel_url = ${scanReport.vercel_url} WHERE id = ${company.id}`;
      }

      // Create an approval gate for the onboarding plan
      await sql`
        INSERT INTO approvals (company_id, gate_type, title, description, context)
        VALUES (
          ${company.id}, 'new_company',
          ${"Onboard " + name + " into Hive"},
          ${`Scanned ${source_url}. Tech: ${scanReport.tech_stack?.join(", ") || "unknown"}. ` +
            `Files: ${scanReport.file_count || "?"}. ` +
            `Has CLAUDE.md: ${scanReport.has_claude_md ? "yes" : "no — will generate one"}. ` +
            `Suggested actions: ${scanReport.suggested_actions?.join(", ") || "review scan report"}`},
          ${JSON.stringify(scanReport)}
        )
      `;

      return json({ company, import: importRecord, scan: scanReport }, 201);
    } catch (e: any) {
      await sql`UPDATE imports SET scan_status = 'failed' WHERE id = ${importRecord.id}`;
      return json({ company, import: importRecord, scan_error: e.message }, 201);
    }
  }

  return json({ company, import: importRecord }, 201);
}

// Scan a GitHub repo to understand what it is
async function scanGitHubRepo(repoUrl: string): Promise<Record<string, any>> {
  const token = await getSettingValue("github_token");
  if (!token) throw new Error("GitHub token not configured");

  // Parse owner/repo from URL
  const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) throw new Error("Invalid GitHub URL");
  const [, owner, repo] = match;

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
  };

  // Fetch repo info
  const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
  if (!repoRes.ok) throw new Error(`Repo not found: ${repoRes.status}`);
  const repoData = await repoRes.json();

  // Fetch root tree to analyze structure
  const treeRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${repoData.default_branch}?recursive=1`, { headers });
  const treeData = treeRes.ok ? await treeRes.json() : { tree: [] };

  const files = (treeData.tree || []).map((f: any) => f.path);
  const fileCount = files.length;

  // Detect tech stack from files
  const techStack: string[] = [];
  const hasFile = (name: string) => files.some((f: string) => f.endsWith(name) || f === name);

  if (hasFile("package.json")) techStack.push("Node.js");
  if (hasFile("next.config.mjs") || hasFile("next.config.js") || hasFile("next.config.ts")) techStack.push("Next.js");
  if (hasFile("tailwind.config.ts") || hasFile("tailwind.config.js") || files.some((f: string) => f.includes("tailwind"))) techStack.push("Tailwind");
  if (hasFile("tsconfig.json")) techStack.push("TypeScript");
  if (hasFile("requirements.txt") || hasFile("pyproject.toml")) techStack.push("Python");
  if (hasFile("Gemfile")) techStack.push("Ruby");
  if (hasFile("go.mod")) techStack.push("Go");
  if (hasFile("Cargo.toml")) techStack.push("Rust");
  if (hasFile("docker-compose.yml") || hasFile("Dockerfile")) techStack.push("Docker");
  if (hasFile("vercel.json")) techStack.push("Vercel");

  // Check for key files
  const hasClaudeMd = hasFile("CLAUDE.md");
  const hasReadme = hasFile("README.md");
  const hasEnvExample = hasFile(".env.example") || hasFile(".env.local.example");
  const hasTests = files.some((f: string) => f.includes("test") || f.includes("spec") || f.includes("__tests__"));
  const hasCI = files.some((f: string) => f.startsWith(".github/workflows/"));
  const hasStripe = files.some((f: string) => f.toLowerCase().includes("stripe"));

  // Check for Vercel deployment
  let vercelUrl: string | null = null;
  if (repoData.homepage) vercelUrl = repoData.homepage;

  // Try to read package.json for more details
  let packageJson: any = null;
  try {
    const pkgRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/package.json`, { headers });
    if (pkgRes.ok) {
      const pkgData = await pkgRes.json();
      packageJson = JSON.parse(Buffer.from(pkgData.content, "base64").toString());
    }
  } catch { /* ignore */ }

  // Suggested actions based on what's missing
  const suggestedActions: string[] = [];
  if (!hasClaudeMd) suggestedActions.push("Generate CLAUDE.md for agent context");
  if (!hasEnvExample) suggestedActions.push("Create .env.example for env var documentation");
  if (!hasTests) suggestedActions.push("Add test infrastructure");
  if (!hasStripe) suggestedActions.push("Integrate Stripe for payments");
  if (!hasCI) suggestedActions.push("Set up CI/CD pipeline");
  suggestedActions.push("Register in Hive metrics tracking");
  suggestedActions.push("Link Vercel project to Hive dashboard");

  return {
    repo: `${owner}/${repo}`,
    description: repoData.description,
    default_branch: repoData.default_branch,
    language: repoData.language,
    file_count: fileCount,
    tech_stack: techStack,
    has_claude_md: hasClaudeMd,
    has_readme: hasReadme,
    has_env_example: hasEnvExample,
    has_tests: hasTests,
    has_ci: hasCI,
    has_stripe: hasStripe,
    vercel_url: vercelUrl,
    package_name: packageJson?.name,
    dependencies: packageJson ? Object.keys(packageJson.dependencies || {}).length : null,
    suggested_actions: suggestedActions,
    top_level_dirs: files.filter((f: string) => !f.includes("/")).slice(0, 20),
    scanned_at: new Date().toISOString(),
  };
}
