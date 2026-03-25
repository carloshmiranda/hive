import { callLLM } from "@/lib/llm";
import { getSettingValue } from "@/lib/settings";
import { isBacklogItemInCooldown, cleanupFailedItemsCache } from "@/lib/dispatch";

export interface BacklogSpec {
  acceptance_criteria: string[];
  affected_files: string[];
  approach: string[];
  risks: string[];
  complexity: "S" | "M" | "L";
  estimated_turns: number;
}

interface BacklogItem {
  id: string;
  title: string;
  description: string;
  priority: string;
  category: string;
  notes?: string;
  created_at?: string;
}

// Fetch Hive repo file tree from GitHub API (cached per call)
async function getFileTree(): Promise<string[]> {
  const ghToken = await getSettingValue("github_token");
  if (!ghToken) return [];

  try {
    const res = await fetch(
      "https://api.github.com/repos/carloshmiranda/hive/git/trees/main?recursive=1",
      {
        headers: {
          Authorization: `token ${ghToken}`,
          Accept: "application/vnd.github.v3+json",
        },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!res.ok) return [];
    const data = await res.json();
    // Filter to source files only (skip node_modules, .next, etc.)
    return (data.tree || [])
      .filter(
        (f: { type: string; path: string }) =>
          f.type === "blob" &&
          (f.path.startsWith("src/") ||
            f.path.startsWith(".github/") ||
            f.path.startsWith("prompts/") ||
            f.path.startsWith("templates/") ||
            f.path.endsWith(".md") ||
            f.path === "schema.sql" ||
            f.path === "package.json")
      )
      .map((f: { path: string }) => f.path);
  } catch {
    return [];
  }
}

// Find files relevant to a task by keyword matching
function findRelevantFiles(
  files: string[],
  title: string,
  description: string
): string[] {
  const text = `${title} ${description}`.toLowerCase();

  // Extract meaningful keywords (skip common words)
  const stopWords = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "must", "shall", "can", "need", "dare",
    "to", "of", "in", "for", "on", "with", "at", "by", "from", "as",
    "into", "through", "during", "before", "after", "above", "below",
    "between", "out", "off", "over", "under", "again", "further", "then",
    "once", "and", "but", "or", "nor", "not", "so", "yet", "both",
    "each", "every", "all", "any", "few", "more", "most", "other",
    "some", "such", "no", "only", "own", "same", "than", "too", "very",
    "this", "that", "these", "those", "it", "its", "add", "fix", "update",
    "make", "use", "when", "how", "what", "which", "who", "where", "why",
  ]);
  const keywords = text
    .replace(/[^a-z0-9_\-/]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w));

  // Score each file by keyword matches in its path
  const scored = files.map((f) => {
    const fLower = f.toLowerCase();
    let score = 0;
    for (const kw of keywords) {
      if (fLower.includes(kw)) score++;
    }
    return { file: f, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 15)
    .map((s) => s.file);
}

/**
 * Analyze if a backlog item description is a problem statement vs. implementable task
 * Problem statements need decomposition before they can be dispatched
 */
export function isProblemStatement(title: string, description: string): boolean {
  const text = `${title} ${description}`.toLowerCase();

  // Problem statement indicators
  const problemIndicators = [
    // Vague action words without specifics
    /\b(improve|enhance|optimize|make better|fix issues|address)\b(?!\s+(function|file|component|class|method|route|api|endpoint|table|query))/,

    // High-level goals without implementation details
    /\b(should be|need to|we should|it would be good|consider|explore|investigate)\b/,

    // Reporting/analysis rather than implementation tasks
    /\b(analyze|research|figure out|understand why|look into|check)\b/,

    // Vague references without specificity
    /\b(better|more|less|faster|cleaner|easier|simpler)\b(?!\s+(by|via|through|using))/,

    // Generic problem descriptions
    /\b(problems?|issues?|bugs?|errors?)\s+with\b(?!\s+(function|file|component|class|method|route|api|endpoint|table|query))/,

    // Feature requests without implementation details
    /\b(add support for|implement|create)\b(?!\s+(function|file|component|class|method|route|api|endpoint|table|query))/
  ];

  // Actionable task indicators (if present, likely NOT a problem statement)
  const actionableIndicators = [
    // Specific file/code references
    /\b(src\/|\.ts|\.tsx|\.js|\.sql|package\.json|schema\.sql)\b/,

    // Specific technical terms
    /\b(function|method|class|component|route|api|endpoint|table|query|column|interface|type)\s+\w+/,

    // Concrete actions
    /\b(update|modify|change|replace|add|remove|delete)\s+(the\s+)?(\w+\s+)?(function|method|class|component|route|api|endpoint|table|query|file)\b/,

    // Step-by-step instructions
    /step \d+:|^\d+\.|first|then|next|finally/,

    // Specific implementation details
    /\b(in|to|from)\s+(src\/|\w+\.ts|\w+\.tsx|\w+\.js|\w+\.sql)/
  ];

  // Check for problem indicators
  const hasProblemIndicators = problemIndicators.some(pattern => pattern.test(text));

  // Check for actionable indicators
  const hasActionableIndicators = actionableIndicators.some(pattern => pattern.test(text));

  // Additional heuristics for problem statements
  const isVague = (
    // Very short descriptions (likely too high-level)
    description.trim().length < 100 ||

    // Lacks specific technical details
    !/\b(src\/|function|method|class|component|route|api|file|table)\b/.test(text) ||

    // Contains question words without answers
    /\b(what|why|how|where|when|which)\b/.test(text) && !/\b(update|change|add|remove|fix)\b/.test(text)
  );

  // Decision logic:
  // - If has actionable indicators and no problem indicators -> not a problem statement
  // - If has problem indicators or is vague and lacks actionable details -> problem statement
  return (hasProblemIndicators || isVague) && !hasActionableIndicators;
}

/**
 * Flag backlog items that are problem statements as needing decomposition
 * This prevents them from being dispatched until broken down into actionable tasks
 */
export async function flagProblemStatementsAsNeedingDecomposition(
  sql?: any
): Promise<{ flagged: number; items: Array<{ id: string; title: string }> }> {
  if (!sql) {
    return { flagged: 0, items: [] };
  }

  try {
    // Find items in ready/approved status that might be problem statements
    const candidateItems = await sql`
      SELECT id, title, description, status, notes
      FROM hive_backlog
      WHERE status IN ('ready', 'approved')
      AND NOT (notes ILIKE '%needs_decomposition%')
      ORDER BY created_at ASC
      LIMIT 50
    `.catch(() => []);

    const flaggedItems: Array<{ id: string; title: string }> = [];

    for (const item of candidateItems) {
      if (isProblemStatement(item.title || '', item.description || '')) {
        // Flag as needs decomposition
        await sql`
          UPDATE hive_backlog
          SET status = 'blocked',
              notes = COALESCE(notes, '') || ' [needs_decomposition] Auto-flagged as problem statement — needs breakdown into actionable tasks.'
          WHERE id = ${item.id}
        `.catch(() => {});

        flaggedItems.push({ id: item.id, title: item.title });
      }
    }

    if (flaggedItems.length > 0) {
      console.log(`[backlog-planner] Flagged ${flaggedItems.length} problem statements as needing decomposition`);
    }

    return { flagged: flaggedItems.length, items: flaggedItems };
  } catch (error) {
    console.warn('flagProblemStatementsAsNeedingDecomposition failed:', error instanceof Error ? error.message : 'unknown');
    return { flagged: 0, items: [] };
  }
}

/**
 * Filter backlog items to exclude those in cooldown period
 * Also performs cleanup of expired cooldown entries
 */
export function filterBacklogItemsByCooldown(items: BacklogItem[]): BacklogItem[] {
  // Clean up expired entries first
  cleanupFailedItemsCache();

  // Filter out items that are in cooldown
  return items.filter(item => !isBacklogItemInCooldown(item.id));
}

/**
 * Circuit breaker for backlog cascade dispatch
 * Checks if >50% of last 5 Engineer backlog runs failed within 24h
 * If so, pauses cascade for 1 hour to prevent cascading failures
 *
 * @param sql Database connection
 * @param forceDispatch Bypass circuit breaker (for P0 items)
 * @returns {dispatched: true} | {dispatched: false, reason: string, ...details}
 */
export async function checkBacklogCircuitBreaker(
  sql: any,
  forceDispatch = false
): Promise<{ dispatched: boolean; reason?: string; [key: string]: any }> {

  // Skip circuit breaker if forced (P0 items)
  if (forceDispatch) {
    return { dispatched: true };
  }

  try {
    const recentBacklogRuns = await sql`
      SELECT status, finished_at
      FROM agent_actions
      WHERE agent = 'engineer'
      AND action_type = 'feature_request'
      AND (company_id IS NULL OR company_id = (SELECT id FROM companies WHERE slug = '_hive'))
      AND finished_at > NOW() - INTERVAL '24 hours'
      ORDER BY finished_at DESC
      LIMIT 5
    `.catch(() => []);

    if (recentBacklogRuns.length >= 3) {
      const failedCount = recentBacklogRuns.filter((run: any) => run.status === 'failed').length;
      const failureRate = failedCount / recentBacklogRuns.length;

      if (failureRate > 0.5) {
        // Check if the most recent failure was within the last hour (circuit breaker window)
        const mostRecentFailure = recentBacklogRuns.find((run: any) => run.status === 'failed');
        if (mostRecentFailure) {
          const hoursSinceFailure = (Date.now() - new Date(mostRecentFailure.finished_at).getTime()) / (1000 * 60 * 60);

          if (hoursSinceFailure <= 1) {
            return {
              dispatched: false,
              reason: "circuit_breaker",
              detail: "backlog_failures",
              failed_runs: failedCount,
              total_runs: recentBacklogRuns.length,
              failure_rate: Math.round(failureRate * 100),
              cooldown_remaining_minutes: Math.round(60 - (hoursSinceFailure * 60))
            };
          }
        }
      }
    }

    return { dispatched: true };
  } catch (error) {
    console.warn("Circuit breaker check failed:", error instanceof Error ? error.message : "unknown");
    // On error, allow dispatch to continue (fail-open)
    return { dispatched: true };
  }
}

// Generate a spec for a backlog item using a cheap LLM call
export async function generateSpec(
  item: BacklogItem,
  sql?: any
): Promise<BacklogSpec | null> {
  const files = await getFileTree();
  const relevantFiles = findRelevantFiles(files, item.title, item.description);

  // Build a compact file tree for context (just relevant files + top-level structure)
  const topLevel = files
    .filter((f: string) => f.split("/").length <= 3 && f.startsWith("src/app/api/"))
    .slice(0, 30);
  const fileContext = [...new Set([...relevantFiles, ...topLevel])].sort().join("\n");

  // Get previous failure notes if any
  const previousErrors = item.notes
    ? item.notes
        .split(/\[attempt \d+\]/)
        .filter((n: string) => n.includes("fail") || n.includes("error"))
        .slice(-2)
        .join("\n")
    : "";

  const prompt = `You are a technical planner for a Next.js TypeScript codebase called Hive (a venture orchestrator).
Given a backlog task, produce a structured implementation spec.

TASK: ${item.title}
PRIORITY: ${item.priority}
CATEGORY: ${item.category}
DESCRIPTION:
${item.description}
${previousErrors ? `\nPREVIOUS FAILED ATTEMPTS:\n${previousErrors}\n` : ""}
RELEVANT FILES IN CODEBASE:
${fileContext}

FULL API ROUTE STRUCTURE:
${files.filter((f: string) => f.startsWith("src/app/api/") && f.endsWith("route.ts")).join("\n")}

Respond with ONLY valid JSON (no markdown, no explanation) matching this exact schema:
{
  "acceptance_criteria": ["criterion 1", "criterion 2", "criterion 3"],
  "affected_files": ["src/path/to/file.ts"],
  "approach": ["Step 1: ...", "Step 2: ...", "Step 3: ..."],
  "risks": ["risk 1"],
  "complexity": "S",
  "estimated_turns": 15
}

Rules:
- acceptance_criteria: 3-5 concrete, testable conditions. Include "npx next build passes" always.
- affected_files: Exact paths from the file list above. Only files that need modification.
- approach: Max 5 steps. Be specific about what to change in each file.
- risks: 0-3 risks. Empty array if straightforward.
- complexity: S = 1-3 files changed, simple logic. M = 3-6 files, moderate logic. L = 6+ files or architectural change.
- estimated_turns: S=10-15, M=20-25, L=30-35. If previous attempts failed, add 5.`;

  try {
    const response = await callLLM("planner", prompt, {
      maxTokens: 2048,
      temperature: 0.3,
      timeout: 25000,
    });

    // Parse JSON — handle markdown code blocks if LLM wraps it
    let jsonStr = response.content.trim();
    const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) jsonStr = codeBlockMatch[1].trim();

    const spec = JSON.parse(jsonStr) as BacklogSpec;

    // Validate required fields
    if (
      !Array.isArray(spec.acceptance_criteria) ||
      !Array.isArray(spec.affected_files) ||
      !Array.isArray(spec.approach) ||
      !["S", "M", "L"].includes(spec.complexity)
    ) {
      console.warn("Spec validation failed — missing required fields");
      return null;
    }

    // Ensure build check is in acceptance criteria
    if (
      !spec.acceptance_criteria.some((c) =>
        c.toLowerCase().includes("build")
      )
    ) {
      spec.acceptance_criteria.push("npx next build passes without errors");
    }

    // Clamp estimated_turns
    spec.estimated_turns = Math.max(
      10,
      Math.min(35, spec.estimated_turns || 20)
    );

    return spec;
  } catch (error) {
    console.warn(
      "Spec generation failed:",
      error instanceof Error ? error.message : "unknown"
    );
    return null;
  }
}
