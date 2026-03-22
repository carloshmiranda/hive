import { NextRequest } from "next/server";
import { validateOIDC } from "@/lib/oidc";
import { json, err } from "@/lib/db";
import {
  BUSINESS_TYPES,
  normalizeType,
  BUSINESS_TYPE_MAP,
  type BusinessTypeDefinition,
} from "@/lib/business-types";

/**
 * POST /api/agents/research-type
 *
 * When Scout proposes a company with a business_model we haven't seen before,
 * this endpoint:
 * 1. Checks if the type already exists in business-types.ts
 * 2. If yes, returns the existing definition
 * 3. If no, returns a research prompt for Claude to generate a new definition
 *    using web search + the existing types as reference
 *
 * The Engineer workflow calls this before provisioning. If a new type is needed,
 * Engineer uses Claude to research best practices, generate the definition,
 * and commit it to business-types.ts.
 */
export async function POST(req: NextRequest) {
  const claims = await validateOIDC(req);
  if (claims instanceof Response) return claims;

  const body = await req.json();
  const { business_model, company_name, company_description } = body;

  if (!business_model) {
    return err("Missing business_model", 400);
  }

  // Check if this type already exists (either as canonical or legacy)
  const normalized = normalizeType(business_model);
  const existing = BUSINESS_TYPE_MAP[normalized];

  // If the normalized result matches an existing type AND the raw input
  // is already known (not just defaulting to "saas"), return it
  const isKnown = BUSINESS_TYPES.some(
    (t) => t.id === business_model || t.legacyTypes.includes(business_model)
  );

  if (isKnown && existing) {
    return json({
      ok: true,
      status: "known",
      type_id: existing.id,
      definition: existing,
    });
  }

  // Unknown type — generate research prompt and reference context
  const referenceTypes = BUSINESS_TYPES.map((t) => ({
    id: t.id,
    label: t.label,
    phases: t.phases.map((p) => p.name),
    scoringModel: t.scoringModel,
    relevantCapabilities: t.relevantCapabilities,
    killCriteria: t.killCriteria,
  }));

  // All known capabilities from the manifest/system
  const allCapabilities = [
    "waitlist", "email_sequences", "email_log", "resend_webhook",
    "stripe", "sitemap", "llms_txt", "json_ld", "health_endpoint",
    "smoke_tests", "post_deploy", "analytics", "stats_endpoint",
    "pricing_intent", "affiliate_tracking", "gsc_integration",
    "visibility_metrics", "indexnow", "referral_mechanics",
    "hive_build", "hive_growth", "hive_fix",
  ];

  const researchPrompt = buildResearchPrompt(
    business_model,
    company_name,
    company_description,
    referenceTypes,
    allCapabilities
  );

  // Return the TypeScript template that Claude should fill in
  const typeTemplate = buildTypeTemplate(business_model);

  return json({
    ok: true,
    status: "unknown",
    business_model,
    normalized_fallback: normalized,
    research_prompt: researchPrompt,
    type_template: typeTemplate,
    reference_types: referenceTypes,
    all_capabilities: allCapabilities,
    instructions: [
      "1. Use web search to research best practices for this business model",
      "2. Study the reference_types to understand the pattern",
      "3. Fill in the type_template with researched data",
      "4. Add the new entry to src/lib/business-types.ts BUSINESS_TYPES array",
      "5. Add phase rules to src/lib/validation.ts PHASE_RULES if phases are unique",
      "6. Add a scoring function to validation.ts if the scoring model is new",
      "7. Run `npx next build` to verify",
      "8. Commit to a branch and create a PR",
    ],
  });
}

function buildResearchPrompt(
  businessModel: string,
  companyName: string | undefined,
  companyDescription: string | undefined,
  referenceTypes: unknown[],
  allCapabilities: string[]
): string {
  return `# Research: Business Type Definition for "${businessModel}"

## Context
Hive is an autonomous venture orchestrator that builds and runs companies.
${companyName ? `A new company "${companyName}" has been proposed${companyDescription ? `: ${companyDescription}` : ""}.` : ""}
Its business model "${businessModel}" is not yet in our type registry.

## What to research (use web search)

1. **Lifecycle phases**: What are the typical stages of building a ${businessModel} business?
   - What should be validated BEFORE building the product?
   - What metrics indicate readiness to move to the next phase?
   - What's the typical progression from idea → revenue?

2. **Key metrics**: What metrics matter most for a ${businessModel}?
   - Which metrics should drive scoring (validation score 0-100)?
   - What scoring model is closest: SaaS (waitlist + conversion + payment intent), content (traffic + growth + consistency), or affiliate (traffic + CTR + revenue)?
   - Or does this need a new scoring model?

3. **Infrastructure needs**: Which of these capabilities are relevant?
   Available capabilities: ${allCapabilities.join(", ")}
   - Which are essential for this business type?
   - Which are irrelevant?

4. **Kill criteria**: When should Hive consider killing a ${businessModel} business?
   - What's a reasonable first check (30, 60, 90 days)?
   - What signals mean "no traction" at each checkpoint?
   - At what point is it clearly not working?

5. **Phase-specific rules**: For each lifecycle phase:
   - What work is ALLOWED (gating rules)?
   - What work is FORBIDDEN (premature optimization)?

## Reference: Existing types
${JSON.stringify(referenceTypes, null, 2)}

## Output format
Return a complete BusinessTypeDefinition object (TypeScript) that can be added to the BUSINESS_TYPES array.
Also return PHASE_RULES entries for any new/unique phases.
Also return a scoring function if the existing models (saas/content/affiliate) don't fit.`;
}

function buildTypeTemplate(businessModel: string): string {
  const id = businessModel.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  return `{
  id: "${id}",
  label: "${businessModel.charAt(0).toUpperCase() + businessModel.slice(1).replace(/_/g, " ")}",
  legacyTypes: ["${id}"],
  phases: [
    { name: "validate", threshold: 0 },
    // TODO: Research and fill in actual phases
    { name: "scale", threshold: 75 },
  ],
  scoringModel: "saas", // TODO: Pick correct model or create new one
  relevantCapabilities: [
    // TODO: Research which capabilities matter
    "health_endpoint", "smoke_tests", "post_deploy", "stats_endpoint",
    "hive_build", "hive_growth", "hive_fix",
  ],
  killCriteria: {
    firstCheckDays: 60,
    checks: [
      // TODO: Research appropriate kill signals
      { days: 60, condition: "..." },
      { days: 120, condition: "..." },
      { days: 180, condition: "..." },
    ],
  },
}`;
}
