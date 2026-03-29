import { getDb } from "@/lib/db";
import { invalidateCompanyMetrics } from "@/lib/redis-cache";
import { generatePlaybookEmbedding } from "@/lib/embeddings";

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

  // Invalidate metrics cache for this company
  try {
    const company = await sql`SELECT slug FROM companies WHERE id = ${company_id} LIMIT 1`;
    if (company.length > 0) {
      await invalidateCompanyMetrics(company[0].slug);
      await invalidateCompanyMetrics(`${company[0].slug}:growth`); // Invalidate growth cache too
    }
  } catch (err) {
    // Cache invalidation failure should not break the metrics update
    console.warn(`Failed to invalidate metrics cache for company ${company_id}:`, err);
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

/**
 * Convergent playbook update using highest-confidence-wins.
 * If an entry with the same domain + insight exists, keeps the one with higher confidence.
 *
 * Similarity matching: Two entries are considered the same if:
 * - Same domain AND
 * - Insight text similarity > 0.8 (using simple word overlap)
 */
export async function upsertPlaybookEntry(entry: PlaybookEntry): Promise<string> {
  const sql = getDb();

  // Normalize domain to prevent fragmentation (e.g. ops → operations)
  const { normalizePlaybookDomain } = await import("@/lib/playbook-domains");
  entry = { ...entry, domain: normalizePlaybookDomain(entry.domain) };

  // First, find existing entries with same domain
  const existingEntries = await sql`
    SELECT id, insight, confidence, superseded_by
    FROM playbook
    WHERE domain = ${entry.domain}
    AND superseded_by IS NULL
  `;

  // Check for similar insights (simple word-based similarity)
  let conflictingEntry = null;
  for (const existing of existingEntries) {
    const similarity = calculateTextSimilarity(entry.insight, existing.insight);
    if (similarity > 0.8) {
      conflictingEntry = existing;
      break;
    }
  }

  if (!conflictingEntry) {
    // No conflict, insert new entry
    let embedding = null;
    try {
      const embeddingArray = await generatePlaybookEmbedding(
        entry.insight,
        entry.domain,
        entry.evidence
      );
      embedding = `[${embeddingArray.join(',')}]`;
    } catch (error) {
      console.warn("Failed to generate embedding for playbook entry:", error);
      // Continue without embedding - can be generated later
    }

    const [newEntry] = await sql`
      INSERT INTO playbook (source_company_id, domain, insight, evidence, confidence, content_language, embedding)
      VALUES (${entry.source_company_id || null}, ${entry.domain}, ${entry.insight},
              ${entry.evidence ? JSON.stringify(entry.evidence) : null}, ${entry.confidence},
              ${entry.content_language || null}, ${embedding ? `${embedding}::vector` : null})
      RETURNING id
    `;
    return newEntry.id;
  }

  // Found conflicting entry - apply highest-confidence-wins
  if (entry.confidence > conflictingEntry.confidence) {
    // New entry has higher confidence - supersede the old one
    let embedding = null;
    try {
      const embeddingArray = await generatePlaybookEmbedding(
        entry.insight,
        entry.domain,
        entry.evidence
      );
      embedding = `[${embeddingArray.join(',')}]`;
    } catch (error) {
      console.warn("Failed to generate embedding for playbook entry:", error);
      // Continue without embedding - can be generated later
    }

    const [newEntry] = await sql`
      INSERT INTO playbook (source_company_id, domain, insight, evidence, confidence, content_language, embedding)
      VALUES (${entry.source_company_id || null}, ${entry.domain}, ${entry.insight},
              ${entry.evidence ? JSON.stringify(entry.evidence) : null}, ${entry.confidence},
              ${entry.content_language || null}, ${embedding ? `${embedding}::vector` : null})
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