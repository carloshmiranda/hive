/**
 * Cross-company task consolidation endpoint
 *
 * Used by Sentinel to detect and create consolidated tasks for issues
 * that affect multiple companies. Integrates with the playbook system
 * to reduce duplicate work and share solutions.
 */

import { NextRequest } from "next/server";
import { getDb, json, err } from "@/lib/db";
import { verifyCronAuth } from "@/lib/qstash";
// Pattern detection for cross-company issues
const CROSS_COMPANY_PATTERNS = [
  /fix.*\/api\/\w+.*endpoint/i,
  /\w+.*endpoint.*broken/i,
  /stats.*not.*working/i,
  /metrics.*collection.*failed/i,
  /health.*check.*failing/i,
  /deploy.*verification.*missing/i,
  /email.*delivery.*failing/i,
  /payment.*webhook.*broken/i,
  /auth.*middleware.*issue/i,
  /database.*connection.*error/i,
];

function isCrossCompanyPattern(description: string): boolean {
  return CROSS_COMPANY_PATTERNS.some(pattern => pattern.test(description));
}

function extractAffectedCompanies(description: string): string[] {
  const companyMatches = description.match(/(?:for|company:?)\s+(\w+)/gi) || [];
  return companyMatches.map(match =>
    match.replace(/(?:for|company:?)\s+/i, '').toLowerCase()
  );
}

// Local implementation of cross-company detection
async function detectCrossCompanyIssues(): Promise<Array<{
  pattern: string;
  companies: string[];
  description: string;
}>> {
  const sql = getDb();

  try {
    const recentTasks = await sql`
      SELECT title, description, created_at
      FROM hive_backlog
      WHERE created_at > NOW() - INTERVAL '24 hours'
      AND status IN ('ready', 'approved', 'dispatched')
      AND category = 'bugfix'
      ORDER BY created_at DESC
    `;

    const patterns = new Map<string, { companies: Set<string>, description: string }>();

    for (const task of recentTasks) {
      if (!isCrossCompanyPattern(task.description)) continue;

      const companies = extractAffectedCompanies(task.description);
      if (companies.length === 0) continue;

      const normalizedTitle = task.title
        .replace(/for \w+/gi, '')
        .replace(/in \w+/gi, '')
        .replace(/\w+:/gi, '')
        .trim();

      if (!patterns.has(normalizedTitle)) {
        patterns.set(normalizedTitle, {
          companies: new Set(companies),
          description: task.description
        });
      } else {
        const existing = patterns.get(normalizedTitle)!;
        companies.forEach(c => existing.companies.add(c));
      }
    }

    return Array.from(patterns.entries())
      .filter(([_, data]) => data.companies.size >= 2)
      .map(([pattern, data]) => ({
        pattern,
        companies: Array.from(data.companies),
        description: data.description
      }));
  } catch (error) {
    console.warn('[cross-company] Failed to detect cross-company issues:', error);
    return [];
  }
}
import { setSentryTags } from "@/lib/sentry-tags";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

interface CrossCompanyIssue {
  pattern: string;
  description: string;
  companies: string[];
  severity: 'critical' | 'high' | 'medium';
  domain: string;
}

// Detect common infrastructure issues across companies
async function detectInfrastructureIssues(): Promise<CrossCompanyIssue[]> {
  const sql = getDb();
  const issues: CrossCompanyIssue[] = [];

  try {
    // Check for broken metrics endpoints across companies
    const metricsIssues = await sql`
      SELECT c.slug, c.github_repo
      FROM companies c
      WHERE c.status IN ('mvp', 'active')
      AND c.github_repo IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM metrics m
        WHERE m.company_id = c.id
        AND m.date >= CURRENT_DATE - INTERVAL '2 days'
      )
    `;

    if (metricsIssues.length >= 2) {
      issues.push({
        pattern: "Fix /api/stats endpoint",
        description: "Metrics collection endpoints are failing across multiple companies. No data recorded in the last 2 days.",
        companies: metricsIssues.map((c: any) => c.slug),
        severity: 'high',
        domain: 'metrics_collection'
      });
    }

    // Check for failed deployments
    const deploymentIssues = await sql`
      SELECT c.slug, COUNT(aa.id) as failed_deploys
      FROM companies c
      JOIN agent_actions aa ON aa.company_id = c.id
      WHERE c.status IN ('mvp', 'active')
      AND c.github_repo IS NOT NULL
      AND aa.agent = 'engineer'
      AND aa.action_type = 'deploy'
      AND aa.status = 'failed'
      AND aa.finished_at > NOW() - INTERVAL '24 hours'
      GROUP BY c.id, c.slug
      HAVING COUNT(aa.id) >= 2
    `;

    if (deploymentIssues.length >= 2) {
      issues.push({
        pattern: "Fix deployment pipeline",
        description: "Multiple companies experiencing deployment failures in the last 24 hours.",
        companies: deploymentIssues.map((c: any) => c.slug),
        severity: 'critical',
        domain: 'deployment'
      });
    }

    // Check for authentication issues
    const authIssues = await sql`
      SELECT c.slug
      FROM companies c
      JOIN agent_actions aa ON aa.company_id = c.id
      WHERE c.status IN ('mvp', 'active')
      AND c.github_repo IS NOT NULL
      AND aa.agent IN ('engineer', 'ops')
      AND aa.error IS NOT NULL
      AND (aa.error ILIKE '%auth%' OR aa.error ILIKE '%token%' OR aa.error ILIKE '%credential%')
      AND aa.finished_at > NOW() - INTERVAL '12 hours'
      GROUP BY c.id, c.slug
    `;

    if (authIssues.length >= 2) {
      issues.push({
        pattern: "Fix authentication/credential issues",
        description: "Multiple companies experiencing authentication-related errors.",
        companies: authIssues.map((c: any) => c.slug),
        severity: 'high',
        domain: 'authentication'
      });
    }

    // Check for health check failures
    const healthIssues = await sql`
      SELECT c.slug
      FROM companies c
      WHERE c.status IN ('mvp', 'active')
      AND c.github_repo IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM agent_actions aa
        WHERE aa.company_id = c.id
        AND aa.agent = 'ops'
        AND aa.action_type = 'health_check'
        AND aa.status = 'success'
        AND aa.finished_at > NOW() - INTERVAL '24 hours'
      )
    `;

    if (healthIssues.length >= 3) {
      issues.push({
        pattern: "Fix health monitoring",
        description: "Multiple companies missing successful health checks in the last 24 hours.",
        companies: healthIssues.map((c: any) => c.slug),
        severity: 'medium',
        domain: 'health_monitoring'
      });
    }

    return issues;
  } catch (error) {
    console.error('[cross-company] Failed to detect infrastructure issues:', error);
    return [];
  }
}

// Create consolidated tasks via the Hive API
async function createConsolidatedTask(issue: CrossCompanyIssue): Promise<any> {
  const HIVE_URL = process.env.NEXT_PUBLIC_URL || "https://hive-phi.vercel.app";
  const cronSecret = process.env.CRON_SECRET || "";

  try {
    const response = await fetch(`${HIVE_URL}/api/agents/tools`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cronSecret}`
      },
      body: JSON.stringify({
        agent: 'sentinel',
        tool: 'hive_cross_company_tasks',
        arguments: {
          pattern: issue.pattern,
          companies: issue.companies,
          description: issue.description,
          evidence: {
            severity: issue.severity,
            domain: issue.domain,
            detected_at: new Date().toISOString()
          }
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to create task: ${response.status}`);
    }

    const result = await response.json();
    return result.data;
  } catch (error) {
    console.error('[cross-company] Failed to create consolidated task:', error);
    return null;
  }
}

export async function POST(request: NextRequest) {
  setSentryTags({
    action_type: "cross_company_detection",
    route: "/api/agents/cross-company-tasks",
    agent: "sentinel"
  });

  const auth = await verifyCronAuth(request);
  if (!auth.authorized) {
    return err(auth.error, 401);
  }

  try {
    console.log('[cross-company] Detecting cross-company issues...');

    // Detect infrastructure issues
    const infrastructureIssues = await detectInfrastructureIssues();

    // Also check for patterns in recent backlog tasks
    const recentPatterns = await detectCrossCompanyIssues();

    const allIssues = [
      ...infrastructureIssues,
      ...recentPatterns.map(p => ({
        pattern: p.pattern,
        description: p.description,
        companies: p.companies,
        severity: 'medium' as const,
        domain: 'infrastructure'
      }))
    ];

    console.log(`[cross-company] Found ${allIssues.length} cross-company issues`);

    const results = [];
    for (const issue of allIssues) {
      if (issue.companies.length >= 2) {
        console.log(`[cross-company] Creating consolidated task: "${issue.pattern}" (${issue.companies.length} companies)`);

        const task = await createConsolidatedTask(issue);
        if (task) {
          results.push({
            issue: issue.pattern,
            companies: issue.companies,
            task_created: task.main_task?.id || task.id,
            playbook_referenced: !!task.playbook_reference
          });
        }
      }
    }

    return json({
      detected_issues: allIssues.length,
      consolidated_tasks_created: results.length,
      results
    });
  } catch (error) {
    console.error('[cross-company] Detection failed:', error);
    return err(`Cross-company detection failed: ${error}`, 500);
  }
}

// GET endpoint for manual testing
export async function GET(request: NextRequest) {
  setSentryTags({
    action_type: "cross_company_detection_test",
    route: "/api/agents/cross-company-tasks",
    agent: "manual"
  });

  try {
    const issues = await detectInfrastructureIssues();
    const recentPatterns = await detectCrossCompanyIssues();

    return json({
      infrastructure_issues: issues,
      recent_patterns: recentPatterns,
      total_patterns: issues.length + recentPatterns.length
    });
  } catch (error) {
    console.error('[cross-company] Detection test failed:', error);
    return err(`Detection failed: ${error}`, 500);
  }
}