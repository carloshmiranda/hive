/**
 * Error normalization utilities for the ReasoningBank-lite system.
 * Strips variable parts (UUIDs, timestamps, paths, IDs) from error messages
 * so that structurally identical errors can be matched across sessions.
 */

export function normalizeError(error: string): string {
  return error
    // UUIDs (v4 and similar hex patterns)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>')
    // ISO timestamps
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[^\s]*/g, '<TIMESTAMP>')
    // URLs
    .replace(/https?:\/\/[^\s"']+/g, '<URL>')
    // File paths (unix-style with at least 2 segments)
    .replace(/\/[^\s]*\/[^\s]*/g, '<PATH>')
    // Long numeric IDs (10+ digits)
    .replace(/\d{10,}/g, '<ID>')
    // Collapse multiple whitespace
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

/**
 * Word-level Jaccard similarity between two strings.
 * Returns 0-1 where 1 means identical word sets.
 */
export function errorSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  const union = new Set([...wordsA, ...wordsB]).size;
  return union === 0 ? 0 : intersection / union;
}
