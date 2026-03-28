/**
 * Structured completion reports for agent-to-agent handoffs.
 * Agents write these to agent_actions.output on completion.
 * Other agents read them via the context API to understand what happened.
 */

export interface CompletionReport {
  summary: string;                         // One-line human-readable summary
  files_changed?: string[];                // Files touched
  decisions?: string[];                    // Key decisions made
  blockers?: string[];                     // Things that need attention
  recommendations?: AgentSignal[];         // Cross-agent signals
  pr_number?: number;                      // If a PR was created
  branch?: string;                         // Branch name
  metrics_impact?: Record<string, number>; // e.g. { pages_created: 3 }
}

export interface AgentSignal {
  target_agent: string;  // 'ceo' | 'engineer' | 'growth' | 'ops' | etc.
  priority: 'info' | 'action' | 'blocker';
  message: string;
}

/**
 * Merge a completion report into an existing agent_actions.output JSONB column.
 * Preserves existing data (pr_tracking, provider info, etc.).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function writeCompletionReport(
  sql: any,
  actionId: number | string,
  report: CompletionReport
): Promise<void> {
  await sql`
    UPDATE agent_actions
    SET output = COALESCE(output, '{}'::jsonb) || ${JSON.stringify(report)}::jsonb
    WHERE id = ${actionId}
  `.catch((e: any) => {
    console.warn(`[completion-report] write for action ${actionId} failed: ${e?.message || e}`);
  });
}

/**
 * Write a completion report by matching the most recent action for a given backlog dispatch_id.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function writeCompletionReportByDispatchId(
  sql: any,
  dispatchId: number | string,
  report: CompletionReport
): Promise<void> {
  await sql`
    UPDATE agent_actions
    SET output = COALESCE(output, '{}'::jsonb) || ${JSON.stringify(report)}::jsonb
    WHERE id = ${dispatchId}
  `.catch((e: any) => {
    console.warn(`[completion-report] write by dispatch ${dispatchId} failed: ${e?.message || e}`);
  });
}

/**
 * Extract a typed completion report from raw JSONB output.
 * Returns null if the output doesn't contain a valid report.
 */
export function extractCompletionReport(output: unknown): CompletionReport | null {
  if (!output || typeof output !== 'object') return null;
  const o = output as Record<string, unknown>;
  if (typeof o.summary !== 'string') return null;
  return {
    summary: o.summary,
    files_changed: Array.isArray(o.files_changed) ? o.files_changed : undefined,
    decisions: Array.isArray(o.decisions) ? o.decisions : undefined,
    blockers: Array.isArray(o.blockers) ? o.blockers : undefined,
    recommendations: Array.isArray(o.recommendations) ? o.recommendations : undefined,
    pr_number: typeof o.pr_number === 'number' ? o.pr_number : undefined,
    branch: typeof o.branch === 'string' ? o.branch : undefined,
    metrics_impact: typeof o.metrics_impact === 'object' && o.metrics_impact ? o.metrics_impact as Record<string, number> : undefined,
  };
}
