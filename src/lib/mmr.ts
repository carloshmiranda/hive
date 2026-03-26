/**
 * Maximal Marginal Relevance (MMR) implementation for playbook entry selection
 * Balances relevance with diversity to prevent similar entries from crowding out varied insights
 */

export interface PlaybookEntry {
  domain: string;
  insight: string;
  confidence: number;
}

export interface MMREntry extends PlaybookEntry {
  relevance: number;
  id: string;
}

/**
 * Calculate cosine similarity between two text strings using simple word overlap
 * For production, this could be enhanced with embeddings or TF-IDF
 */
function calculateSimilarity(text1: string, text2: string): number {
  const words1 = new Set(text1.toLowerCase().split(/\s+/).filter(w => w.length > 2));
  const words2 = new Set(text2.toLowerCase().split(/\s+/).filter(w => w.length > 2));

  const intersection = new Set([...words1].filter(w => words2.has(w)));
  const union = new Set([...words1, ...words2]);

  if (union.size === 0) return 0;
  return intersection.size / union.size;
}

/**
 * Calculate diversity of a candidate entry from already selected entries
 * Returns 1 - max_similarity_to_selected
 */
function calculateDiversity(candidate: MMREntry, selected: MMREntry[]): number {
  if (selected.length === 0) return 1.0;

  const candidateText = `${candidate.domain} ${candidate.insight}`;
  let maxSimilarity = 0;

  for (const selectedEntry of selected) {
    const selectedText = `${selectedEntry.domain} ${selectedEntry.insight}`;
    const similarity = calculateSimilarity(candidateText, selectedText);
    maxSimilarity = Math.max(maxSimilarity, similarity);
  }

  return 1 - maxSimilarity;
}

/**
 * Apply Maximal Marginal Relevance to select diverse, relevant playbook entries
 * @param entries All available playbook entries
 * @param maxResults Maximum number of entries to return
 * @param lambda Balance between relevance (1.0) and diversity (0.0). Default 0.7 favors relevance
 * @returns Selected entries ordered by MMR score
 */
export function selectEntriesWithMMR(
  entries: PlaybookEntry[],
  maxResults: number = 10,
  lambda: number = 0.7
): PlaybookEntry[] {
  if (entries.length === 0) return [];
  if (entries.length <= maxResults) return entries;

  // Convert to MMR entries with relevance = confidence and unique IDs
  const candidates: MMREntry[] = entries.map((entry, index) => ({
    ...entry,
    relevance: entry.confidence,
    id: `${entry.domain}-${index}`,
  }));

  const selected: MMREntry[] = [];
  const remaining = [...candidates];

  // First selection: highest relevance
  remaining.sort((a, b) => b.relevance - a.relevance);
  selected.push(remaining.shift()!);

  // Iteratively select entries with highest MMR score
  while (selected.length < maxResults && remaining.length > 0) {
    let bestEntry: MMREntry | null = null;
    let bestScore = -1;
    let bestIndex = -1;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      const diversity = calculateDiversity(candidate, selected);
      const mmrScore = lambda * candidate.relevance + (1 - lambda) * diversity;

      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestEntry = candidate;
        bestIndex = i;
      }
    }

    if (bestEntry) {
      selected.push(bestEntry);
      remaining.splice(bestIndex, 1);
    } else {
      break;
    }
  }

  // Return original PlaybookEntry format
  return selected.map(({ id, relevance, ...entry }) => entry);
}