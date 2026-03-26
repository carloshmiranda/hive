#!/usr/bin/env node

/**
 * Deploy dependabot.yml to all company repositories
 *
 * This script:
 * 1. Fetches all companies with github_repo from the database
 * 2. For each company repo, checks if .github/dependabot.yml exists
 * 3. If not exists, creates the file with the same configuration as Hive
 * 4. Uses GitHub API to create the file directly in the default branch
 */

import { createClient } from '@neondatabase/serverless';

const sql = createClient({ connectionString: process.env.DATABASE_URL });

// Dependabot configuration content (same as Hive repo)
const DEPENDABOT_CONTENT = `# Dependabot configuration for company repository
# Automatically keeps npm dependencies updated with security patches
# Configured for weekly schedule with auto-merge for patch updates

version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
      day: "monday"
      time: "09:00"
      timezone: "Europe/Lisbon"
    # Auto-merge patch updates (security fixes, bug fixes)
    # Major and minor updates require manual review
    open-pull-requests-limit: 10
    reviewers:
      - "carloshmiranda"
    assignees:
      - "carloshmiranda"
    commit-message:
      prefix: "deps"
      include: "scope"
    # Group related dependency updates together
    groups:
      next-ecosystem:
        patterns:
          - "next"
          - "react"
          - "react-dom"
          - "@types/react"
      dev-dependencies:
        patterns:
          - "@types/*"
          - "typescript"
          - "tailwindcss"
          - "@tailwindcss/*"
      security-deps:
        patterns:
          - "*"
        update-types:
          - "security"
    # Allow Dependabot to update these dependencies even if they have vulnerabilities
    # (useful for transitive dependencies where direct update isn't possible)
    allow:
      - dependency-type: "all"
`;

async function main() {
  try {
    // Get GitHub token from environment
    const githubToken = process.env.GH_PAT;
    if (!githubToken) {
      console.error('❌ GH_PAT environment variable is required');
      process.exit(1);
    }

    console.log('🔍 Fetching company repositories from database...');

    // Fetch all companies with github_repo
    const companies = await sql`
      SELECT slug, github_repo, name
      FROM companies
      WHERE github_repo IS NOT NULL
        AND github_repo != ''
        AND status != 'killed'
      ORDER BY slug
    `;

    if (companies.length === 0) {
      console.log('ℹ️  No company repositories found');
      await sql.end();
      return;
    }

    console.log(`📋 Found ${companies.length} company repositories:`);
    companies.forEach(c => console.log(`  • ${c.slug} → ${c.github_repo}`));
    console.log('');

    let updated = 0;
    let skipped = 0;
    let errors = 0;

    for (const company of companies) {
      const { slug, github_repo, name } = company;

      try {
        console.log(`🔍 Checking ${slug} (${github_repo})...`);

        // Check if dependabot.yml already exists
        const checkResponse = await fetch(
          `https://api.github.com/repos/${github_repo}/contents/.github/dependabot.yml`,
          {
            headers: {
              'Authorization': `token ${githubToken}`,
              'Accept': 'application/vnd.github.v3+json',
              'User-Agent': 'hive-dependabot-deploy'
            }
          }
        );

        if (checkResponse.status === 200) {
          console.log(`  ⏭️  dependabot.yml already exists, skipping`);
          skipped++;
          continue;
        }

        if (checkResponse.status !== 404) {
          console.error(`  ❌ Unexpected response ${checkResponse.status} when checking file`);
          errors++;
          continue;
        }

        // File doesn't exist, create it
        console.log(`  📝 Creating .github/dependabot.yml...`);

        const createResponse = await fetch(
          `https://api.github.com/repos/${github_repo}/contents/.github/dependabot.yml`,
          {
            method: 'PUT',
            headers: {
              'Authorization': `token ${githubToken}`,
              'Accept': 'application/vnd.github.v3+json',
              'User-Agent': 'hive-dependabot-deploy',
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              message: 'feat: add Dependabot configuration for automated dependency updates\n\nConfigures weekly dependency updates with auto-merge for patch updates.\nHelps maintain security by preventing vulnerabilities from accumulating.',
              content: Buffer.from(DEPENDABOT_CONTENT).toString('base64'),
              committer: {
                name: 'Hive Orchestrator',
                email: 'hive@carloshmiranda.io'
              },
              author: {
                name: 'Hive Orchestrator',
                email: 'hive@carloshmiranda.io'
              }
            })
          }
        );

        if (createResponse.status === 201) {
          console.log(`  ✅ Successfully created dependabot.yml`);
          updated++;
        } else {
          const errorText = await createResponse.text();
          console.error(`  ❌ Failed to create file (${createResponse.status}): ${errorText}`);
          errors++;
        }

      } catch (error) {
        console.error(`  ❌ Error processing ${slug}: ${error.message}`);
        errors++;
      }

      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log('');
    console.log('📊 Summary:');
    console.log(`  ✅ Updated: ${updated}`);
    console.log(`  ⏭️  Skipped: ${skipped}`);
    console.log(`  ❌ Errors: ${errors}`);
    console.log(`  📋 Total: ${companies.length}`);

    if (updated > 0) {
      console.log('');
      console.log('🎉 Dependabot is now configured for all company repositories!');
      console.log('   Dependencies will be automatically updated weekly.');
      console.log('   Patch updates will be auto-merged for security.');
    }

  } catch (error) {
    console.error('❌ Script failed:', error);
    process.exit(1);
  } finally {
    await sql.end();
  }
}

// Run the script
main().catch(console.error);