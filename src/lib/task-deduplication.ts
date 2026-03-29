/**
 * Cross-company task deduplication via playbook
 *
 * When Sentinel identifies identical patterns across multiple companies
 * (e.g., "Fix /api/stats endpoint" for each), this module:
 * 1. Checks playbook for existing patterns
 * 2. Creates playbook entries for new patterns
 * 3. Creates company-specific tasks that reference playbook entries
 *
 * This reduces duplicate work at scale by centralizing solutions
 * and ensuring companies can learn from each other's fixes.
 */

import { getDb } from "@/lib/db";
import { jaccardSimilarity } from "@/lib/sentinel-helpers";
import { invalidatePlaybook } from "@/lib/redis-cache";

// Threshold for considering tasks similar enough to deduplicate
const SIMILARITY_THRESHOLD = 0.7;

// Common patterns that indicate cross-company issues
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

// Extract domain from task description
function extractDomain(description: string): string {
  const text = description.toLowerCase();

  if (text.includes('stats') || text.includes('metrics')) return 'metrics_collection';
  if (text.includes('health') || text.includes('monitoring')) return 'health_monitoring';
  if (text.includes('deploy') || text.includes('deployment')) return 'deployment';
  if (text.includes('email') || text.includes('resend')) return 'email_delivery';
  if (text.includes('payment') || text.includes('stripe')) return 'payments';
  if (text.includes('auth') || text.includes('login')) return 'authentication';
  if (text.includes('database') || text.includes('neon')) return 'database';
  if (text.includes('api') && text.includes('endpoint')) return 'api_endpoints';

  return 'infrastructure';
}

// Check if a task pattern is cross-company (affects multiple companies)
export function isCrossCompanyPattern(description: string): boolean {
  return CROSS_COMPANY_PATTERNS.some(pattern => pattern.test(description));
}

// Interface for task creation with playbook support
export interface TaskWithPlaybook {
  title: string;
  description: string;
  category: string;
  priority: string;
  companies: string[]; // Company slugs this task affects
  playbookReference?: {
    id: string;
    domain: string;
    insight: string;
  };
}

// Check for existing playbook entries that match a task pattern
export async function findMatchingPlaybookEntry(
  description: string,
  domain: string
): Promise<any | null> {
  const sql = getDb();

  try {
    // Get playbook entries for this domain
    const entries = await sql`
      SELECT id, domain, insight, evidence, confidence, applied_count
      FROM playbook
      WHERE domain = ${domain}
      AND superseded_by IS NULL
      ORDER BY confidence DESC, applied_count DESC
    `;

    // Find the most similar entry using text similarity
    let bestMatch = null;
    let bestSimilarity = 0;

    for (const entry of entries) {
      const similarity = jaccardSimilarity(description, entry.insight);
      if (similarity > bestSimilarity && similarity >= SIMILARITY_THRESHOLD) {
        bestMatch = entry;
        bestSimilarity = similarity;
      }
    }

    return bestMatch;
  } catch (error) {
    console.warn('[task-dedup] Failed to find matching playbook entry:', error);
    return null;
  }
}

// Create a new playbook entry for a cross-company pattern
export async function createPlaybookEntry(
  domain: string,
  insight: string,
  evidence: any = {},
  companyCount: number
): Promise<string | null> {
  const sql = getDb();

  try {
    // Calculate confidence based on number of affected companies
    // More companies = higher confidence this is a real pattern
    const confidence = Math.min(0.3 + (companyCount * 0.2), 1.0);

    const [entry] = await sql`
      INSERT INTO playbook (
        source_company_id,
        domain,
        insight,
        evidence,
        confidence,
        relevant_agents
      )
      VALUES (
        NULL, -- Cross-company entries don't have a single source
        ${domain},
        ${insight},
        ${JSON.stringify({
          affected_companies: companyCount,
          pattern_detected_by: 'sentinel',
          created_via: 'task_deduplication',
          ...evidence
        })},
        ${confidence},
        ${['engineer', 'ops']} -- Usually infrastructure issues
      )
      RETURNING id
    `;

    await invalidatePlaybook();

    console.log(`[task-dedup] Created playbook entry for ${domain}: ${insight} (${companyCount} companies)`);
    return entry.id;
  } catch (error) {
    console.error('[task-dedup] Failed to create playbook entry:', error);
    return null;
  }
}

// Update playbook entry usage statistics
export async function incrementPlaybookUsage(playbookId: string): Promise<void> {
  const sql = getDb();

  try {
    await sql`
      UPDATE playbook
      SET
        applied_count = applied_count + 1,
        last_referenced_at = NOW(),
        reference_count = reference_count + 1
      WHERE id = ${playbookId}
    `;
  } catch (error) {
    console.warn('[task-dedup] Failed to increment playbook usage:', error);
  }
}

// Main function: process potential cross-company task and deduplicate
export async function deduplicateTask(
  title: string,
  description: string,
  affectedCompanies: string[]
): Promise<TaskWithPlaybook> {
  // Only deduplicate if it affects multiple companies and matches a pattern
  if (affectedCompanies.length < 2 || !isCrossCompanyPattern(description)) {
    return {
      title,
      description,
      category: 'bugfix',
      priority: 'P1',
      companies: affectedCompanies
    };
  }

  const domain = extractDomain(description);

  // Check for existing playbook entry
  const existingEntry = await findMatchingPlaybookEntry(description, domain);

  if (existingEntry) {
    // Reference existing playbook entry
    await incrementPlaybookUsage(existingEntry.id);

    return {
      title: `${title} (see playbook #${existingEntry.id.slice(-8)})`,
      description: `${description}\n\n📚 **Playbook Reference**: ${existingEntry.insight}\n\nThis issue follows a known pattern. See playbook entry #${existingEntry.id} for proven solutions and context from previous fixes.`,
      category: 'bugfix',
      priority: 'P1',
      companies: affectedCompanies,
      playbookReference: {
        id: existingEntry.id,
        domain: existingEntry.domain,
        insight: existingEntry.insight
      }
    };
  } else {
    // Create new playbook entry for this pattern
    const genericInsight = `Common infrastructure issue: ${title.replace(/for \w+/gi, 'across companies')}`;
    const playbookId = await createPlaybookEntry(
      domain,
      genericInsight,
      {
        example_description: description,
        pattern: title
      },
      affectedCompanies.length
    );

    return {
      title: `${title}${playbookId ? ` (new pattern #${playbookId.slice(-8)})` : ''}`,
      description: `${description}\n\n📚 **New Pattern Detected**: This appears to be a cross-company infrastructure issue affecting ${affectedCompanies.length} companies. ${playbookId ? `A playbook entry (#${playbookId}) has been created to track solutions for this pattern.` : 'Consider documenting the solution in the playbook once resolved.'}`,
      category: 'bugfix',
      priority: 'P1',
      companies: affectedCompanies,
      playbookReference: playbookId ? {
        id: playbookId,
        domain,
        insight: genericInsight
      } : undefined
    };
  }
}

// Helper to extract company list from task description
export function extractAffectedCompanies(description: string): string[] {
  // Look for patterns like "for senhorio:", "company: verdegsk", etc.
  const companyMatches = description.match(/(?:for|company:?)\s+(\w+)/gi) || [];
  return companyMatches.map(match =>
    match.replace(/(?:for|company:?)\s+/i, '').toLowerCase()
  );
}

// Check if multiple companies have the same issue by analyzing recent tasks
export async function detectCrossCompanyIssues(): Promise<Array<{
  pattern: string;
  companies: string[];
  description: string;
}>> {
  const sql = getDb();

  try {
    // Find recent tasks that might be duplicated across companies
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

      // Normalize the title to detect patterns (remove company-specific parts)
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

    // Return patterns that affect multiple companies
    return Array.from(patterns.entries())
      .filter(([_, data]) => data.companies.size >= 2)
      .map(([pattern, data]) => ({
        pattern,
        companies: Array.from(data.companies),
        description: data.description
      }));
  } catch (error) {
    console.warn('[task-dedup] Failed to detect cross-company issues:', error);
    return [];
  }
}

// Placeholder for route.ts until proper import structure is resolved
async function detectCrossCompanyIssuesStub(): Promise<Array<{
  pattern: string;
  companies: string[];
  description: string;
}>> {
  // This is a stub - the actual implementation is in detectCrossCompanyIssues above
  // but due to module import issues between .ts and .js files in this context,
  // we'll implement this directly in the route handler
  return [];
}