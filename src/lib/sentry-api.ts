/**
 * Sentry API client for monitoring error patterns
 *
 * Provides functions to fetch unresolved issues from Sentry API
 * and extract error patterns for automated response.
 */

import { getSettingValue } from "@/lib/settings";

export interface SentryIssue {
  id: string;
  title: string;
  culprit: string;
  count: string;
  firstSeen: string;
  lastSeen: string;
  level: string;
  status: string;
  project: {
    slug: string;
  };
  metadata?: {
    type?: string;
    value?: string;
  };
}

export interface ErrorPattern {
  pattern: string;
  count: number;
  issues: SentryIssue[];
  severity: 'low' | 'medium' | 'high';
}

/**
 * Fetch recent unresolved errors from Sentry
 * @param sinceSecs - Look back this many seconds (default: 3600 = 1 hour)
 */
export async function fetchRecentErrors(sinceSecs: number = 3600): Promise<SentryIssue[]> {
  const authToken = await getSettingValue("sentry_auth_token");
  const sentryOrg = await getSettingValue("sentry_org") || "hive-ventures";
  const sentryProject = await getSettingValue("sentry_project") || "hive";

  if (!authToken) {
    console.warn("[sentry-api] No sentry_auth_token configured");
    return [];
  }

  const sinceDate = new Date(Date.now() - sinceSecs * 1000).toISOString();
  const query = encodeURIComponent(`is:unresolved firstSeen:>=${sinceDate}`);
  const url = `https://sentry.io/api/0/projects/${sentryOrg}/${sentryProject}/issues/?query=${query}&sort=freq`;

  try {
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10000), // 10s timeout
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error("Sentry API authentication failed");
      } else if (response.status === 404) {
        throw new Error(`Sentry project ${sentryOrg}/${sentryProject} not found`);
      }
      throw new Error(`Sentry API error: ${response.status} ${response.statusText}`);
    }

    const issues: SentryIssue[] = await response.json();
    return issues;
  } catch (error) {
    if (error instanceof Error) {
      console.error("[sentry-api] Failed to fetch recent errors:", error.message);
    } else {
      console.error("[sentry-api] Failed to fetch recent errors:", error);
    }
    return [];
  }
}

/**
 * Group issues by error patterns (title/culprit) to identify distinct problems
 * @param issues - Array of Sentry issues
 */
export function extractErrorPatterns(issues: SentryIssue[]): ErrorPattern[] {
  const patterns = new Map<string, ErrorPattern>();

  for (const issue of issues) {
    // Create pattern key from title + culprit (normalized)
    const pattern = normalizeErrorPattern(issue.title, issue.culprit);

    if (patterns.has(pattern)) {
      const existingPattern = patterns.get(pattern)!;
      existingPattern.count += parseInt(issue.count) || 1;
      existingPattern.issues.push(issue);
    } else {
      patterns.set(pattern, {
        pattern,
        count: parseInt(issue.count) || 1,
        issues: [issue],
        severity: calculateSeverity(issue),
      });
    }
  }

  // Sort by count (most frequent first)
  return Array.from(patterns.values()).sort((a, b) => b.count - a.count);
}

/**
 * Normalize error pattern for grouping
 */
function normalizeErrorPattern(title: string, culprit: string): string {
  // Remove dynamic parts like line numbers, timestamps, IDs
  const cleanTitle = title
    .replace(/:\d+:\d+/g, ':XX:XX') // line:column numbers
    .replace(/\b[0-9a-f]{8,}/gi, 'HASH') // hashes/IDs
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g, 'TIMESTAMP') // timestamps
    .replace(/\d+/g, 'N'); // other numbers

  const cleanCulprit = culprit
    .replace(/:\d+/g, ':XX') // line numbers
    .replace(/\?[^)]*\)/g, ')'); // query params in URLs

  return `${cleanTitle} | ${cleanCulprit}`;
}

/**
 * Calculate severity based on error characteristics
 */
function calculateSeverity(issue: SentryIssue): 'low' | 'medium' | 'high' {
  const count = parseInt(issue.count) || 0;

  if (issue.level === 'fatal' || issue.level === 'error') {
    if (count > 50) return 'high';
    if (count > 10) return 'medium';
  }

  if (issue.level === 'warning' && count > 100) {
    return 'medium';
  }

  return 'low';
}

/**
 * Check if error patterns indicate a surge that requires Healer dispatch
 * @param patterns - Error patterns from extractErrorPatterns
 * @param distinctThreshold - Minimum distinct patterns to trigger (default: 3)
 */
export function shouldDispatchHealer(patterns: ErrorPattern[], distinctThreshold: number = 3): boolean {
  const highSeverityPatterns = patterns.filter(p => p.severity === 'high');
  const mediumSeverityPatterns = patterns.filter(p => p.severity === 'medium');

  // High severity: dispatch if 2+ distinct patterns
  if (highSeverityPatterns.length >= 2) {
    return true;
  }

  // Medium severity: dispatch if 3+ distinct patterns (or threshold)
  if (mediumSeverityPatterns.length >= distinctThreshold) {
    return true;
  }

  // Overall: dispatch if total distinct patterns exceed threshold
  return patterns.length >= distinctThreshold;
}

/**
 * Create summary for Healer dispatch
 */
export function createErrorSummary(patterns: ErrorPattern[]): string {
  const topPatterns = patterns.slice(0, 5); // Top 5 most frequent

  const summary = [
    `Sentry error surge detected: ${patterns.length} distinct patterns`,
    "",
    ...topPatterns.map((p, i) =>
      `${i + 1}. ${p.pattern} (${p.count} occurrences, ${p.severity} severity)`
    )
  ];

  if (patterns.length > 5) {
    summary.push(`... and ${patterns.length - 5} more patterns`);
  }

  return summary.join('\n');
}