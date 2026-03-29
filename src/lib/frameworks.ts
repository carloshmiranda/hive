/**
 * Framework registry for multi-framework boilerplate support.
 *
 * Each framework defines how Vercel should build/deploy it and what
 * boilerplate template directory to use during provisioning.
 * CEO picks framework based on business model; Engineer uses it at provision time.
 */

export interface FrameworkDefinition {
  /** Identifier used in DB and code */
  id: string;
  /** Human-readable name */
  label: string;
  /** Vercel framework preset (passed to Vercel API) */
  vercelFramework: string;
  /** Default build command */
  buildCommand: string;
  /** Build output directory */
  outputDirectory: string;
  /** Boilerplate template subdirectory under templates/ */
  boilerplateDir: string;
  /** When to pick this framework */
  bestFor: string;
}

export const FRAMEWORKS: FrameworkDefinition[] = [
  {
    id: "nextjs",
    label: "Next.js",
    vercelFramework: "nextjs",
    buildCommand: "npm run build",
    outputDirectory: ".next",
    boilerplateDir: "boilerplate",
    bestFor: "SaaS, marketplaces, apps needing SSR/API routes",
  },
  {
    id: "astro",
    label: "Astro",
    vercelFramework: "astro",
    buildCommand: "npm run build",
    outputDirectory: "dist",
    boilerplateDir: "boilerplate-astro",
    bestFor: "Content/SEO sites, blogs, affiliate sites",
  },
  {
    id: "sveltekit",
    label: "SvelteKit",
    vercelFramework: "sveltekit-1",
    buildCommand: "npm run build",
    outputDirectory: ".svelte-kit",
    boilerplateDir: "boilerplate-sveltekit",
    bestFor: "Lightweight SaaS, interactive apps with minimal bundle",
  },
  {
    id: "static",
    label: "Static HTML",
    vercelFramework: "",
    buildCommand: "",
    outputDirectory: "public",
    boilerplateDir: "boilerplate-static",
    bestFor: "Landing pages, simple validation sites",
  },
];

/** Map from framework ID to definition */
export const FRAMEWORK_MAP: Record<string, FrameworkDefinition> =
  Object.fromEntries(FRAMEWORKS.map(f => [f.id, f]));

/** All valid framework IDs */
export const ALL_FRAMEWORK_IDS = FRAMEWORKS.map(f => f.id);

/**
 * Get framework definition by ID. Defaults to "nextjs" for unknown values.
 */
export function getFramework(id: string | null | undefined): FrameworkDefinition {
  if (!id) return FRAMEWORK_MAP["nextjs"];
  return FRAMEWORK_MAP[id] || FRAMEWORK_MAP["nextjs"];
}

/**
 * Recommend a framework based on business type.
 * CEO can override this, but this provides a sensible default.
 */
export function recommendFramework(businessType: string | null | undefined): string {
  switch (businessType) {
    // Content-heavy sites benefit from Astro's static-first approach
    case "blog":
    case "affiliate_site":
    case "newsletter":
      return "astro";

    // SaaS/marketplaces need SSR + API routes → Next.js
    case "saas":
    case "marketplace":
    case "api_service":
    case "digital_product":
      return "nextjs";

    // Faceless channels just need a simple landing page
    case "faceless_channel":
      return "static";

    default:
      return "nextjs";
  }
}
