#!/usr/bin/env node

/**
 * Enable "Automatically delete head branches" on Hive repo and all company repos
 *
 * This script:
 * 1. Enables delete_branch_on_merge on the Hive repo
 * 2. Enables delete_branch_on_merge on all known company repos
 *
 * Prevents stale branch accumulation after PR merges.
 */

const { execSync } = require('child_process');

if (!process.env.GH_PAT) {
  console.error('ERROR: GH_PAT environment variable not set');
  process.exit(1);
}

// Known company repositories from BRIEFING.md
const COMPANY_REPOS = [
  'carloshmiranda/verdedesk',
  'carloshmiranda/senhorio',
  'carloshmiranda/flolio',
  'carloshmiranda/ciberpme'
];

async function enableAutoDeleteBranches(repo) {
  try {
    console.log(`Enabling auto-delete branches for ${repo}...`);

    const result = execSync(`GH_TOKEN="$GH_PAT" gh api repos/${repo} --method PATCH --field delete_branch_on_merge=true`, {
      encoding: 'utf-8'
    });

    const repoData = JSON.parse(result);
    console.log(`✅ ${repo}: delete_branch_on_merge = ${repoData.delete_branch_on_merge}`);

    return true;
  } catch (error) {
    console.error(`❌ Failed to update ${repo}:`, error.message);
    return false;
  }
}

async function main() {
  console.log('🔧 Enabling auto-delete head branches...\n');

  // 1. Enable on Hive repo first
  console.log('1. Updating Hive repository...');
  const hiveSuccess = await enableAutoDeleteBranches('carloshmiranda/hive');

  // 2. Enable on all company repos
  console.log('\n2. Updating company repositories...');

  let successCount = 0;
  let failureCount = 0;

  for (const repo of COMPANY_REPOS) {
    console.log(`\nUpdating ${repo}...`);
    const success = await enableAutoDeleteBranches(repo);

    if (success) {
      successCount++;
    } else {
      failureCount++;
    }
  }

  // 3. Summary
  console.log('\n📊 Summary:');
  console.log(`Hive repo: ${hiveSuccess ? '✅' : '❌'}`);
  console.log(`Company repos: ${successCount} success, ${failureCount} failures`);
  console.log(`Total repos updated: ${(hiveSuccess ? 1 : 0) + successCount}/${1 + COMPANY_REPOS.length}`);

  if (failureCount > 0) {
    console.log('\n⚠️  Some repos failed to update. Check the errors above.');
    process.exit(1);
  } else {
    console.log('\n🎉 All repos successfully updated!');
  }
}

main().catch(error => {
  console.error('Script failed:', error);
  process.exit(1);
});