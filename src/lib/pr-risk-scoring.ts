import { getDb } from "@/lib/db";

export interface PRAnalysis {
  prNumber: number;
  title: string;
  body: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  mergeable: boolean;
  ciPassed: boolean;
  riskScore: number;
  riskFactors: string[];
  decision: 'auto_merge' | 'manual_review' | 'escalate';
  hardGatesPassed: boolean;
  hardGateIssues: string[];
}

export interface PRDiff {
  content: string;
  files: string[];
}

/**
 * Analyzes a PR and calculates risk score using the same logic as CEO agent
 * Returns analysis with merge recommendation
 */
export async function analyzePR(
  owner: string,
  repo: string,
  prNumber: number,
  ghToken: string
): Promise<PRAnalysis> {
  // Get PR details from GitHub API
  const prResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, {
    headers: {
      'Authorization': `token ${ghToken}`,
      'Accept': 'application/vnd.github.v3+json'
    }
  });

  if (!prResponse.ok) {
    throw new Error(`Failed to fetch PR details: ${prResponse.statusText}`);
  }

  const pr = await prResponse.json();

  // Get PR diff
  const diffResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}.diff`, {
    headers: {
      'Authorization': `token ${ghToken}`,
      'Accept': 'application/vnd.github.v3.diff'
    }
  });

  const diff = diffResponse.ok ? await diffResponse.text() : '';

  // Get CI status
  const checksResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${pr.head.sha}/check-runs`, {
    headers: {
      'Authorization': `token ${ghToken}`,
      'Accept': 'application/vnd.github.v3+json'
    }
  });

  const checks = checksResponse.ok ? await checksResponse.json() : { check_runs: [] };
  const ciPassed = checks.check_runs.length === 0 ||
    checks.check_runs.every((check: any) => check.conclusion === 'success' || check.conclusion === 'neutral');

  // Hard gates analysis
  const hardGateIssues: string[] = [];

  if (!ciPassed) {
    hardGateIssues.push('CI checks failed or pending');
  }

  if (!pr.mergeable) {
    hardGateIssues.push('PR has merge conflicts');
  }

  // Check for secrets in diff
  const secretPatterns = [
    /API_KEY/i, /SECRET/i, /PASSWORD/i, /Bearer\s+[a-zA-Z0-9]/i,
    /\.env/i, /sk_live/i, /sk_test/i, /rk_live/i, /rk_test/i
  ];

  if (secretPatterns.some(pattern => pattern.test(diff))) {
    hardGateIssues.push('Potential secrets detected in diff');
  }

  // Check for destructive DB migrations
  if (/DROP\s+(TABLE|DATABASE|COLUMN)/i.test(diff) && !/rollback/i.test(diff)) {
    hardGateIssues.push('Destructive DB migration without rollback plan');
  }

  // Check diff size (hard gate for >1000 lines or >20 files)
  const totalChanges = pr.additions + pr.deletions;
  if (totalChanges > 1000 || pr.changed_files > 20) {
    hardGateIssues.push(`Large diff: ${totalChanges} lines, ${pr.changed_files} files`);
  }

  const hardGatesPassed = hardGateIssues.length === 0;

  // Risk scoring (same logic as CEO agent)
  let riskScore = 0;
  const riskFactors: string[] = [];

  // File-based risk factors
  const changedFiles = await getChangedFiles(owner, repo, prNumber, ghToken);

  if (changedFiles.some(f => f.includes('auth') || f.includes('payment') || f.includes('user'))) {
    riskScore += 3;
    riskFactors.push('Touches auth/payments/user data (+3)');
  }

  if (changedFiles.some(f => f.includes('schema.sql') || f.includes('migration'))) {
    riskScore += 3;
    riskFactors.push('Changes DB schema (+3)');
  }

  if (diff.includes('package.json') && diff.includes('+')) {
    riskScore += 2;
    riskFactors.push('Adds new dependencies (+2)');
  }

  if (totalChanges > 500) {
    riskScore += 2;
    riskFactors.push(`>500 lines changed (${totalChanges}) (+2)`);
  }

  if (pr.changed_files > 10) {
    riskScore += 2;
    riskFactors.push(`>10 files changed (${pr.changed_files}) (+2)`);
  }

  if (changedFiles.some(f => f.includes('/api/'))) {
    riskScore += 1;
    riskFactors.push('New API routes (+1)');
  }

  if (changedFiles.some(f => f.includes('page.tsx'))) {
    riskScore += 1;
    riskFactors.push('Touches landing page (+1)');
  }

  // Check for design violations
  const designViolations = checkDesignViolations(diff);
  if (designViolations.length > 0) {
    riskScore += 2;
    riskFactors.push(`Design violations: ${designViolations.join(', ')} (+2)`);
  }

  // Content-only changes get score reduction
  if (isContentOnlyChange(changedFiles, diff)) {
    riskScore -= 2;
    riskFactors.push('Only content/copy changes (-2)');
  }

  // Ensure minimum score of 0
  riskScore = Math.max(0, riskScore);

  // Decision logic (same as CEO agent)
  let decision: PRAnalysis['decision'];
  if (!hardGatesPassed) {
    decision = 'escalate';
  } else if (riskScore <= 3) {
    decision = 'auto_merge';
  } else if (riskScore <= 6) {
    decision = 'manual_review';
  } else {
    decision = 'escalate';
  }

  return {
    prNumber,
    title: pr.title,
    body: pr.body || '',
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changed_files,
    mergeable: pr.mergeable,
    ciPassed,
    riskScore,
    riskFactors,
    decision,
    hardGatesPassed,
    hardGateIssues
  };
}

async function getChangedFiles(owner: string, repo: string, prNumber: number, ghToken: string): Promise<string[]> {
  const filesResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files`, {
    headers: {
      'Authorization': `token ${ghToken}`,
      'Accept': 'application/vnd.github.v3+json'
    }
  });

  if (!filesResponse.ok) return [];

  const files = await filesResponse.json();
  return files.map((file: any) => file.filename);
}

function checkDesignViolations(diff: string): string[] {
  const violations: string[] = [];

  if (/bg-gradient-to-|from-|via-/.test(diff)) {
    violations.push('gradients');
  }

  if (/#[0-9a-fA-F]{3,6}/.test(diff)) {
    violations.push('raw hex colors');
  }

  if (/font-(black|extrabold)/.test(diff)) {
    violations.push('excessive font weights');
  }

  if (/lorem ipsum|coming soon/i.test(diff)) {
    violations.push('placeholder content');
  }

  return violations;
}

function isContentOnlyChange(files: string[], diff: string): boolean {
  // Check if only markdown, text, or content files changed
  const contentExtensions = ['.md', '.txt', '.json'];
  const onlyContentFiles = files.every(file =>
    contentExtensions.some(ext => file.endsWith(ext)) ||
    file.includes('content/') ||
    file.includes('public/')
  );

  // And no actual code changes (only +/- on text content)
  const codePatterns = [/function\s+\w+/, /class\s+\w+/, /import\s+/, /export\s+/, /{.*}/, /if\s*\(/, /for\s*\(/];
  const hasCodeChanges = codePatterns.some(pattern => pattern.test(diff));

  return onlyContentFiles && !hasCodeChanges;
}

/**
 * Auto-merges a PR using GitHub API
 */
export async function autoMergePR(
  owner: string,
  repo: string,
  prNumber: number,
  ghToken: string,
  mergeMethod: 'merge' | 'squash' | 'rebase' = 'merge'
): Promise<{ success: boolean; message?: string }> {
  try {
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/merge`, {
      method: 'PUT',
      headers: {
        'Authorization': `token ${ghToken}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        commit_title: `Auto-merge PR #${prNumber} (risk score: low)`,
        commit_message: 'Automatically merged by Hive auto-merge system (risk score 0-3, CI passed)',
        merge_method: mergeMethod
      })
    });

    if (response.ok) {
      return { success: true };
    } else {
      const error = await response.json();
      return { success: false, message: error.message || 'Merge failed' };
    }
  } catch (error) {
    return { success: false, message: `Merge error: ${error}` };
  }
}