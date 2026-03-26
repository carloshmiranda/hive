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

> Prioritized improvements for Hive itself. The orchestrator's CEO agent reviews this weekly and can self-assign items during low-activity cycles. Carlos can add items via the dashboard command bar with \`hive: <description>\` or by editing this file directly.
>
> **⚠️  This file is auto-generated from the database.** Use \`POST /api/backlog\` to add new items, not direct file edits.

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

    // Write to file using Node.js fs
    const fs = await import('fs/promises');
    const path = await import('path');

    const backlogPath = path.join(process.cwd(), 'BACKLOG.md');
    await fs.writeFile(backlogPath, markdown, 'utf8');

    console.log(`[backlog-planner] Regenerated BACKLOG.md with ${items.length} items across ${Object.keys(statusGroups).length} statuses`);
  } catch (error) {
    console.error('Failed to regenerate BACKLOG.md:', error instanceof Error ? error.message : 'unknown error');
    throw error;
  }
}

export interface DecomposedSubTask {
  title: string;
  description: string;
  acceptance_criteria: string[];
  affected_files: string[];
  complexity: "S" | "M";
  estimated_turns: number;
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

Respond with ONLY valid JSON array (no markdown, no explanation):
[
  {
    "title": "Short imperative title (max 80 chars)",
    "description": "What to do, which files to modify, and how. 2-4 sentences max.",
    "acceptance_criteria": ["criterion 1", "criterion 2", "npx next build passes"],
    "affected_files": ["src/exact/path.ts"],
    "complexity": "S",
    "estimated_turns": 15
  }
]

Complexity: S = 1-3 files, simple logic (15-20 turns). M = 3-5 files, moderate logic (25-35 turns).
Never output complexity "L" — if a sub-task would be L, break it further.`;

  try {
    const response = await callLLM("decomposer", prompt, {
      maxTokens: 3000,
      temperature: 0.3,
      timeout: 30000,
    });

    let jsonStr = response.content.trim();
    const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) jsonStr = codeBlockMatch[1].trim();

    const subTasks = JSON.parse(jsonStr) as DecomposedSubTask[];

    // Validate
    if (!Array.isArray(subTasks) || subTasks.length < 2 || subTasks.length > 6) {
      console.warn(`[decompose] Invalid sub-task count: ${subTasks?.length}`);
      return [];
    }

    // Validate and sanitize each sub-task
    const valid: DecomposedSubTask[] = [];
    for (const st of subTasks) {
      if (!st.title || !st.description || !Array.isArray(st.acceptance_criteria)) continue;
      // Ensure build check
      if (!st.acceptance_criteria.some(c => c.toLowerCase().includes("build"))) {
        st.acceptance_criteria.push("npx next build passes");
      }
      // Clamp
      st.complexity = st.complexity === "M" ? "M" : "S";
      const subCaps: Record<string, [number, number]> = { S: [15, 25], M: [25, 40] };
      const [subMin, subMax] = subCaps[st.complexity] || [15, 25];
      st.estimated_turns = Math.max(subMin, Math.min(subMax, st.estimated_turns || 20));
      valid.push(st);
    }

    if (valid.length < 2) {
      console.warn(`[decompose] Only ${valid.length} valid sub-tasks after validation`);
      return [];
    }

    console.log(`[decompose] "${item.title}" → ${valid.length} sub-tasks: ${valid.map(s => s.title).join(", ")}`);
    return valid;
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
- estimated_turns: S=15-20, M=25-35, L=35-50. If previous attempts failed, add 10.`;

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

    // Clamp estimated_turns based on complexity
    // S tasks: 15-25 turns, M tasks: 25-40 turns, L tasks: 35-50 turns
    const turnCaps: Record<string, [number, number]> = { S: [15, 25], M: [25, 40], L: [35, 50] };
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

    // 2. Check if title or description mentions a company slug or name (case-insensitive)
    for (const company of companies) {
      const slug = company.slug.toLowerCase();
      const name = company.name.toLowerCase();

      // Direct slug/name mentions
      if (text.includes(slug) || text.includes(name)) {
        return company.slug;
      }
    }

    // 3. Check for company-specific patterns
    for (const company of companies) {
      const slug = company.slug.toLowerCase();
      const name = company.name.toLowerCase();

      // Pattern: "landing page for X", "X's homepage", "deploy X", "fix X website", etc.
      const patterns = [
        new RegExp(`\\blanding page for\\s+${slug}\\b`, 'i'),
        new RegExp(`\\b${slug}'s\\s+(homepage|website|landing)\\b`, 'i'),
        new RegExp(`\\bdeploy\\s+${slug}\\b`, 'i'),
        new RegExp(`\\b${slug}\\s+(website|homepage|landing|app|service)\\b`, 'i'),
        new RegExp(`\\bfix\\s+${slug}\\b`, 'i'),
        new RegExp(`\\bupdate\\s+${slug}\\b`, 'i'),
        new RegExp(`\\blanding page for\\s+${name}\\b`, 'i'),
        new RegExp(`\\b${name}'s\\s+(homepage|website|landing)\\b`, 'i'),
        new RegExp(`\\bdeploy\\s+${name}\\b`, 'i'),
        new RegExp(`\\b${name}\\s+(website|homepage|landing|app|service)\\b`, 'i'),
        new RegExp(`\\bfix\\s+${name}\\b`, 'i'),
        new RegExp(`\\bupdate\\s+${name}\\b`, 'i')
      ];

      for (const pattern of patterns) {
        if (pattern.test(text)) {
          return company.slug;
        }
      }
    }

    // 4. Return null if it's a Hive-level item
    return null;
  } catch (error) {
    console.warn('isCompanySpecific failed:', error instanceof Error ? error.message : 'unknown');
    return null;
  }
}
