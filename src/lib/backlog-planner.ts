import { callLLM, callLLMStructuredResponse } from "@/lib/llm";
import { BacklogPlannerResponseSchema, DecomposedSubTasksSchema, type DecomposedSubTask } from "@/lib/agent-schemas";
import { getSettingValue } from "@/lib/settings";
import { isBacklogItemInCooldown } from "@/lib/dispatch";

export interface BacklogSpec {
  acceptance_criteria: string[];
  affected_files: string[];
  approach: string[];
  risks: string[];
  complexity: "S" | "M" | "L";
  estimated_turns: number;
  specialist?: 'frontend' | 'backend' | 'database' | 'devops' | 'security';
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
          Authorization: `Bearer ${ghToken}`,
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
 * Filter backlog items to exclude those in cooldown period.
 * Redis TTL handles expiry — no manual cleanup needed.
 */
export async function filterBacklogItemsByCooldown(items: BacklogItem[]): Promise<BacklogItem[]> {
  const results = await Promise.all(
    items.map(async (item) => ({
      item,
      inCooldown: await isBacklogItemInCooldown(item.id),
    }))
  );
  return results.filter((r) => !r.inCooldown).map((r) => r.item);
}

/**
 * Regenerate BACKLOG.md from the hive_backlog database table
 * Groups items by status and priority for better organization
 */
export async function regenerateBacklogMd(sql: any): Promise<void> {
  if (!sql) {
    console.warn("Cannot regenerate BACKLOG.md: no database connection");
    return;
  }

  try {
    // Fetch all backlog items grouped by status and priority
    const items = await sql`
      SELECT id, priority, title, description, status, notes,
             pr_number, pr_url, completed_at, created_at, theme
      FROM hive_backlog
      ORDER BY
        CASE status
          WHEN 'in_progress' THEN 0
          WHEN 'planning' THEN 1
          WHEN 'dispatched' THEN 2
          WHEN 'ready' THEN 3
          WHEN 'approved' THEN 4
          WHEN 'pr_open' THEN 5
          WHEN 'blocked' THEN 6
          WHEN 'rejected' THEN 7
          WHEN 'done' THEN 8
          ELSE 9
        END,
        CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END,
        created_at ASC
    `;

    // Group items by status
    const statusGroups: Record<string, any[]> = {};
    for (const item of items) {
      if (!statusGroups[item.status]) {
        statusGroups[item.status] = [];
      }
      statusGroups[item.status].push(item);
    }

    // Generate markdown content
    let markdown = `# Backlog

> **⚠️ AUTO-GENERATED — DO NOT EDIT.** This file is a read-only snapshot of the \`hive_backlog\` database table, regenerated on every backlog change.
>
> **Agents:** use \`POST /api/agents/backlog\` (OIDC auth) to create/update items.
> **Claude Code:** use MCP tools \`mcp__hive__hive_backlog_create\` and \`mcp__hive__hive_backlog_update\`.
> **Dashboard:** use the command bar with \`hive: <description>\`.

## Priority Legend
- 🔴 **P0** — Blocking or degrading core functionality
- 🟡 **P1** — Important for next phase, not blocking today
- 🟢 **P2** — Nice to have, improves quality of life
- ⚪ **P3** — Future vision, no urgency

---

`;

    // Helper to format priority emoji
    const formatPriority = (priority: string) => {
      switch (priority) {
        case 'P0': return '🔴 P0';
        case 'P1': return '🟡 P1';
        case 'P2': return '🟢 P2';
        case 'P3': return '⚪ P3';
        default: return priority;
      }
    };

    // Helper to format item with status indicators
    const formatItem = (item: any) => {
      const priority = formatPriority(item.priority);
      const title = item.title;
      const description = item.description || '';

      let statusIndicator = '';
      if (item.status === 'done') {
        const date = item.completed_at ? new Date(item.completed_at).toISOString().split('T')[0] : 'unknown';
        statusIndicator = ` (DONE — ${date})`;
      } else if (item.status === 'pr_open' && item.pr_number) {
        statusIndicator = ` — [PR #${item.pr_number}]${item.pr_url ? `(${item.pr_url})` : ''}`;
      } else if (item.status === 'blocked') {
        statusIndicator = ' — BLOCKED';
      }

      return `### ${priority} — ${title}${statusIndicator}\n${description}\n\n`;
    };

    // Add sections in order
    const sectionOrder = [
      { status: 'in_progress', title: 'In Progress', description: 'Items currently being worked on' },
      { status: 'planning', title: 'Planning', description: 'Spec generation in progress' },
      { status: 'dispatched', title: 'Dispatched', description: 'Sent to Engineer agents' },
      { status: 'ready', title: 'Up Next', description: 'Ready to be dispatched' },
      { status: 'approved', title: 'Approved', description: 'Approved and ready for planning/dispatch' },
      { status: 'pr_open', title: 'Awaiting Merge', description: 'PRs created, awaiting review/merge' },
      { status: 'blocked', title: 'Blocked', description: 'Need manual intervention' },
      { status: 'done', title: 'Recently Completed', description: 'Completed items (last 30 days)' }
    ];

    for (const section of sectionOrder) {
      const sectionItems = statusGroups[section.status] || [];

      // For "done" items, only show recent completions (last 30 days)
      const filteredItems = section.status === 'done'
        ? sectionItems.filter(item => {
            if (!item.completed_at) return false;
            const completedDate = new Date(item.completed_at);
            const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
            return completedDate > thirtyDaysAgo;
          }).slice(0, 10) // Only show last 10 completed items
        : sectionItems;

      if (filteredItems.length > 0) {
        markdown += `## ${section.title}\n<!-- ${section.description} -->\n\n`;

        for (const item of filteredItems) {
          markdown += formatItem(item);
        }

        markdown += '---\n\n';
      }
    }

    // Add footer with generation timestamp
    const timestamp = new Date().toISOString().replace('T', ' ').split('.')[0] + ' UTC';
    markdown += `---\n\n*Generated from database at ${timestamp}*\n`;

    // Commit to GitHub via Contents API (fs.writeFile doesn't persist on Vercel)
    const { getGitHubToken } = await import("@/lib/github-app");
    const ghPat = await getGitHubToken().catch(() => null) || process.env.GH_PAT;
    if (!ghPat) {
      console.warn("[backlog-planner] No GitHub token — skipping BACKLOG.md commit");
      return;
    }

    const repo = "carloshmiranda/hive";
    const filePath = "BACKLOG.md";
    const apiUrl = `https://api.github.com/repos/${repo}/contents/${filePath}`;

    // Get current file SHA (required for update)
    const getResp = await fetch(apiUrl, {
      headers: { Authorization: `Bearer ${ghPat}`, Accept: "application/vnd.github.v3+json" },
    });
    const currentFile = getResp.ok ? await getResp.json() : null;
    const sha = currentFile?.sha;

    // Commit the new content
    const putResp = await fetch(apiUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${ghPat}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: "chore: auto-regenerate BACKLOG.md from database",
        content: Buffer.from(markdown, "utf8").toString("base64"),
        ...(sha ? { sha } : {}),
      }),
    });

    if (!putResp.ok) {
      const err = await putResp.text();
      console.error(`[backlog-planner] GitHub commit failed (${putResp.status}): ${err}`);
      return;
    }

    console.log(`[backlog-planner] Committed BACKLOG.md to GitHub with ${items.length} items across ${Object.keys(statusGroups).length} statuses`);
  } catch (error) {
    console.error('Failed to regenerate BACKLOG.md:', error instanceof Error ? error.message : 'unknown error');
    throw error;
  }
}

/**
 * LLM-assisted task decomposition — breaks a large/failed task into
 * independently deliverable sub-tasks, each with its own spec.
 * Unlike dumb chunking, this produces sub-tasks that are single-responsibility,
 * testable, and ordered by dependency.
 */
export async function decomposeTask(
  item: BacklogItem,
  spec: BacklogSpec | null,
  reason: string,
  sql?: any
): Promise<DecomposedSubTask[]> {
  const files = await getFileTree();
  const relevantFiles = findRelevantFiles(files, item.title, item.description);

  const topLevel = files
    .filter((f: string) => f.split("/").length <= 3 && f.startsWith("src/app/api/"))
    .slice(0, 30);
  const fileContext = [...new Set([...relevantFiles, ...topLevel])].sort().join("\n");

  const specContext = spec
    ? `\nEXISTING SPEC (failed to complete in one shot):\n- Approach: ${spec.approach.join("; ")}\n- Affected files: ${spec.affected_files.join(", ")}\n- Complexity: ${spec.complexity}\n- Risks: ${spec.risks.join("; ") || "none"}`
    : "";

  const prompt = `You are a senior engineer decomposing a task that is too large for a single agent session (max 35 turns).

TASK: ${item.title}
DESCRIPTION:
${item.description}
${specContext}

DECOMPOSITION REASON: ${reason}

RELEVANT FILES IN CODEBASE:
${fileContext}

Break this into 2-4 INDEPENDENT sub-tasks. Each sub-task must be completable in a single session (10-20 turns).

Rules for sub-tasks:
1. SINGLE RESPONSIBILITY — each sub-task does ONE thing (one feature, one file group, one concern)
2. INDEPENDENTLY TESTABLE — each sub-task can be verified on its own ("npx next build passes" + specific check)
3. ORDERED BY DEPENDENCY — if sub-task B depends on A, list A first
4. SPECIFIC FILES — list exact files each sub-task modifies (from the file list above)
5. CONCRETE ACCEPTANCE CRITERIA — not "implement X" but "function Y in file Z returns correct results for input W"
6. NO BUNDLING — if you write "implement X, Y, and Z", that's 3 sub-tasks, not 1

Respond with a JSON object wrapping the array:
{
  "sub_tasks": [
    {
      "title": "Short imperative title (max 80 chars)",
      "description": "What to do, which files to modify, and how. 2-4 sentences max.",
      "acceptance_criteria": ["criterion 1", "criterion 2", "npx next build passes"],
      "affected_files": ["src/exact/path.ts"],
      "complexity": "S",
      "estimated_turns": 15
    }
  ]
}

CRITICAL SIZE CONSTRAINT: Each sub-task MUST be completable in ≤25 turns by a Claude Sonnet agent.
Complexity: S = 1-3 files, simple logic (10-20 turns). NEVER output M or L — if a sub-task touches 4+ files or needs 20+ turns, split it further.
A sub-task that modifies more than 3 files or adds more than 150 lines of code is TOO BIG.`;

  try {
    const response = await callLLMStructuredResponse("decomposer", prompt, {
      maxTokens: 3000,
      temperature: 0.3,
      timeout: 30000,
      schema: DecomposedSubTasksSchema,
    });

    const subTasks = response.structured?.sub_tasks;

    if (!Array.isArray(subTasks) || subTasks.length < 2) {
      console.warn(`[decompose] Invalid sub-task count: ${subTasks?.length}`);
      return [];
    }

    // Sanitize — enforce clamping rules post-schema-validation
    for (const st of subTasks) {
      if (!st.acceptance_criteria.some((c: string) => c.toLowerCase().includes("build"))) {
        st.acceptance_criteria.push("npx next build passes");
      }
      st.complexity = "S";
      st.estimated_turns = Math.max(8, Math.min(25, st.estimated_turns));
    }

    console.log(`[decompose] "${item.title}" → ${subTasks.length} sub-tasks: ${subTasks.map(s => s.title).join(", ")}`);
    return subTasks;
  } catch (error) {
    console.warn("Task decomposition failed:", error instanceof Error ? error.message : "unknown");
    return [];
  }
}

/**
 * Detect specialist type from affected files using pattern matching rules
 */
function detectSpecialistFromFiles(affectedFiles: string[]): 'frontend' | 'backend' | 'database' | 'devops' | 'security' {
  for (const file of affectedFiles) {
    const fileLower = file.toLowerCase();

    // Frontend patterns
    if (file.startsWith('src/app/') ||
        fileLower.includes('page') ||
        fileLower.includes('layout') ||
        fileLower.includes('component')) {
      return 'frontend';
    }

    // DevOps patterns
    if (file.startsWith('.github/workflows/')) {
      return 'devops';
    }

    // Security patterns (check before database since auth files are in src/lib/)
    if (file.startsWith('src/lib/') &&
        (fileLower.includes('security') ||
         fileLower.includes('auth') ||
         fileLower.includes('encrypt'))) {
      return 'security';
    }

    // Database patterns
    if (file === 'schema.sql' ||
        (file.startsWith('src/lib/') &&
         (fileLower.includes('db') ||
          fileLower.includes('sql') ||
          fileLower.includes('database') ||
          fileLower.includes('migration')))) {
      return 'database';
    }
  }

  // Default to backend
  return 'backend';
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
Given a backlog task, produce a structured implementation spec and task analysis.

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

Analyze this task and provide:

1. TASK ANALYSIS:
   - complexity: S = 1-3 files, simple logic; M = 3-6 files, moderate logic; L = 6+ files, architectural change
   - estimated_turns: S=15-20, M=25-35, L=35-50 (add 10 if previous attempts failed)
   - specialist_required: frontend/backend/database/devops/security (if needed)
   - dependencies: other tasks/features this depends on

2. IMPLEMENTATION SPEC:
   - acceptance_criteria: 3-5 concrete, testable conditions (include "npx next build passes")
   - affected_files: exact paths from file list above, only files needing modification
   - approach: max 5 specific steps describing what to change in each file
   - risks: 0-3 potential risks or complications

3. READINESS ASSESSMENT:
   - decomposition_needed: true if task is too large/complex for single session
   - ready_for_dispatch: true if can be implemented immediately

The response will be automatically parsed as structured JSON.`;

  try {
    let response = await callLLMStructuredResponse("planner", prompt, {
      maxTokens: 2048,
      temperature: 0.3,
      timeout: 45000,
      schema: BacklogPlannerResponseSchema,
    }).catch(async (firstErr: any) => {
      // Retry once with a faster model (no schema — parse raw JSON as fallback)
      console.warn("[backlog-planner] First spec attempt failed, retrying with fallback model:", firstErr?.message || firstErr);
      return callLLM("ops", prompt, {
        maxTokens: 2048,
        temperature: 0.3,
        timeout: 30000,
      });
    });

    // Use structured output when available, fall back to JSON.parse for the retry path
    const plannerResponse = ("structured" in response && response.structured) ? response.structured : JSON.parse(response.content);

    // Extract the spec from the structured response
    const spec: BacklogSpec = {
      acceptance_criteria: plannerResponse.spec.acceptance_criteria,
      affected_files: plannerResponse.spec.affected_files,
      approach: plannerResponse.spec.approach,
      risks: plannerResponse.spec.risks,
      complexity: plannerResponse.task_analysis.complexity,
      estimated_turns: plannerResponse.task_analysis.estimated_turns,
      specialist: plannerResponse.task_analysis.specialist_required,
    };

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

    // Clamp estimated_turns based on complexity (conservative — continuation extends dynamically)
    // S tasks: 10-20 turns, M tasks: 20-35 turns, L tasks: 30-45 turns
    const turnCaps: Record<string, [number, number]> = { S: [10, 20], M: [20, 35], L: [30, 45] };
    const [minTurns, maxTurns] = turnCaps[spec.complexity] || [15, 35];
    spec.estimated_turns = Math.max(
      minTurns,
      Math.min(maxTurns, spec.estimated_turns || 25)
    );

    // Detect specialist from affected_files
    spec.specialist = detectSpecialistFromFiles(spec.affected_files);

    return spec;
  } catch (error) {
    console.warn(
      "Spec generation failed:",
      error instanceof Error ? error.message : "unknown"
    );
    return null;
  }
}

export interface CompanyTaskSpec {
  acceptance_criteria: string[];
  files_allowed: string[];
  files_forbidden: string[];
  approach: string[];
  complexity: "S" | "M";
  estimated_turns: number;
  specialist?: string;
}

/**
 * Generate a structured spec for a company task that lacks one.
 * Uses the same LLM planning approach as generateSpec() for Hive backlog items,
 * but tailored for company repos (uses company file tree, not Hive file tree).
 */
export async function generateCompanyTaskSpec(
  task: { id: string; title: string; description: string; acceptance?: string },
  company: { slug: string; github_repo?: string; description?: string },
): Promise<CompanyTaskSpec | null> {
  // Build file context from company repo if available
  let fileContext = "No file tree available — infer from task description.";
  if (company.github_repo) {
    const ghToken = await getSettingValue("github_token");
    if (ghToken) {
      try {
        const res = await fetch(
          `https://api.github.com/repos/${company.github_repo}/git/trees/main?recursive=1`,
          {
            headers: {
              Authorization: `Bearer ${ghToken}`,
              Accept: "application/vnd.github.v3+json",
            },
            signal: AbortSignal.timeout(8000),
          }
        );
        if (res.ok) {
          const data = await res.json();
          const files = (data.tree || [])
            .filter((f: { type: string; path: string }) =>
              f.type === "blob" &&
              (f.path.startsWith("src/") || f.path.endsWith(".md") || f.path === "package.json")
            )
            .map((f: { path: string }) => f.path)
            .slice(0, 100);
          if (files.length > 0) {
            fileContext = files.join("\n");
          }
        }
      } catch { /* use fallback */ }
    }
  }

  const prompt = `You are a technical planner for a Next.js TypeScript company called "${company.slug}".
Given an engineering task from the CEO, produce a bounded implementation spec for an Engineer agent.

TASK: ${task.title}
DESCRIPTION: ${task.description}
${task.acceptance ? `ACCEPTANCE CRITERIA (from CEO): ${task.acceptance}` : ""}
COMPANY: ${company.slug} — ${company.description || "N/A"}

FILES IN CODEBASE:
${fileContext}

Produce a JSON spec with:
1. acceptance_criteria: 3-5 concrete, testable conditions (include "Build passes without errors")
2. files_allowed: glob patterns the Engineer CAN modify (e.g., ["src/app/blog/**"])
3. files_forbidden: glob patterns the Engineer must NOT touch (e.g., ["middleware.ts", "src/lib/auth*"])
4. approach: 2-4 specific steps describing what to change
5. complexity: "S" (1-3 files, 10-20 turns) or "M" (3-6 files, 20-30 turns). Never "L".
6. estimated_turns: 10-30
7. specialist: frontend|backend|database|devops|security|content

Respond with ONLY valid JSON (no markdown):
{
  "acceptance_criteria": ["..."],
  "files_allowed": ["..."],
  "files_forbidden": ["..."],
  "approach": ["..."],
  "complexity": "S",
  "estimated_turns": 15,
  "specialist": "backend"
}`;

  try {
    const response = await callLLM("planner", prompt, {
      maxTokens: 1500,
      temperature: 0.3,
      timeout: 30000,
    }).catch(async (firstErr: any) => {
      console.warn("[backlog-planner] Company task spec first attempt failed, retrying:", firstErr?.message || firstErr);
      return callLLM("ops", prompt, {
        maxTokens: 1500,
        temperature: 0.3,
        timeout: 20000,
      });
    });

    let jsonStr = response.content.trim();
    const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) jsonStr = codeBlockMatch[1].trim();

    const spec = JSON.parse(jsonStr) as CompanyTaskSpec;

    // Validate required fields
    if (!Array.isArray(spec.acceptance_criteria) || !Array.isArray(spec.files_allowed)) {
      return null;
    }

    // Ensure build check
    if (!spec.acceptance_criteria.some(c => c.toLowerCase().includes("build"))) {
      spec.acceptance_criteria.push("Build passes without errors");
    }

    // Clamp complexity to S or M
    if (spec.complexity !== "S" && spec.complexity !== "M") {
      spec.complexity = "M";
    }

    // Clamp turns
    spec.estimated_turns = Math.max(10, Math.min(30, spec.estimated_turns || 15));

    return spec;
  } catch (error) {
    console.warn("[backlog-planner] Company task spec generation failed:", error instanceof Error ? error.message : "unknown");
    return null;
  }
}

/**
 * Detect if a backlog item is about a specific company rather than Hive itself.
 * Returns the company slug if detected, null if it's a Hive-level item.
 */
export async function isCompanySpecific(
  title: string,
  description: string,
  sql?: any
): Promise<string | null> {
  if (!sql) {
    return null;
  }

  try {
    // 1. Query company slugs and names from DB
    const companies = await sql`
      SELECT slug, name FROM companies WHERE status != 'killed'
    `.catch(() => []);

    const text = `${title} ${description}`.toLowerCase();

    // 1a. Skip classification if text is clearly about Hive infrastructure.
    // Covers: agent orchestration, dispatch, scheduling, LLM routing, DB schema,
    // backlog management, and Hive-specific system components.
    const INFRA_CONTEXT = /\b(dispatch(ing)?|sentinel|circuit.?breaker|dedup|orchestrat|regression|infra_repair|healer|evolver|hive.?backlog|agent_actions|agent.?prompt|engineer failures|failure rate|backlog.?planner|backlog.?dispatch|openrouter|rate.?limit|llm|neon|schema\.sql|schema.?map|settings table|provisioning|boilerplate|template(s)?|playbook|cron.?job|webhook|github.?actions|repository_dispatch|worker.?agent|brain.?agent|health.?gate|turn.?budget|cooldown|circuit|oidc|qstash|upstash|vercel.?blob|edge.?config|mcp.?server|mcp.?tool)\b/i;
    if (INFRA_CONTEXT.test(text)) {
      return null;
    }

    // 1b. Skip if text references Hive codebase paths or files
    const HIVE_PATH = /\b(src\/lib\/|src\/app\/api\/|\.github\/workflows\/|schema\.sql|backlog-planner|sentinel-dispatch|agent-schemas|chain-dispatch|llm\.ts|settings\.ts|dispatch\.ts)\b/i;
    if (HIVE_PATH.test(text)) {
      return null;
    }

    // 1c. Skip if text explicitly frames this as Hive-level work
    const HIVE_FRAMING = /\b(in hive|hive'?s?|for hive|hive codebase|hive repo|hive system|hive agent|hive infra|across companies|cross-company|all companies|portfolio)\b/i;
    if (HIVE_FRAMING.test(text)) {
      return null;
    }

    // 2. Check if title or description mentions a company slug or name as the subject.
    // Use word boundaries to avoid false positives (e.g. "portfolio" matching "flolio").
    // Require the company name to appear in a subject/action position — not just incidentally.
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    for (const company of companies) {
      const slug = company.slug.toLowerCase();
      const name = company.name.toLowerCase();
      const slugRe = new RegExp(`\\b${esc(slug)}\\b`);
      const nameRe = new RegExp(`\\b${esc(name)}\\b`);

      const mentionsCompany = slugRe.test(text) || nameRe.test(text);
      if (!mentionsCompany) continue;

      // Only return company match if the mention is in a company-work context.
      // Patterns that indicate the company IS the work target (not just a reference):
      //   - "for <company>", "in <company>", "<company>'s <site|app|blog>", "<action> <company>"
      const COMPANY_SUBJECT_PATTERNS = [
        // "for flolio", "in senhorio"
        new RegExp(`\\b(for|in|to|at)\\s+${esc(slug)}\\b`, 'i'),
        new RegExp(`\\b(for|in|to|at)\\s+${esc(name)}\\b`, 'i'),
        // "flolio's website/blog/app"
        new RegExp(`\\b${esc(slug)}'s?\\s+(website|homepage|blog|app|landing|product|service|repo|codebase)\\b`, 'i'),
        new RegExp(`\\b${esc(name)}'s?\\s+(website|homepage|blog|app|landing|product|service|repo|codebase)\\b`, 'i'),
        // action verbs targeting the company
        new RegExp(`\\b(deploy|fix|build|launch|create|setup|configure|update|migrate|scaffold)\\s+(the\\s+)?${esc(slug)}\\b`, 'i'),
        new RegExp(`\\b(deploy|fix|build|launch|create|setup|configure|update|migrate|scaffold)\\s+(the\\s+)?${esc(name)}\\b`, 'i'),
        // company + product context
        new RegExp(`\\b${esc(slug)}\\s+(website|homepage|landing|app|service|blog|product|feature|page|route|api)\\b`, 'i'),
        new RegExp(`\\b${esc(name)}\\s+(website|homepage|landing|app|service|blog|product|feature|page|route|api)\\b`, 'i'),
      ];

      const isSubjectMatch = COMPANY_SUBJECT_PATTERNS.some(p => p.test(text));
      if (isSubjectMatch) {
        return company.slug;
      }
    }

    // 3. Return null if it's a Hive-level item (no strong company signal found)
    return null;
  } catch (error) {
    console.warn('isCompanySpecific failed:', error instanceof Error ? error.message : 'unknown');
    return null;
  }
}
