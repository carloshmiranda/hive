import { getDb } from "@/lib/db";

/**
 * Convergent Data Structures
 *
 * Handles concurrent writes from multiple agents without conflicts:
 * - Metrics: Use additive counters (increments rather than overwrites)
 * - Playbook: Use highest-confidence-wins (keep entry with higher confidence)
 */

// ============================================================================
// METRICS - Additive Counters
// ============================================================================

export interface MetricUpdate {
  company_id: string;
  date?: string; // ISO date string, defaults to today
  revenue?: number;
  mrr?: number;
  customers?: number;
  page_views?: number;
  signups?: number;
  churn_rate?: number;
  cac?: number;
  ad_spend?: number;
  emails_sent?: number;
  social_posts?: number;
  social_engagement?: number;
  waitlist_signups?: number;
  waitlist_total?: number;
  email_opens?: number;
  email_clicks?: number;
  email_bounces?: number;
  pricing_page_views?: number;
  pricing_cta_clicks?: number;
  affiliate_clicks?: number;
  affiliate_revenue?: number;
}

/**
 * Convergent metric update using additive counters.
 * Multiple agents can call this concurrently without conflicts.
 *
 * - Additive fields (revenue, customers, etc.): Values are added to existing values
 * - Rate fields (churn_rate, ctr, etc.): Values replace existing values
 * - Total fields (waitlist_total, mrr): Values replace existing values (latest wins)
 */
export async function updateMetrics(update: MetricUpdate): Promise<void> {
  const sql = getDb();
  const date = update.date || new Date().toISOString().split("T")[0];
  const { company_id } = update;

  // For simplicity and reliability, we'll execute separate queries for each type of field
  // This avoids complex dynamic SQL construction while maintaining atomicity per operation

  // Handle additive fields (increment existing values)
  if (update.revenue !== undefined) {
    await sql`
      INSERT INTO metrics (company_id, date, revenue)
      VALUES (${company_id}, ${date}, ${update.revenue})
      ON CONFLICT (company_id, date) DO UPDATE SET
        revenue = metrics.revenue + ${update.revenue}
    `;
  }

  if (update.customers !== undefined) {
    await sql`
      INSERT INTO metrics (company_id, date, customers)
      VALUES (${company_id}, ${date}, ${update.customers})
      ON CONFLICT (company_id, date) DO UPDATE SET
        customers = metrics.customers + ${update.customers}
    `;
  }

  if (update.page_views !== undefined) {
    await sql`
      INSERT INTO metrics (company_id, date, page_views)
      VALUES (${company_id}, ${date}, ${update.page_views})
      ON CONFLICT (company_id, date) DO UPDATE SET
        page_views = metrics.page_views + ${update.page_views}
    `;
  }

  if (update.signups !== undefined) {
    await sql`
      INSERT INTO metrics (company_id, date, signups)
      VALUES (${company_id}, ${date}, ${update.signups})
      ON CONFLICT (company_id, date) DO UPDATE SET
        signups = metrics.signups + ${update.signups}
    `;
  }

  if (update.emails_sent !== undefined) {
    await sql`
      INSERT INTO metrics (company_id, date, emails_sent)
      VALUES (${company_id}, ${date}, ${update.emails_sent})
      ON CONFLICT (company_id, date) DO UPDATE SET
        emails_sent = metrics.emails_sent + ${update.emails_sent}
    `;
  }

  if (update.social_posts !== undefined) {
    await sql`
      INSERT INTO metrics (company_id, date, social_posts)
      VALUES (${company_id}, ${date}, ${update.social_posts})
      ON CONFLICT (company_id, date) DO UPDATE SET
        social_posts = metrics.social_posts + ${update.social_posts}
    `;
  }

  if (update.social_engagement !== undefined) {
    await sql`
      INSERT INTO metrics (company_id, date, social_engagement)
      VALUES (${company_id}, ${date}, ${update.social_engagement})
      ON CONFLICT (company_id, date) DO UPDATE SET
        social_engagement = metrics.social_engagement + ${update.social_engagement}
    `;
  }

  if (update.waitlist_signups !== undefined) {
    await sql`
      INSERT INTO metrics (company_id, date, waitlist_signups)
      VALUES (${company_id}, ${date}, ${update.waitlist_signups})
      ON CONFLICT (company_id, date) DO UPDATE SET
        waitlist_signups = metrics.waitlist_signups + ${update.waitlist_signups}
    `;
  }

  if (update.email_opens !== undefined) {
    await sql`
      INSERT INTO metrics (company_id, date, email_opens)
      VALUES (${company_id}, ${date}, ${update.email_opens})
      ON CONFLICT (company_id, date) DO UPDATE SET
        email_opens = metrics.email_opens + ${update.email_opens}
    `;
  }

  if (update.email_clicks !== undefined) {
    await sql`
      INSERT INTO metrics (company_id, date, email_clicks)
      VALUES (${company_id}, ${date}, ${update.email_clicks})
      ON CONFLICT (company_id, date) DO UPDATE SET
        email_clicks = metrics.email_clicks + ${update.email_clicks}
    `;
  }

  if (update.email_bounces !== undefined) {
    await sql`
      INSERT INTO metrics (company_id, date, email_bounces)
      VALUES (${company_id}, ${date}, ${update.email_bounces})
      ON CONFLICT (company_id, date) DO UPDATE SET
        email_bounces = metrics.email_bounces + ${update.email_bounces}
    `;
  }

  if (update.pricing_page_views !== undefined) {
    await sql`
      INSERT INTO metrics (company_id, date, pricing_page_views)
      VALUES (${company_id}, ${date}, ${update.pricing_page_views})
      ON CONFLICT (company_id, date) DO UPDATE SET
        pricing_page_views = metrics.pricing_page_views + ${update.pricing_page_views}
    `;
  }

  if (update.pricing_cta_clicks !== undefined) {
    await sql`
      INSERT INTO metrics (company_id, date, pricing_cta_clicks)
      VALUES (${company_id}, ${date}, ${update.pricing_cta_clicks})
      ON CONFLICT (company_id, date) DO UPDATE SET
        pricing_cta_clicks = metrics.pricing_cta_clicks + ${update.pricing_cta_clicks}
    `;
  }

  if (update.affiliate_clicks !== undefined) {
    await sql`
      INSERT INTO metrics (company_id, date, affiliate_clicks)
      VALUES (${company_id}, ${date}, ${update.affiliate_clicks})
      ON CONFLICT (company_id, date) DO UPDATE SET
        affiliate_clicks = metrics.affiliate_clicks + ${update.affiliate_clicks}
    `;
  }

  if (update.affiliate_revenue !== undefined) {
    await sql`
      INSERT INTO metrics (company_id, date, affiliate_revenue)
      VALUES (${company_id}, ${date}, ${update.affiliate_revenue})
      ON CONFLICT (company_id, date) DO UPDATE SET
        affiliate_revenue = metrics.affiliate_revenue + ${update.affiliate_revenue}
    `;
  }

  // Handle replacement fields (latest value wins)
  if (update.mrr !== undefined) {
    await sql`
      INSERT INTO metrics (company_id, date, mrr)
      VALUES (${company_id}, ${date}, ${update.mrr})
      ON CONFLICT (company_id, date) DO UPDATE SET
        mrr = ${update.mrr}
    `;
  }

  if (update.churn_rate !== undefined) {
    await sql`
      INSERT INTO metrics (company_id, date, churn_rate)
      VALUES (${company_id}, ${date}, ${update.churn_rate})
      ON CONFLICT (company_id, date) DO UPDATE SET
        churn_rate = ${update.churn_rate}
    `;
  }

  if (update.cac !== undefined) {
    await sql`
      INSERT INTO metrics (company_id, date, cac)
      VALUES (${company_id}, ${date}, ${update.cac})
      ON CONFLICT (company_id, date) DO UPDATE SET
        cac = ${update.cac}
    `;
  }

  if (update.ad_spend !== undefined) {
    await sql`
      INSERT INTO metrics (company_id, date, ad_spend)
      VALUES (${company_id}, ${date}, ${update.ad_spend})
      ON CONFLICT (company_id, date) DO UPDATE SET
        ad_spend = ${update.ad_spend}
    `;
  }

  if (update.waitlist_total !== undefined) {
    await sql`
      INSERT INTO metrics (company_id, date, waitlist_total)
      VALUES (${company_id}, ${date}, ${update.waitlist_total})
      ON CONFLICT (company_id, date) DO UPDATE SET
        waitlist_total = ${update.waitlist_total}
    `;
  }
}

// ============================================================================
// PLAYBOOK - Highest Confidence Wins
// ============================================================================

export interface PlaybookEntry {
  source_company_id?: string | null;
  domain: string;
  insight: string;
  evidence?: Record<string, any> | null;
  confidence: number; // 0.0 to 1.0
  content_language?: string | null; // NULL = universal, 'en'/'pt' for language-specific
}

export interface PlaybookOutcome {
  success: boolean;
  timestamp: string;
  context?: Record<string, any>;
}

export interface PlaybookEntryFull extends PlaybookEntry {
  id?: string;
  success_rate?: number | null;
  usage_count?: number;
  outcome_history?: PlaybookOutcome[];
  last_outcome_at?: string | null;
  split_from?: string | null;
  variance_score?: number | null;
}

/**
 * Convergent playbook update with smart management features:
 * - Entries with >0.9 similarity: merge using weighted averages
 * - Entries with 0.8-0.9 similarity: highest-confidence-wins (legacy behavior)
 * - No similarity: create new entry
 */
export async function upsertPlaybookEntry(entry: PlaybookEntry): Promise<string> {
  const sql = getDb();

  // First, find existing entries with same domain
  const existingEntries = await sql`
    SELECT id, insight, confidence, superseded_by, success_rate, usage_count,
           outcome_history, applied_count, evidence
    FROM playbook
    WHERE domain = ${entry.domain}
    AND superseded_by IS NULL
  `;

  // Check for similar insights and determine best match
  let conflictingEntry = null;
  let maxSimilarity = 0;

  for (const existing of existingEntries) {
    const similarity = calculateTextSimilarity(entry.insight, existing.insight);
    if (similarity > maxSimilarity && similarity > 0.8) {
      maxSimilarity = similarity;
      conflictingEntry = existing;
    }
  }

  if (!conflictingEntry) {
    // No conflict, insert new entry
    const [newEntry] = await sql`
      INSERT INTO playbook (source_company_id, domain, insight, evidence, confidence, content_language)
      VALUES (${entry.source_company_id || null}, ${entry.domain}, ${entry.insight},
              ${entry.evidence ? JSON.stringify(entry.evidence) : null}, ${entry.confidence},
              ${entry.content_language || null})
      RETURNING id
    `;
    return newEntry.id;
  }

  // High similarity (>0.9) - merge using weighted averages
  if (maxSimilarity > 0.9) {
    return await mergePlaybookEntries(conflictingEntry, entry);
  }

  // Medium similarity (0.8-0.9) - apply highest-confidence-wins
  if (entry.confidence > conflictingEntry.confidence) {
    // New entry has higher confidence - supersede the old one
    const [newEntry] = await sql`
      INSERT INTO playbook (source_company_id, domain, insight, evidence, confidence, content_language)
      VALUES (${entry.source_company_id || null}, ${entry.domain}, ${entry.insight},
              ${entry.evidence ? JSON.stringify(entry.evidence) : null}, ${entry.confidence},
              ${entry.content_language || null})
      RETURNING id
    `;

    // Mark old entry as superseded
    await sql`
      UPDATE playbook
      SET superseded_by = ${newEntry.id}
      WHERE id = ${conflictingEntry.id}
    `;

    return newEntry.id;
  } else {
    // Existing entry has higher confidence - keep it, discard new one
    return conflictingEntry.id;
  }
}

/**
 * Simple text similarity based on word overlap.
 * Returns a value between 0 (no similarity) and 1 (identical).
 */
function calculateTextSimilarity(text1: string, text2: string): number {
  const normalize = (text: string) =>
    text.toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .split(/\s+/)
        .filter(word => word.length > 2);

  const words1 = normalize(text1);
  const words2 = normalize(text2);

  if (words1.length === 0 && words2.length === 0) return 1;
  if (words1.length === 0 || words2.length === 0) return 0;

  const set1 = new Set(words1);
  const set2 = new Set(words2);

  const intersection = new Set([...set1].filter(word => set2.has(word)));
  const union = new Set([...set1, ...set2]);

  return intersection.size / union.size;
}

/**
 * Merge two highly similar playbook entries using weighted averages.
 * The entry with higher usage gets more weight in the merge.
 */
async function mergePlaybookEntries(existing: any, newEntry: PlaybookEntry): Promise<string> {
  const sql = getDb();

  const existingWeight = Math.max(existing.usage_count || 1, 1);
  const newWeight = 1; // New entries start with weight 1
  const totalWeight = existingWeight + newWeight;

  // Weighted average confidence
  const mergedConfidence = (existing.confidence * existingWeight + newEntry.confidence * newWeight) / totalWeight;

  // Merge evidence
  const existingEvidence = existing.evidence || {};
  const newEvidence = newEntry.evidence || {};
  const mergedEvidence = { ...existingEvidence, ...newEvidence };

  // Take the longer/more detailed insight
  const mergedInsight = newEntry.insight.length > existing.insight.length ? newEntry.insight : existing.insight;

  // Update existing entry with merged data
  await sql`
    UPDATE playbook
    SET confidence = ${mergedConfidence},
        insight = ${mergedInsight},
        evidence = ${JSON.stringify(mergedEvidence)},
        applied_count = applied_count + 1
    WHERE id = ${existing.id}
  `;

  return existing.id;
}

/**
 * Record an outcome for a playbook entry and update success rate using exponential moving average.
 * Learning rate = 0.1 as specified in the requirements.
 */
export async function recordPlaybookOutcome(entryId: string, success: boolean, context?: Record<string, any>): Promise<void> {
  const sql = getDb();

  // Get current entry data
  const [entry] = await sql`
    SELECT success_rate, outcome_history, usage_count
    FROM playbook
    WHERE id = ${entryId}
  `;

  if (!entry) return;

  const learningRate = 0.1;
  const currentSuccessRate = entry.success_rate ?? 0.5; // Start with neutral 0.5 if no data

  // Update success rate using exponential moving average
  const newSuccessRate = currentSuccessRate * (1 - learningRate) + (success ? 1 : 0) * learningRate;

  // Update outcome history (keep last 20 outcomes for variance calculation)
  const outcomeHistory: PlaybookOutcome[] = entry.outcome_history || [];
  const newOutcome: PlaybookOutcome = {
    success,
    timestamp: new Date().toISOString(),
    context
  };

  outcomeHistory.push(newOutcome);
  if (outcomeHistory.length > 20) {
    outcomeHistory.shift(); // Remove oldest
  }

  // Calculate variance score
  const varianceScore = calculateVarianceScore(outcomeHistory);

  // Update the entry
  await sql`
    UPDATE playbook
    SET success_rate = ${newSuccessRate},
        usage_count = usage_count + 1,
        outcome_history = ${JSON.stringify(outcomeHistory)},
        last_outcome_at = NOW(),
        variance_score = ${varianceScore}
    WHERE id = ${entryId}
  `;

  // Check if entry should be split due to high variance
  if (varianceScore > 0.7 && outcomeHistory.length >= 10) {
    await considerSplittingEntry(entryId, outcomeHistory);
  }
}

/**
 * Calculate variance score from outcome history.
 * Returns 0 for consistent outcomes, 1 for highly variable outcomes.
 */
function calculateVarianceScore(outcomes: PlaybookOutcome[]): number {
  if (outcomes.length < 2) return 0;

  const successValues = outcomes.map(o => o.success ? 1 : 0);
  const mean = successValues.reduce((a: number, b: number) => a + b, 0) / successValues.length;
  const variance = successValues.reduce((sum: number, val: number) => sum + Math.pow(val - mean, 2), 0) / successValues.length;

  // Normalize variance to 0-1 scale (max variance for binary outcomes is 0.25)
  return Math.min(variance * 4, 1);
}

/**
 * Consider splitting an entry with high variance into domain-specific variants.
 * Analyzes context patterns to create specialized versions.
 */
async function considerSplittingEntry(entryId: string, outcomes: PlaybookOutcome[]): Promise<void> {
  const sql = getDb();

  // Get the original entry
  const [entry] = await sql`
    SELECT * FROM playbook WHERE id = ${entryId}
  `;

  if (!entry) return;

  // Analyze context patterns to identify split criteria
  const contextPatterns = analyzeContextPatterns(outcomes);

  if (contextPatterns.length >= 2) {
    // Create specialized variants for different contexts
    for (const pattern of contextPatterns) {
      if (pattern.count >= 3) { // Need at least 3 examples to create a variant
        const variantInsight = `${entry.insight} (${pattern.description})`;

        await sql`
          INSERT INTO playbook (
            source_company_id, domain, insight, evidence, confidence,
            content_language, success_rate, usage_count, split_from
          )
          VALUES (
            ${entry.source_company_id}, ${entry.domain}, ${variantInsight},
            ${entry.evidence}, ${pattern.successRate}, ${entry.content_language},
            ${pattern.successRate}, ${pattern.count}, ${entryId}
          )
        `;
      }
    }

    // Mark original entry as having been split
    await sql`
      UPDATE playbook
      SET superseded_by = 'split'
      WHERE id = ${entryId}
    `;
  }
}

/**
 * Analyze outcome context patterns to identify split criteria.
 */
function analyzeContextPatterns(outcomes: PlaybookOutcome[]): Array<{
  description: string;
  successRate: number;
  count: number;
}> {
  const patterns: Map<string, { successes: number; total: number }> = new Map();

  for (const outcome of outcomes) {
    if (outcome.context) {
      // Simple pattern detection - could be enhanced with ML
      const contextKey = Object.keys(outcome.context).sort().join(',');
      if (!patterns.has(contextKey)) {
        patterns.set(contextKey, { successes: 0, total: 0 });
      }

      const pattern = patterns.get(contextKey)!;
      pattern.total++;
      if (outcome.success) pattern.successes++;
    }
  }

  return Array.from(patterns.entries()).map(([key, data]) => ({
    description: key.replace(',', ' + '),
    successRate: data.successes / data.total,
    count: data.total
  }));
}

/**
 * Prune playbook entries when capacity is exceeded.
 * Uses scoring formula: successRate * log(usageCount + 1)
 */
export async function prunePlaybookEntries(maxEntries: number = 1000): Promise<number> {
  const sql = getDb();

  // Count current active entries
  const [{ count }] = await sql`
    SELECT COUNT(*) as count FROM playbook WHERE superseded_by IS NULL
  `;

  if (count <= maxEntries) return 0; // No pruning needed

  const entriesToRemove = count - maxEntries;

  // Find entries with lowest scores
  const lowScoreEntries = await sql`
    SELECT id, COALESCE(success_rate, 0.5) * ln(GREATEST(usage_count + 1, 1)) as score
    FROM playbook
    WHERE superseded_by IS NULL
    ORDER BY score ASC
    LIMIT ${entriesToRemove}
  `;

  // Mark entries as superseded (soft delete)
  const entryIds = lowScoreEntries.map(e => e.id);
  if (entryIds.length > 0) {
    await sql`
      UPDATE playbook
      SET superseded_by = 'pruned'
      WHERE id = ANY(${entryIds})
    `;
  }

  return entryIds.length;
}

// ============================================================================
// CONVENIENCE FUNCTIONS
// ============================================================================

/**
 * Increment a single metric field (most common use case)
 */
export async function incrementMetric(
  company_id: string,
  field: keyof Omit<MetricUpdate, 'company_id' | 'date'>,
  amount: number,
  date?: string
): Promise<void> {
  const update: MetricUpdate = { company_id, date };
  (update as any)[field] = amount;
  return updateMetrics(update);
}

/**
 * Quick playbook entry creation with validation
 */
export async function addPlaybookLearning(
  domain: string,
  insight: string,
  confidence: number = 0.5,
  source_company_id?: string,
  evidence?: Record<string, any>,
  content_language?: string | null
): Promise<string> {
  if (confidence < 0 || confidence > 1) {
    throw new Error("Confidence must be between 0 and 1");
  }
  if (!domain.trim() || !insight.trim()) {
    throw new Error("Domain and insight cannot be empty");
  }

  return upsertPlaybookEntry({
    source_company_id,
    domain: domain.trim(),
    insight: insight.trim(),
    evidence,
    confidence,
    content_language: content_language || null,
  });
}

/**
 * Mark playbook entry as used and optionally record outcome
 */
export async function markPlaybookEntryUsed(
  entryId: string,
  success?: boolean,
  context?: Record<string, any>
): Promise<void> {
  const sql = getDb();

  if (success !== undefined) {
    // Record outcome and update success rate
    await recordPlaybookOutcome(entryId, success, context);
  } else {
    // Just increment usage count and reference tracking
    await sql`
      UPDATE playbook
      SET usage_count = usage_count + 1,
          reference_count = reference_count + 1,
          last_referenced_at = NOW()
      WHERE id = ${entryId}
    `;
  }
}

/**
 * Get playbook entries ranked by effectiveness score
 */
export async function getEffectivePlaybookEntries(
  domain?: string,
  limit: number = 10
): Promise<any[]> {
  const sql = getDb();

  const entries = domain
    ? await sql`
        SELECT p.*, c.name as source_company,
               COALESCE(p.success_rate, 0.5) * ln(GREATEST(p.usage_count + 1, 1)) as effectiveness_score
        FROM playbook p
        LEFT JOIN companies c ON c.id = p.source_company_id
        WHERE p.domain = ${domain} AND p.superseded_by IS NULL
        ORDER BY effectiveness_score DESC
        LIMIT ${limit}
      `
    : await sql`
        SELECT p.*, c.name as source_company,
               COALESCE(p.success_rate, 0.5) * ln(GREATEST(p.usage_count + 1, 1)) as effectiveness_score
        FROM playbook p
        LEFT JOIN companies c ON c.id = p.source_company_id
        WHERE p.superseded_by IS NULL
        ORDER BY effectiveness_score DESC
        LIMIT ${limit}
      `;

  return entries;
}

/**
 * Get playbook statistics for monitoring
 */
export async function getPlaybookStats(): Promise<{
  total: number;
  avgSuccessRate: number;
  highVarianceEntries: number;
  splitEntries: number;
  prunedEntries: number;
}> {
  const sql = getDb();

  const [stats] = await sql`
    SELECT
      COUNT(*) FILTER (WHERE superseded_by IS NULL) as total,
      AVG(success_rate) FILTER (WHERE superseded_by IS NULL AND success_rate IS NOT NULL) as avg_success_rate,
      COUNT(*) FILTER (WHERE superseded_by IS NULL AND variance_score > 0.7) as high_variance_entries,
      COUNT(*) FILTER (WHERE split_from IS NOT NULL) as split_entries,
      COUNT(*) FILTER (WHERE superseded_by = 'pruned') as pruned_entries
    FROM playbook
  `;

  return {
    total: parseInt(stats.total) || 0,
    avgSuccessRate: parseFloat(stats.avg_success_rate) || 0,
    highVarianceEntries: parseInt(stats.high_variance_entries) || 0,
    splitEntries: parseInt(stats.split_entries) || 0,
    prunedEntries: parseInt(stats.pruned_entries) || 0,
  };
}