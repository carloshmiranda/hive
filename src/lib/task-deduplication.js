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

import { neon } from "@neondatabase/serverless";

const HIVE_URL = process.env.NEXT_PUBLIC_URL || "https://hive-phi.vercel.app";
const CRON_SECRET = process.env.CRON_SECRET || "";

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

// Jaccard similarity function (copied from sentinel-helpers)
function jaccardSimilarity(a, b) {
  const wordsA = new Set(
    a
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter(Boolean)
  );
  const wordsB = new Set(
    b
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter(Boolean)
  );
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  const union = new Set([...wordsA, ...wordsB]).size;
  return union === 0 ? 0 : intersection / union;
}

// Extract domain from task description
function extractDomain(description) {
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
export function isCrossCompanyPattern(description) {
  return CROSS_COMPANY_PATTERNS.some(pattern => pattern.test(description));
}

// Check for existing playbook entries that match a task pattern
export async function findMatchingPlaybookEntry(sql, description, domain) {
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
export async function createPlaybookEntry(sql, domain, insight, evidence = {}, companyCount) {
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

    // Invalidate playbook cache
    try {
      await fetch(`${HIVE_URL}/api/playbook`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${CRON_SECRET}` }
      }).catch(() => {});
    } catch {}

    console.log(`[task-dedup] Created playbook entry for ${domain}: ${insight} (${companyCount} companies)`);
    return entry.id;
  } catch (error) {
    console.error('[task-dedup] Failed to create playbook entry:', error);
    return null;
  }
}

// Update playbook entry usage statistics
export async function incrementPlaybookUsage(sql, playbookId) {
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

// Helper to extract company list from task description
export function extractAffectedCompanies(description) {
  // Look for patterns like "for senhorio:", "company: verdegsk", etc.
  const companyMatches = description.match(/(?:for|company:?)\s+(\w+)/gi) || [];
  return companyMatches.map(match =>
    match.replace(/(?:for|company:?)\s+/i, '').toLowerCase()
  );
}

// Main function: process potential cross-company task and deduplicate
export async function deduplicateTask(sql, title, description, affectedCompanies = []) {
  // Extract companies from description if not provided
  if (affectedCompanies.length === 0) {
    affectedCompanies = extractAffectedCompanies(description);
  }

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
  const existingEntry = await findMatchingPlaybookEntry(sql, description, domain);

  if (existingEntry) {
    // Reference existing playbook entry
    await incrementPlaybookUsage(sql, existingEntry.id);

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
      sql,
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