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
  decision: 'auto_merge' | 'escalate';
  hardGatesPassed: boolean;
  hardGateIssues: string[];
  costImpact: boolean;
  costFactors: string[];
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
      'Authorization': `Bearer ${ghToken}`,
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
      'Authorization': `Bearer ${ghToken}`,
      'Accept': 'application/vnd.github.v3.diff'
    }
  });

  const diff = diffResponse.ok ? await diffResponse.text() : '';

  // Get CI status
  const checksResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${pr.head.sha}/check-runs`, {
    headers: {
      'Authorization': `Bearer ${ghToken}`,
      'Accept': 'application/vnd.github.v3+json'
    }
  });

  const checks = checksResponse.ok ? await checksResponse.json() : { check_runs: [] };
  const ciPassed = checks.check_runs.length === 0 ||
    checks.check_runs.every((check: any) => check.conclusion === 'success' || check.conclusion === 'neutral');

  // Safety gates — block merge entirely (security risks)
  const hardGateIssues: string[] = [];

  if (!ciPassed) {
    hardGateIssues.push('CI checks failed or pending');
  }

  // pr.mergeable is null when GitHub hasn't computed it yet — only flag explicit false
  if (pr.mergeable === false) {
    hardGateIssues.push('PR has merge conflicts');
  }

  // Check for secrets in diff — match actual secret values, not variable names.
  // Variable names like CRON_SECRET or GEMINI_API_KEY are safe to reference in code.
  // We look for: hardcoded tokens, .env files being added, actual Bearer tokens with values.
  const secretValuePatterns = [
    /sk_live_[a-zA-Z0-9]{20,}/i,       // Stripe live keys
    /sk_test_[a-zA-Z0-9]{20,}/i,       // Stripe test keys
    /rk_live_[a-zA-Z0-9]{20,}/i,       // Resend live keys
    /rk_test_[a-zA-Z0-9]{20,}/i,       // Resend test keys
    /Bearer\s+[a-zA-Z0-9_\-.]{20,}/i,  // Hardcoded Bearer tokens (20+ chars)
    /\+\s*password\s*[:=]\s*["'][^"']+["']/i, // Hardcoded passwords in additions
    /\+.*\.env(?:\.local|\.production)/i,      // .env files being added (not just referenced)
    /ghp_[a-zA-Z0-9]{36,}/,            // GitHub personal access tokens
    /gho_[a-zA-Z0-9]{36,}/,            // GitHub OAuth tokens
    /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/, // Private keys
  ];

  if (secretValuePatterns.some(pattern => pattern.test(diff))) {
    hardGateIssues.push('Potential secrets detected in diff');
  }

  // Check for destructive DB migrations
  if (/DROP\s+(TABLE|DATABASE|COLUMN)/i.test(diff) && !/rollback/i.test(diff)) {
    hardGateIssues.push('Destructive DB migration without rollback plan');
  }

  // Check diff size — hive/improvement/* PRs get a higher limit since self-improvement
  // features naturally have larger diffs (new lib + route + types in one PR).
  const totalChanges = pr.additions + pr.deletions;
  const isHiveImprovement = pr.head?.ref?.startsWith("hive/improvement/") || pr.head?.ref?.startsWith("hive/");
  const diffLimit = isHiveImprovement ? 2000 : 1000;
  if (totalChanges > diffLimit || pr.changed_files > 20) {
    hardGateIssues.push(`Large diff: ${totalChanges} lines, ${pr.changed_files} files`);
  }

  const hardGatesPassed = hardGateIssues.length === 0;

  // Risk scoring (same logic as CEO agent)
  let riskScore = 0;
  const riskFactors: string[] = [];

  // File-based risk factors
  const changedFiles = await getChangedFiles(owner, repo, prNumber, ghToken);

  // Cost gates — escalate to Carlos only when operational costs are affected
  const costFactors: string[] = [];
  const costImpact = detectCostImpact(changedFiles, diff, costFactors);

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

  // Decision logic
  let decision: PRAnalysis['decision'];
  if (!hardGatesPassed) {
    // Safety gates failed (secrets, conflicts, CI, destructive SQL, huge diff) — block
    decision = 'escalate';
  } else if (costImpact) {
    // Cost-impacting changes always need Carlos's review
    decision = 'escalate';
  } else if (riskScore >= 5) {
    // High risk score (5+) — too many compounding risk factors, escalate for review
    decision = 'escalate';
  } else {
    // CI passed + no safety issues + no cost impact + low risk → auto-merge
    decision = 'auto_merge';
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
    hardGateIssues,
    costImpact,
    costFactors,
  };
}

async function getChangedFiles(owner: string, repo: string, prNumber: number, ghToken: string): Promise<string[]> {
  const filesResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files`, {
    headers: {
      'Authorization': `Bearer ${ghToken}`,
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

/**
 * Detects whether a PR has cost impact — the only reason to escalate to Carlos.
 * Cost triggers: new paid services, workflow minute burns, model routing to more expensive LLMs,
 * Vercel config changes, new npm dependencies that could be paid.
 */
function detectCostImpact(files: string[], diff: string, costFactors: string[]): boolean {
  // New or modified GitHub Actions workflows burn private repo minutes
  if (files.some(f => f.includes('.github/workflows/'))) {
    // Only flag new workflows, not edits to existing ones
    if (diff.includes('+name:') && /^\+.*\.yml$|^\+.*\.yaml$/m.test(diff)) {
      costFactors.push('New GitHub Actions workflow (burns private minutes)');
    }
    // Check for changes to runs-on (e.g., switching to larger runners)
    if (/\+\s*runs-on:.*(?:xlarge|large|macos)/i.test(diff)) {
      costFactors.push('Upgraded runner size (higher cost per minute)');
    }
  }

  // Model routing changes — switching to more expensive LLMs
  if (files.some(f => f.includes('model') || f.includes('llm') || f.includes('provider'))) {
    if (/\+.*opus/i.test(diff) && !/\-.*opus/i.test(diff)) {
      costFactors.push('Added Opus model usage (most expensive tier)');
    }
  }

  // Vercel config changes that could trigger Pro upgrade
  if (files.some(f => f === 'vercel.json' || f === 'next.config.mjs' || f === 'next.config.js')) {
    if (/\+.*cron/i.test(diff)) {
      costFactors.push('New Vercel cron job (may require Pro plan)');
    }
    if (/\+.*maxDuration/i.test(diff)) {
      costFactors.push('Changed function duration limits (may require Pro plan)');
    }
  }

  // New paid npm dependencies (stripe, resend, neon, etc. are already used — flag truly new ones)
  if (files.includes('package.json')) {
    const paidServicePatterns = [
      /\+\s*"@aws-sdk/i, /\+\s*"firebase/i, /\+\s*"@google-cloud/i,
      /\+\s*"twilio/i, /\+\s*"sendgrid/i, /\+\s*"@sentry/i,
      /\+\s*"datadog/i, /\+\s*"newrelic/i, /\+\s*"@supabase/i,
    ];
    for (const pattern of paidServicePatterns) {
      if (pattern.test(diff)) {
        costFactors.push('New paid service dependency added');
        break;
      }
    }
  }

  // Schema changes that could cause downtime (data loss = operational cost)
  if (files.some(f => f.includes('schema.sql') || f.includes('migration'))) {
    if (/ALTER\s+TABLE.*DROP/i.test(diff) || /TRUNCATE/i.test(diff)) {
      costFactors.push('Schema change with potential data loss');
    }
  }

  return costFactors.length > 0;
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
        'Authorization': `Bearer ${ghToken}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        commit_title: `Auto-merge PR #${prNumber}`,
        commit_message: 'Automatically merged by Hive (CI passed, no cost impact)',
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