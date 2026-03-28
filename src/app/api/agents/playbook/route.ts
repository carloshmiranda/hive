import { NextRequest } from "next/server";
import { validateOIDC } from "@/lib/oidc";
import { getDb, json, err } from "@/lib/db";
import { invalidatePlaybook } from "@/lib/redis-cache";

// Research summary compression: extract only relevant sections for the current task type
export function compressResearchForAgent(
  researchReports: any[],
  agentType: string
): any[] {
  const relevanceMap: Record<string, string[]> = {
    growth: ['market_research', 'seo_keywords', 'competitive_analysis'],
    outreach: ['market_research', 'competitive_analysis'],
    ops: ['product_spec', 'infrastructure'],
    build: ['product_spec', 'competitive_analysis'],
    fix: ['product_spec'],
  };

  const relevantTypes = relevanceMap[agentType] || ['market_research'];

  return researchReports
    .filter(report => relevantTypes.includes(report.report_type))
    .map(report => {
      // Extract key sections from content to reduce size by ~20%
      if (report.content && typeof report.content === 'object') {
        const content = report.content as any;

        // For different report types, extract only the most relevant sections
        if (report.report_type === 'market_research') {
          return {
            ...report,
            content: {
              target_market: content.target_market,
              key_findings: content.key_findings?.slice(0, 3), // Top 3 findings
              growth_opportunities: content.growth_opportunities?.slice(0, 2), // Top 2 opportunities
            }
          };
        }

        if (report.report_type === 'seo_keywords') {
          return {
            ...report,
            content: {
              primary_keywords: content.primary_keywords?.slice(0, 5), // Top 5 keywords
              content_gaps: content.content_gaps?.slice(0, 3), // Top 3 gaps
            }
          };
        }

        if (report.report_type === 'competitive_analysis') {
          return {
            ...report,
            content: {
              key_competitors: content.key_competitors?.slice(0, 3), // Top 3 competitors
              competitive_advantages: content.competitive_advantages?.slice(0, 2),
            }
          };
        }

        if (report.report_type === 'product_spec') {
          return {
            ...report,
            content: {
              core_features: content.core_features,
              technical_requirements: content.technical_requirements,
            }
          };
        }
      }

      // Fallback: use summary only if content compression isn't applicable
      return {
        report_type: report.report_type,
        summary: report.summary,
        content: null // Remove full content to save space
      };
    });
}

// POST /api/agents/playbook — write playbook entry via OIDC auth
// Body: { domain, insight, evidence?, confidence? }
export async function POST(req: NextRequest) {
  const claims = await validateOIDC(req);
  if (claims instanceof Response) return claims;

  let body;
  try {
    body = await req.json();
  } catch {
    return err("Invalid JSON body", 400);
  }

  const { source_company_id, domain, insight, evidence, confidence, content_language } = body;
  if (!domain || !insight) {
    return err("Missing required fields: domain, insight", 400);
  }

  const sql = getDb();

  // Deduplicate: skip if same domain + similar insight already exists for this company
  const [existing] = await sql`
    SELECT id FROM playbook
    WHERE domain = ${domain}
      AND (source_company_id = ${source_company_id || null} OR source_company_id IS NULL)
      AND insight = ${insight}
    LIMIT 1
  `.catch(() => []);

  if (existing) {
    return json({ id: existing.id, deduplicated: true });
  }

  const [entry] = await sql`
    INSERT INTO playbook (source_company_id, domain, insight, evidence, confidence, content_language)
    VALUES (${source_company_id || null}, ${domain}, ${insight}, ${evidence || null}, ${confidence ?? 0.7}, ${content_language || null})
    RETURNING id, domain, insight, confidence, content_language
  `;

  await invalidatePlaybook();
  return json(entry, 201);
}
