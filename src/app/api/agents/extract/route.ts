import { NextRequest } from "next/server";
import { validateOIDC } from "@/lib/oidc";
import { getDb, json, err } from "@/lib/db";
import { getSettingValue } from "@/lib/settings";
import { setSentryTags } from "@/lib/sentry-tags";

// POST /api/agents/extract — Phase 2 pattern extraction from imported/existing codebases
// Reads a company's GitHub repo via API, identifies reusable patterns across domains,
// and writes playbook entries. Called by Engineer after onboarding or by Sentinel periodically.
//
// Body: { company_slug: string, company_id: string, domains?: string[] }
// domains defaults to all: testing, ci_cd, auth, payments, seo, email_marketing, api_design,
//   monitoring, landing_page, data_architecture, growth, content, design

const EXTRACTION_DOMAINS = [
  "testing",
  "ci_cd",
  "auth",
  "payments",
  "seo",
  "email_marketing",
  "api_design",
  "monitoring",
  "landing_page",
  "data_architecture",
  "growth",
  "content",
  "design",
] as const;

// Files/patterns that signal learnings per domain
const DOMAIN_SIGNALS: Record<string, { filePatterns: RegExp[]; depPatterns?: string[] }> = {
  testing: {
    filePatterns: [/playwright\.config/, /jest\.config/, /vitest\.config/, /\.spec\.(ts|js|tsx)$/, /\.test\.(ts|js|tsx)$/, /__tests__/, /cypress/],
    depPatterns: ["playwright", "jest", "vitest", "cypress", "@testing-library"],
  },
  ci_cd: {
    filePatterns: [/\.github\/workflows\/.*\.(yml|yaml)$/],
  },
  auth: {
    filePatterns: [/auth\.(ts|js|tsx)$/, /middleware\.(ts|js)$/, /jwt\.(ts|js)$/, /session/],
    depPatterns: ["next-auth", "lucia", "clerk", "supabase", "jose", "jsonwebtoken", "bcrypt"],
  },
  payments: {
    filePatterns: [/stripe/, /billing/, /checkout/, /subscription/, /webhook/],
    depPatterns: ["stripe", "lemonsqueezy", "paddle"],
  },
  seo: {
    filePatterns: [/sitemap/, /robots\.txt/, /og/, /meta/, /schema.*json/, /seo/i],
    depPatterns: ["next-seo", "next-sitemap"],
  },
  email_marketing: {
    filePatterns: [/email/, /resend/, /sendgrid/, /newsletter/, /drip/],
    depPatterns: ["resend", "@sendgrid/mail", "postmark", "nodemailer"],
  },
  api_design: {
    filePatterns: [/api\/.*route\.(ts|js)$/, /apiHandler/, /middleware/],
  },
  monitoring: {
    filePatterns: [/analytics/, /log-error/, /sentry/, /error.*boundary/i],
    depPatterns: ["@vercel/analytics", "@vercel/speed-insights", "@sentry/nextjs", "posthog"],
  },
  landing_page: {
    filePatterns: [/landing/i, /hero/i, /pricing/i, /features/i, /cta/i],
  },
  data_architecture: {
    filePatterns: [/schema\.(prisma|sql)$/, /drizzle/, /migration/],
    depPatterns: ["prisma", "drizzle-orm", "@neondatabase/serverless"],
  },
  growth: {
    filePatterns: [/waitlist/, /referral/, /onboard/i, /calculator/i, /checker/i],
  },
  content: {
    filePatterns: [/blog/, /posts?\//, /\.mdx?$/, /frontmatter/],
    depPatterns: ["react-markdown", "remark-gfm", "mdx", "contentlayer"],
  },
  design: {
    filePatterns: [/tailwind\.config/, /theme/, /globals\.css/],
  },
};

interface GHFile {
  path: string;
  size: number;
}

export async function POST(req: NextRequest) {
  setSentryTags({
    action_type: "agent_api",
    route: "/api/agents/extract",
  });

  const claims = await validateOIDC(req);
  if (claims instanceof Response) return claims;

  const body = await req.json();
  const { company_slug, company_id, domains } = body;

  if (!company_slug || !company_id) {
    return err("Missing company_slug or company_id", 400);
  }

  // Add company_id tag to Sentry
  setSentryTags({ company_id });

  const sql = getDb();
  const token = await getSettingValue("github_token");
  if (!token) return err("GitHub token not configured", 500);

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
  };

  // Get company's GitHub repo
  const [company] = await sql`SELECT github_repo, name FROM companies WHERE id = ${company_id}`;
  if (!company?.github_repo) return err("Company has no github_repo set", 400);

  const repo = company.github_repo.replace("https://github.com/", "");

  // Fetch repo file tree
  let files: GHFile[] = [];
  try {
    const treeRes = await fetch(
      `https://api.github.com/repos/${repo}/git/trees/main?recursive=1`,
      { headers }
    );
    if (!treeRes.ok) {
      // Try 'master' branch
      const masterRes = await fetch(
        `https://api.github.com/repos/${repo}/git/trees/master?recursive=1`,
        { headers }
      );
      if (!masterRes.ok) return err("Cannot read repo tree", 500);
      const data = await masterRes.json();
      files = (data.tree || []).filter((f: any) => f.type === "blob");
    } else {
      const data = await treeRes.json();
      files = (data.tree || []).filter((f: any) => f.type === "blob");
    }
  } catch (e: any) {
    return err(`GitHub API error: ${e.message}`, 500);
  }

  // Read package.json for dependency detection
  let deps: Record<string, string> = {};
  try {
    const pkgRes = await fetch(
      `https://api.github.com/repos/${repo}/contents/package.json`,
      { headers }
    );
    if (pkgRes.ok) {
      const pkgData = await pkgRes.json();
      const pkg = JSON.parse(Buffer.from(pkgData.content, "base64").toString());
      deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    }
  } catch { /* no package.json */ }

  const filePaths = files.map((f) => f.path);
  const activeDomains = domains || EXTRACTION_DOMAINS;
  const detectedDomains: Record<string, { matchedFiles: string[]; matchedDeps: string[] }> = {};

  // Detect which domains have signals in this codebase
  for (const domain of activeDomains) {
    const signals = DOMAIN_SIGNALS[domain];
    if (!signals) continue;

    const matchedFiles = filePaths.filter((p) =>
      signals.filePatterns.some((re) => re.test(p))
    );
    const matchedDeps = (signals.depPatterns || []).filter((d) => d in deps);

    if (matchedFiles.length > 0 || matchedDeps.length > 0) {
      detectedDomains[domain] = { matchedFiles, matchedDeps };
    }
  }

  // For each detected domain, read key files and build a summary
  const extractions: Array<{
    domain: string;
    files_read: string[];
    file_contents: Record<string, string>;
  }> = [];

  for (const [domain, { matchedFiles, matchedDeps }] of Object.entries(detectedDomains)) {
    // Read up to 5 key files per domain (prioritize config files and main implementations)
    const filesToRead = matchedFiles
      .filter((f) => {
        const size = files.find((x) => x.path === f)?.size || 0;
        return size < 100_000; // skip large files
      })
      .slice(0, 5);

    const fileContents: Record<string, string> = {};
    for (const filePath of filesToRead) {
      try {
        const res = await fetch(
          `https://api.github.com/repos/${repo}/contents/${filePath}`,
          { headers }
        );
        if (res.ok) {
          const data = await res.json();
          if (data.content) {
            const content = Buffer.from(data.content, "base64").toString();
            // Truncate to first 3000 chars to keep payloads reasonable
            fileContents[filePath] = content.slice(0, 3000);
          }
        }
      } catch { /* skip unreadable */ }
    }

    extractions.push({
      domain,
      files_read: filesToRead,
      file_contents: fileContents,
    });
  }

  // Check for existing playbook entries from this company to avoid duplicates
  const existing = await sql`
    SELECT domain, insight FROM playbook WHERE source_company_id = ${company_id}
  `;
  const existingDomains = new Set(existing.map((e: any) => e.domain));

  // Build extraction report for domains not yet in playbook
  const newDomains = extractions.filter((e) => !existingDomains.has(e.domain));
  const skippedDomains = extractions
    .filter((e) => existingDomains.has(e.domain))
    .map((e) => e.domain);

  // Return the extraction data — the calling agent (Engineer or CEO) uses this
  // to write playbook entries with proper insight text.
  // We also return a structured prompt that can be fed to an LLM to generate insights.
  const extractionPrompt = newDomains.length > 0
    ? buildExtractionPrompt(company.name, repo, newDomains, deps)
    : null;

  return json({
    company_slug,
    repo,
    total_files: files.length,
    dependencies: Object.keys(deps).length,
    detected_domains: Object.keys(detectedDomains),
    already_extracted: skippedDomains,
    new_domains: newDomains.map((e) => ({
      domain: e.domain,
      files_read: e.files_read,
      file_summaries: Object.fromEntries(
        Object.entries(e.file_contents).map(([k, v]) => [k, v.slice(0, 500) + (v.length > 500 ? "..." : "")])
      ),
    })),
    extraction_prompt: extractionPrompt,
  });
}

function buildExtractionPrompt(
  companyName: string,
  repo: string,
  extractions: Array<{ domain: string; files_read: string[]; file_contents: Record<string, string> }>,
  deps: Record<string, string>
): string {
  let prompt = `You are extracting reusable patterns from the ${companyName} codebase (${repo}) for Hive's cross-company playbook.\n\n`;
  prompt += `Dependencies: ${Object.keys(deps).join(", ")}\n\n`;

  for (const ext of extractions) {
    prompt += `## Domain: ${ext.domain}\n`;
    prompt += `Files found: ${ext.files_read.join(", ")}\n\n`;
    for (const [path, content] of Object.entries(ext.file_contents)) {
      prompt += `### ${path}\n\`\`\`\n${content}\n\`\`\`\n\n`;
    }
  }

  prompt += `\nFor each domain above, write a playbook entry as JSON:\n`;
  prompt += `{ "domain": "...", "insight": "...", "evidence": { "files": [...], "proven_in_production": true }, "confidence": 0.7-0.9 }\n`;
  prompt += `\nRules:\n`;
  prompt += `- Insight should be actionable advice, not description. Start with the pattern name, then specific implementation details.\n`;
  prompt += `- Include concrete details: file names, function names, specific techniques.\n`;
  prompt += `- Confidence: 0.9 = production-proven with clear evidence, 0.7 = good pattern but less evidence.\n`;
  prompt += `- Only extract patterns that would be useful for OTHER companies. Skip company-specific business logic.\n`;
  prompt += `- Output as JSON array.\n`;

  return prompt;
}
