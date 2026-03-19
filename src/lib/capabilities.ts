/**
 * Company capability inventory helpers.
 * Used by agents to check what infrastructure exists before acting on it.
 */

export interface CapabilityEntry {
  exists: boolean;
  [k: string]: unknown;
}

/**
 * Check if a company has a specific capability.
 * Returns the capability object if it exists, or { exists: false } if not.
 */
export function hasCapability(
  capabilities: Record<string, unknown> | null | undefined,
  key: string
): CapabilityEntry {
  if (!capabilities) return { exists: false };
  const cap = capabilities[key] as Record<string, unknown> | undefined;
  if (!cap) return { exists: false };
  return { exists: false, ...cap };
}

/**
 * Check if a capability exists AND makes sense for this company.
 * Used for optional features like waitlist, referral, GSC.
 */
export function shouldUseCapability(
  capabilities: Record<string, unknown> | null | undefined,
  key: string
): boolean {
  const cap = hasCapability(capabilities, key);
  return cap.exists === true && cap.makes_sense !== false;
}

/**
 * Get a list of missing capabilities that could be added to this company.
 * Used by Evolver to know what to propose.
 */
export function getMissingCapabilities(
  capabilities: Record<string, unknown> | null | undefined
): string[] {
  const missing: string[] = [];
  const optionalCaps = [
    "email_sequences", "email_log", "resend_webhook", "waitlist",
    "referral_mechanics", "gsc_integration", "visibility_metrics",
    "indexnow", "llms_txt", "sitemap", "json_ld",
  ];

  for (const key of optionalCaps) {
    const cap = hasCapability(capabilities, key);
    if (!cap.exists && cap.makes_sense !== false) {
      missing.push(key);
    }
  }

  return missing;
}

/**
 * Get capabilities that exist but aren't configured (have the table/route but missing API keys).
 */
export function getUnconfiguredCapabilities(
  capabilities: Record<string, unknown> | null | undefined
): string[] {
  const unconfigured: string[] = [];
  const configurable = ["stripe", "email_provider", "gsc_integration", "indexnow"];

  for (const key of configurable) {
    const cap = hasCapability(capabilities, key);
    if (cap.exists && cap.configured === false) {
      unconfigured.push(key);
    }
  }

  return unconfigured;
}

/**
 * Build a compact capabilities summary string for agent context injection.
 */
export function capabilitiesSummary(
  capabilities: Record<string, unknown> | null | undefined
): string {
  if (!capabilities || Object.keys(capabilities).length === 0) {
    return "CAPABILITIES: Not assessed yet — treat all optional features as unavailable.";
  }

  const lines: string[] = ["CAPABILITIES:"];

  const groups: Record<string, string[]> = {
    "Infrastructure": ["database", "hosting", "repo"],
    "Payment & Auth": ["stripe", "auth"],
    "Email": ["email_provider", "email_sequences", "email_log", "resend_webhook"],
    "Growth": ["waitlist", "referral_mechanics", "gsc_integration", "visibility_metrics"],
    "SEO": ["indexnow", "llms_txt", "sitemap", "json_ld"],
  };

  for (const [group, keys] of Object.entries(groups)) {
    const items: string[] = [];
    for (const key of keys) {
      const cap = hasCapability(capabilities, key);
      if (cap.exists) {
        const configured = cap.configured !== undefined
          ? (cap.configured ? " (configured)" : " (not configured)")
          : "";
        const makesSense = cap.makes_sense === false
          ? ` [N/A: ${cap.reason || "not applicable"}]`
          : "";
        items.push(`${key}=YES${configured}${makesSense}`);
      } else {
        const makesSense = cap.makes_sense === false
          ? ` [N/A: ${cap.reason || "not applicable"}]`
          : "";
        items.push(`${key}=NO${makesSense}`);
      }
    }
    lines.push(`  ${group}: ${items.join(", ")}`);
  }

  // Launch mode
  const lm = hasCapability(capabilities, "launch_mode");
  if (lm.exists !== false || lm.value) {
    lines.push(`  Launch mode: ${lm.value || "unknown"}`);
  }

  return lines.join("\n");
}
