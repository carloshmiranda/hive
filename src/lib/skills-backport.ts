import { pushFiles, pushFile } from "@/lib/github";
import { CompanyRepo, getGitHubOwner } from "@/lib/company-repos";

export interface SkillsLock {
  version: number;
  skills: Record<string, {
    source: string;
    sourceType: string;
    computedHash: string;
  }>;
}

export interface BackportResult {
  success: boolean;
  repo: string;
  skillsInstalled: string[];
  errors: string[];
}

export class SkillsBackporter {
  private owner: string;

  constructor() {
    this.owner = getGitHubOwner();
  }

  /**
   * Backport all skills to a company repo
   */
  async backportToRepo(company: CompanyRepo): Promise<BackportResult> {
    if (!company.github_repo) {
      return {
        success: false,
        repo: company.slug,
        skillsInstalled: [],
        errors: ["No GitHub repo configured for company"]
      };
    }

    const [owner, repo] = company.github_repo.split('/');
    const result: BackportResult = {
      success: false,
      repo: company.github_repo,
      skillsInstalled: [],
      errors: []
    };

    try {
      // 1. Load skills from skills-lock.json
      const skillsLock = await this.loadSkillsLock();

      // 2. Install all skills
      await this.installSkills(owner, repo, skillsLock, result);

      // 3. Create component organization
      await this.createComponentStructure(owner, repo);

      // 4. Update CLAUDE.md
      await this.updateClaudeMd(owner, repo, company, skillsLock);

      result.success = result.errors.length === 0;
      return result;
    } catch (error) {
      result.errors.push(`Fatal error: ${error instanceof Error ? error.message : String(error)}`);
      return result;
    }
  }

  /**
   * Load skills-lock.json from the Hive repository
   */
  private async loadSkillsLock(): Promise<SkillsLock> {
    const fs = await import('fs/promises');
    const path = await import('path');

    try {
      const skillsLockPath = path.join(process.cwd(), 'skills-lock.json');
      const skillsLockContent = await fs.readFile(skillsLockPath, 'utf-8');
      return JSON.parse(skillsLockContent) as SkillsLock;
    } catch (error) {
      throw new Error(`Failed to load skills-lock.json: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Install all skills to a repo via GitHub API
   * This emulates: npx skills add <skill-name> for each skill
   */
  private async installSkills(owner: string, repo: string, skillsLock: SkillsLock, result: BackportResult): Promise<void> {
    try {
      // Create skills-lock.json file
      const skillsLockContent = JSON.stringify(skillsLock, null, 2);

      await pushFile(
        owner,
        repo,
        'skills-lock.json',
        skillsLockContent,
        'feat: add skills configuration from Hive backport'
      );

      result.skillsInstalled = Object.keys(skillsLock.skills);
    } catch (error) {
      result.errors.push(`Failed to install skills: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Create three-layer component organization
   */
  private async createComponentStructure(owner: string, repo: string): Promise<void> {
    const componentFiles = [
      {
        path: 'components/ui/.gitkeep',
        content: '# UI Components\n\nPrimitive UI components (buttons, inputs, etc.)'
      },
      {
        path: 'components/primitives/.gitkeep',
        content: '# Primitive Components\n\nBasic building blocks for complex components'
      },
      {
        path: 'components/blocks/.gitkeep',
        content: '# Block Components\n\nComplete UI blocks and sections'
      }
    ];

    await pushFiles(
      owner,
      repo,
      componentFiles,
      'feat: add three-layer component organization'
    );
  }

  /**
   * Update CLAUDE.md to reference skills and components
   */
  private async updateClaudeMd(owner: string, repo: string, company: CompanyRepo, skillsLock: SkillsLock): Promise<void> {
    const skillsList = Object.keys(skillsLock.skills).sort();
    const skillsSection = skillsList.map(skill => `- ${skill}`).join('\n');

    const claudeMdContent = `# ${company.name}

You are the AI agent for ${company.name}, helping to build and grow this business.

## Available Skills

The following Claude Code skills are available for use in this project:

${skillsSection}

Use the Skill tool to invoke any of these skills when relevant to the user's request.

## Component Organization

This project uses a three-layer component organization:

### 1. UI Components (\`components/ui/\`)
Primitive UI components following shadcn/ui patterns:
- buttons, inputs, cards, dialogs, etc.
- Focused on design system consistency
- Minimal business logic

### 2. Primitive Components (\`components/primitives/\`)
Basic building blocks that combine UI components:
- Form wrappers, layout containers
- Simple interactive elements
- Reusable patterns

### 3. Block Components (\`components/blocks/\`)
Complete UI sections and page blocks:
- Headers, footers, hero sections
- Feature showcases, testimonials
- Complex forms and workflows

## Development Guidelines

- Use TypeScript throughout
- Follow Next.js App Router patterns
- Implement shadcn/ui components for consistent design
- Prioritize accessibility and performance
- Build incrementally with user validation

## Business Context

${company.name} is managed by Hive, an autonomous venture orchestrator. Focus on:
- Rapid iteration and user feedback
- Data-driven feature decisions
- Growth and revenue optimization
- Technical excellence and maintainability
`;

    await pushFile(
      owner,
      repo,
      'CLAUDE.md',
      claudeMdContent,
      `docs: update CLAUDE.md with skills and component organization`
    );
  }

  /**
   * Backport skills to multiple company repos
   */
  async backportToMultipleRepos(companies: CompanyRepo[]): Promise<BackportResult[]> {
    const results: BackportResult[] = [];

    // Process sequentially to avoid GitHub API rate limits
    for (const company of companies) {
      try {
        const result = await this.backportToRepo(company);
        results.push(result);

        // Add small delay between repos to be gentle on API
        if (companies.indexOf(company) < companies.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } catch (error) {
        results.push({
          success: false,
          repo: company.github_repo || company.slug,
          skillsInstalled: [],
          errors: [`Failed to process ${company.name}: ${error instanceof Error ? error.message : String(error)}`]
        });
      }
    }

    return results;
  }
}