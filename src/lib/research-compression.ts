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