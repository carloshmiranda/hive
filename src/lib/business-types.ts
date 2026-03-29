/**
 * Single source of truth for business type definitions.
 *
 * Adding a new business type? Add ONE entry to BUSINESS_TYPES below.
 * Everything else (validation, manifest compatibility, assessment, CEO prompts)
 * derives from this file automatically.
 */

// ─── Core type definition ───

export interface BusinessTypeDefinition {
  /** Canonical ID used in code (normalized form) */
  id: string;
  /** Human-readable label */
  label: string;
  /** Legacy company_type values that map to this type */
  legacyTypes: string[];
  /** Default framework for this business type (CEO can override) */
  defaultFramework: "nextjs" | "astro" | "sveltekit" | "static";
  /** Lifecycle phases with score thresholds */
  phases: { name: string; threshold: number }[];
  /** Scoring function key — which scoring model to use */
  scoringModel: "saas" | "content" | "affiliate" | "saas"; // extensible
  /** Which boilerplate capabilities are relevant for this type */
  relevantCapabilities: string[];
  /** Kill criteria config */
  killCriteria: {
    /** Days before first check */
    firstCheckDays: number;
    /** Metric thresholds at each check point */
    checks: { days: number; condition: string }[];
  };
}

/**
 * ALL business types in one place. To add a new type:
 * 1. Add an entry here
 * 2. Run `npx next build` to verify
 * 3. That's it — validation, manifest, assessment, and CEO prompts all derive from this.
 */
export const BUSINESS_TYPES: BusinessTypeDefinition[] = [
  {
    id: "saas",
    label: "SaaS",
    legacyTypes: ["b2c_saas", "b2b_saas"],
    defaultFramework: "nextjs",
    phases: [
      { name: "validate", threshold: 0 },
      { name: "test_intent", threshold: 25 },
      { name: "build_mvp", threshold: 50 },
      { name: "build_aggressively", threshold: 75 },
      { name: "scale", threshold: 90 },
    ],
    scoringModel: "saas",
    relevantCapabilities: [
      "waitlist", "email_sequences", "email_log", "resend_webhook",
      "stripe", "sitemap", "llms_txt", "json_ld", "health_endpoint",
      "smoke_tests", "post_deploy", "analytics", "stats_endpoint",
      "pricing_intent", "hive_build", "hive_growth", "hive_fix",
    ],
    killCriteria: {
      firstCheckDays: 60,
      checks: [
        { days: 60, condition: "signups < 5 AND views < 500" },
        { days: 120, condition: "signups < 25 AND zero WoW growth" },
        { days: 180, condition: "signups < 50" },
      ],
    },
  },
  {
    id: "blog",
    label: "Blog",
    legacyTypes: ["blog"],
    defaultFramework: "astro",
    phases: [
      { name: "seed_content", threshold: 0 },
      { name: "seo_growth", threshold: 25 },
      { name: "monetize", threshold: 50 },
      { name: "scale", threshold: 75 },
    ],
    scoringModel: "content",
    relevantCapabilities: [
      "sitemap", "llms_txt", "json_ld", "health_endpoint",
      "smoke_tests", "post_deploy", "analytics", "stats_endpoint",
      "affiliate_tracking", "hive_build", "hive_growth", "hive_fix",
    ],
    killCriteria: {
      firstCheckDays: 60,
      checks: [
        { days: 60, condition: "views < 500" },
        { days: 120, condition: "monthly views < 2000 AND zero growth" },
        { days: 180, condition: "monthly views < 5000" },
      ],
    },
  },
  {
    id: "affiliate_site",
    label: "Affiliate Site",
    legacyTypes: ["affiliate_site"],
    defaultFramework: "astro",
    phases: [
      { name: "build_directory", threshold: 0 },
      { name: "drive_traffic", threshold: 25 },
      { name: "optimize_conversions", threshold: 50 },
      { name: "scale", threshold: 75 },
    ],
    scoringModel: "affiliate",
    relevantCapabilities: [
      "sitemap", "llms_txt", "json_ld", "health_endpoint",
      "smoke_tests", "post_deploy", "analytics", "stats_endpoint",
      "affiliate_tracking", "hive_build", "hive_growth", "hive_fix",
    ],
    killCriteria: {
      firstCheckDays: 60,
      checks: [
        { days: 60, condition: "views < 200" },
        { days: 120, condition: "views < 1000" },
        { days: 180, condition: "zero affiliate revenue" },
      ],
    },
  },
  {
    id: "newsletter",
    label: "Newsletter",
    legacyTypes: ["newsletter"],
    defaultFramework: "astro",
    phases: [
      { name: "seed_content", threshold: 0 },
      { name: "grow_subscribers", threshold: 25 },
      { name: "monetize", threshold: 50 },
      { name: "scale", threshold: 75 },
    ],
    scoringModel: "content",
    relevantCapabilities: [
      "email_sequences", "email_log", "resend_webhook",
      "sitemap", "llms_txt", "json_ld", "health_endpoint",
      "smoke_tests", "post_deploy", "analytics", "stats_endpoint",
      "hive_build", "hive_growth", "hive_fix",
    ],
    killCriteria: {
      firstCheckDays: 60,
      checks: [
        { days: 60, condition: "views < 500" },
        { days: 120, condition: "monthly views < 2000 AND zero growth" },
        { days: 180, condition: "monthly views < 5000" },
      ],
    },
  },
  {
    id: "marketplace",
    label: "Marketplace",
    legacyTypes: ["marketplace"],
    defaultFramework: "nextjs",
    phases: [
      { name: "validate", threshold: 0 },
      { name: "build_supply", threshold: 25 },
      { name: "build_demand", threshold: 50 },
      { name: "scale", threshold: 75 },
    ],
    scoringModel: "saas",
    relevantCapabilities: [
      "waitlist", "email_sequences", "email_log", "resend_webhook",
      "stripe", "sitemap", "llms_txt", "json_ld", "health_endpoint",
      "smoke_tests", "post_deploy", "analytics", "stats_endpoint",
      "pricing_intent", "hive_build", "hive_growth", "hive_fix",
    ],
    killCriteria: {
      firstCheckDays: 60,
      checks: [
        { days: 60, condition: "signups < 5 AND views < 500" },
        { days: 120, condition: "signups < 25 AND zero WoW growth" },
        { days: 180, condition: "signups < 50" },
      ],
    },
  },
  {
    id: "digital_product",
    label: "Digital Product",
    legacyTypes: ["digital_product"],
    defaultFramework: "nextjs",
    phases: [
      { name: "validate", threshold: 0 },
      { name: "test_intent", threshold: 25 },
      { name: "build_product", threshold: 50 },
      { name: "scale", threshold: 75 },
    ],
    scoringModel: "saas",
    relevantCapabilities: [
      "stripe", "sitemap", "llms_txt", "json_ld", "health_endpoint",
      "smoke_tests", "post_deploy", "analytics", "stats_endpoint",
      "pricing_intent", "hive_build", "hive_growth", "hive_fix",
    ],
    killCriteria: {
      firstCheckDays: 60,
      checks: [
        { days: 60, condition: "signups < 5 AND views < 500" },
        { days: 120, condition: "signups < 25 AND zero WoW growth" },
        { days: 180, condition: "signups < 50" },
      ],
    },
  },
  {
    id: "faceless_channel",
    label: "Faceless Channel",
    legacyTypes: ["faceless_channel"],
    defaultFramework: "static",
    phases: [
      { name: "seed_content", threshold: 0 },
      { name: "grow_audience", threshold: 25 },
      { name: "monetize", threshold: 50 },
      { name: "scale", threshold: 75 },
    ],
    scoringModel: "content",
    relevantCapabilities: [
      "analytics", "stats_endpoint",
      "hive_build", "hive_growth", "hive_fix",
    ],
    killCriteria: {
      firstCheckDays: 60,
      checks: [
        { days: 60, condition: "views < 500" },
        { days: 120, condition: "monthly views < 2000 AND zero growth" },
        { days: 180, condition: "monthly views < 5000" },
      ],
    },
  },
  {
    id: "api_service",
    label: "API Service",
    legacyTypes: ["api_service"],
    defaultFramework: "nextjs",
    phases: [
      { name: "validate", threshold: 0 },
      { name: "test_intent", threshold: 25 },
      { name: "build_mvp", threshold: 50 },
      { name: "scale", threshold: 75 },
    ],
    scoringModel: "saas",
    relevantCapabilities: [
      "stripe", "health_endpoint", "smoke_tests", "post_deploy",
      "stats_endpoint", "pricing_intent",
      "hive_build", "hive_growth", "hive_fix",
    ],
    killCriteria: {
      firstCheckDays: 60,
      checks: [
        { days: 60, condition: "signups < 5 AND views < 500" },
        { days: 120, condition: "signups < 25 AND zero WoW growth" },
        { days: 180, condition: "signups < 50" },
      ],
    },
  },
];

// ─── Derived lookups (computed once at import time) ───

/** Map from canonical ID to definition */
export const BUSINESS_TYPE_MAP: Record<string, BusinessTypeDefinition> =
  Object.fromEntries(BUSINESS_TYPES.map(t => [t.id, t]));

/** Map from any legacy type string to canonical ID */
const LEGACY_TO_CANONICAL: Record<string, string> = {};
for (const t of BUSINESS_TYPES) {
  // The canonical ID also maps to itself
  LEGACY_TO_CANONICAL[t.id] = t.id;
  for (const legacy of t.legacyTypes) {
    LEGACY_TO_CANONICAL[legacy] = t.id;
  }
}

/** All canonical type IDs */
export const ALL_TYPE_IDS = BUSINESS_TYPES.map(t => t.id);

/** All legacy type strings (for DB validation) */
export const ALL_LEGACY_TYPES = BUSINESS_TYPES.flatMap(t => t.legacyTypes);

/**
 * Normalize any company_type string to a canonical business type ID.
 * Unknown types default to "saas".
 */
export function normalizeType(raw: string | null | undefined): string {
  if (!raw) return "saas";
  return LEGACY_TO_CANONICAL[raw] || "saas";
}

/**
 * Get the definition for a business type (accepts legacy or canonical).
 */
export function getTypeDefinition(raw: string | null | undefined): BusinessTypeDefinition {
  const id = normalizeType(raw);
  return BUSINESS_TYPE_MAP[id] || BUSINESS_TYPE_MAP["saas"];
}

/**
 * Get all legacy type strings that are relevant for a given capability.
 * Used by boilerplate-manifest.json compatibility arrays.
 */
export function getTypesForCapability(capability: string): string[] {
  const types: string[] = [];
  for (const t of BUSINESS_TYPES) {
    if (t.relevantCapabilities.includes(capability)) {
      types.push(...t.legacyTypes);
    }
  }
  return types;
}

/**
 * Check if a capability is relevant for a given company type.
 */
export function isCapabilityRelevant(capability: string, companyType: string | null | undefined): boolean {
  const def = getTypeDefinition(companyType);
  return def.relevantCapabilities.includes(capability);
}
