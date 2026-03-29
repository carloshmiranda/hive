/**
 * Playbook domain normalization.
 *
 * Prevents domain fragmentation by mapping aliases to canonical names.
 * Example: "ops" and "operations" both map to "operations".
 */

const DOMAIN_ALIASES: Record<string, string> = {
  ops: "operations",
};

/**
 * Normalize a playbook domain to its canonical form.
 * Returns the input unchanged if no alias exists.
 */
export function normalizePlaybookDomain(domain: string): string {
  const lower = domain.toLowerCase().trim();
  return DOMAIN_ALIASES[lower] || lower;
}
