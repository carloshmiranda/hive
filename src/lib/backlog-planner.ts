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
 * Filter backlog items to exclude those in cooldown period
 * Also performs cleanup of expired cooldown entries
 */
export function filterBacklogItemsByCooldown(items: BacklogItem[]): BacklogItem[] {
  // Clean up expired entries first
  cleanupFailedItemsCache();

  // Filter out items that are in cooldown
  return items.filter(item => !isBacklogItemInCooldown(item.id));
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
