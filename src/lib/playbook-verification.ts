import { getDb } from "@/lib/db";

export interface PlaybookEntry {
  id: string;
  domain: string;
  insight: string;
  confidence: number;
  reference_count: number;
}

export interface PlaybookUsageResult {
  hit_count: number;
  miss_count: number;
  insights_referenced: string[];
  total_playbook_entries: number;
  verification_score: number; // 0.0-1.0 based on hits vs available entries
}

/**
 * Verify if agent output references provided playbook insights
 * Uses fuzzy matching to detect when agents apply available knowledge
 */
export async function verifyPlaybookUsage(
  agentOutput: string,
  playbookEntries: PlaybookEntry[]
): Promise<PlaybookUsageResult> {
  if (!agentOutput || !playbookEntries.length) {
    return {
      hit_count: 0,
      miss_count: 0,
      insights_referenced: [],
      total_playbook_entries: playbookEntries.length,
      verification_score: playbookEntries.length === 0 ? 1.0 : 0.0
    };
  }

  const referencedInsights: string[] = [];
  const outputLower = agentOutput.toLowerCase();

  for (const entry of playbookEntries) {
    const isReferenced = checkInsightReference(outputLower, entry);
    if (isReferenced) {
      referencedInsights.push(entry.insight);

      // Update reference tracking in database
      await updatePlaybookReference(entry.id);
    }
  }

  const hitCount = referencedInsights.length;
  const missCount = playbookEntries.length - hitCount;
  const verificationScore = playbookEntries.length > 0 ? hitCount / playbookEntries.length : 1.0;

  return {
    hit_count: hitCount,
    miss_count: missCount,
    insights_referenced: referencedInsights,
    total_playbook_entries: playbookEntries.length,
    verification_score: Math.round(verificationScore * 1000) / 1000 // Round to 3 decimals
  };
}

/**
 * Check if agent output references a specific playbook insight
 * Uses multiple fuzzy matching strategies to avoid false negatives
 */
function checkInsightReference(outputLower: string, entry: PlaybookEntry): boolean {
  const insight = entry.insight.toLowerCase();
  const domain = entry.domain.toLowerCase();

  // Strategy 1: Direct substring match (high confidence)
  if (outputLower.includes(insight.slice(0, Math.min(50, insight.length)))) {
    return true;
  }

  // Strategy 2: Key phrase extraction and matching
  const keyPhrases = extractKeyPhrases(insight);
  const matchedPhrases = keyPhrases.filter(phrase =>
    outputLower.includes(phrase) && phrase.length >= 4
  );

  // Require at least 2 key phrases or 1 highly specific phrase (>15 chars)
  if (matchedPhrases.length >= 2 ||
      (matchedPhrases.length === 1 && matchedPhrases[0].length > 15)) {
    return true;
  }

  // Strategy 3: Domain-specific keyword matching
  const domainKeywords = getDomainKeywords(domain);
  const insightKeywords = extractKeywords(insight);

  const matchedKeywords = insightKeywords.filter(keyword => {
    if (keyword.length < 4) return false;
    return outputLower.includes(keyword);
  });

  // If we're in the right domain context and match specific keywords
  if (domainKeywords.some(dk => outputLower.includes(dk)) &&
      matchedKeywords.length >= 1) {
    return true;
  }

  return false;
}

/**
 * Extract key phrases from insight text (noun phrases, important concepts)
 */
function extractKeyPhrases(text: string): string[] {
  const phrases: string[] = [];

  // Remove common filler words and split by punctuation
  const cleaned = text.toLowerCase()
    .replace(/\b(the|a|an|and|or|but|in|on|at|to|for|of|with|by)\b/g, ' ')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Extract 2-4 word phrases
  const words = cleaned.split(' ').filter(w => w.length > 2);

  for (let i = 0; i < words.length - 1; i++) {
    // 2-word phrases
    if (i < words.length - 1) {
      phrases.push(words[i] + ' ' + words[i + 1]);
    }
    // 3-word phrases
    if (i < words.length - 2) {
      phrases.push(words[i] + ' ' + words[i + 1] + ' ' + words[i + 2]);
    }
  }

  return phrases;
}

/**
 * Extract important keywords from text
 */
function extractKeywords(text: string): string[] {
  return text.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length >= 4)
    .filter(word => !isCommonWord(word));
}

/**
 * Check if word is too common to be meaningful for matching
 */
function isCommonWord(word: string): boolean {
  const commonWords = new Set([
    'that', 'with', 'have', 'this', 'will', 'your', 'from', 'they', 'know',
    'want', 'been', 'good', 'much', 'some', 'time', 'very', 'when', 'come',
    'here', 'just', 'like', 'long', 'make', 'many', 'over', 'such', 'take',
    'than', 'them', 'well', 'were', 'able', 'about', 'after', 'again',
    'before', 'being', 'between', 'during', 'should', 'through', 'under',
    'until', 'while', 'would', 'could', 'might', 'shall', 'must'
  ]);
  return commonWords.has(word);
}

/**
 * Get domain-specific keywords that indicate context
 */
function getDomainKeywords(domain: string): string[] {
  const domainMap: Record<string, string[]> = {
    'email_marketing': ['email', 'subject', 'campaign', 'newsletter', 'automation'],
    'seo': ['search', 'keywords', 'ranking', 'google', 'organic', 'content'],
    'pricing': ['price', 'pricing', 'cost', 'subscription', 'plan', 'tier'],
    'onboarding': ['onboard', 'signup', 'welcome', 'tutorial', 'setup'],
    'growth': ['growth', 'acquisition', 'conversion', 'funnel', 'retention'],
    'content': ['blog', 'article', 'content', 'post', 'writing'],
    'social': ['social', 'twitter', 'linkedin', 'instagram', 'engagement'],
    'engineering': ['code', 'deploy', 'build', 'api', 'database', 'bug'],
    'infrastructure': ['server', 'hosting', 'cdn', 'performance', 'scale'],
    'auth': ['login', 'authentication', 'password', 'oauth', 'session'],
    'payments': ['payment', 'stripe', 'checkout', 'billing', 'invoice']
  };

  return domainMap[domain] || [];
}

/**
 * Update playbook entry reference tracking in database
 */
async function updatePlaybookReference(entryId: string): Promise<void> {
  const sql = getDb();

  try {
    await sql`
      UPDATE playbook
      SET reference_count = COALESCE(reference_count, 0) + 1,
          last_referenced_at = NOW()
      WHERE id = ${entryId}
    `;
  } catch (error) {
    console.error('Failed to update playbook reference:', error);
    // Don't throw - this is tracking, not critical functionality
  }
}

/**
 * Get playbook entries relevant to a specific agent
 * Filters by agent type and content language
 */
export async function getRelevantPlaybookEntries(
  companyId: string,
  agentType: string,
  contentLanguage: string = 'en',
  limit: number = 10
): Promise<PlaybookEntry[]> {
  const sql = getDb();

  try {
    const entries = await sql`
      SELECT id, domain, insight, confidence, COALESCE(reference_count, 0) as reference_count
      FROM playbook
      WHERE superseded_by IS NULL
        AND confidence >= 0.6
        AND (content_language IS NULL OR content_language = ${contentLanguage})
        AND (
          relevant_agents = '{}'
          OR ${agentType} = ANY(relevant_agents)
          OR CASE
            WHEN ${agentType} = 'growth' THEN domain IN ('email_marketing', 'seo', 'content', 'social', 'growth')
            WHEN ${agentType} = 'engineer' THEN domain IN ('engineering', 'infrastructure', 'auth', 'payments', 'deployment')
            WHEN ${agentType} = 'ceo' THEN domain IN ('pricing', 'strategy', 'growth', 'onboarding')
            ELSE true
          END
        )
      ORDER BY confidence DESC, reference_count ASC
      LIMIT ${limit}
    `;

    return entries as PlaybookEntry[];
  } catch (error) {
    console.error('Failed to fetch relevant playbook entries:', error);
    return [];
  }
}