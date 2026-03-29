/**
 * GitHub Issues integration for work tracking (ADR-031 Phase 2).
 *
 * Creates and manages GitHub Issues as the canonical human-facing work tracker.
 * - Hive backlog items → Issues in carloshmiranda/hive
 * - Company tasks → Issues in the company's own repo
 *
 * DB retains operational metadata (dispatch_id, timing, metrics).
 * GitHub Issues are the visibility layer for Carlos and agents.
 */

import { getGitHubToken } from "@/lib/github-app";
import { getSettingValue } from "@/lib/settings";

const HIVE_REPO = "carloshmiranda/hive";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface IssueResult {
  number: number;
  id: number; // internal ID needed for sub-issues API
  url: string;
}

interface DecompositionContext {
  goal: string;
  constraints: string[];
  decisions: string[];
  file_manifest: Record<string, string>; // filepath -> "Modified by sub-task N"
  sub_tasks: Array<{
    id: string;
    github_issue?: number;
    status: string;
    title: string;
    summary: string | null;
  }>;
  failure_history: string[];
}

// ---------------------------------------------------------------------------
// Label mappings
// ---------------------------------------------------------------------------

function backlogLabels(): string[] {
  return ["hive-backlog"];
}

function companyTaskLabels(task: {
  priority: number;
  category: string;
  source: string;
}): string[] {
  const labels: string[] = ["company-task"];
  labels.push(`priority:p${task.priority}`);
  if (task.category) labels.push(`type:${task.category}`);
  if (task.source) labels.push(`source:${task.source}`);
  return labels;
}

// ---------------------------------------------------------------------------
// Core: Create Issue
// ---------------------------------------------------------------------------

async function createIssue(
  repo: string,
  title: string,
  body: string,
  labels: string[]
): Promise<IssueResult | null> {
  const token = await getGitHubToken().catch(() => null);
  if (!token) return null;

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
      method: "POST",
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title, body, labels }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      console.warn(
        `[github-issues] Failed to create issue in ${repo}: ${res.status}`
      );
      return null;
    }

    const data = await res.json();
    return { number: data.number, id: data.id, url: data.html_url };
  } catch (e: any) {
    console.warn(
      `[github-issues] Error creating issue in ${repo}: ${e?.message || e}`
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Core: Update Issue labels (for status transitions)
// ---------------------------------------------------------------------------

async function updateIssueLabels(
  repo: string,
  issueNumber: number,
  addLabels: string[],
  removeLabels: string[]
): Promise<void> {
  const token = await getGitHubToken().catch(() => null);
  if (!token) return;

  try {
    // Remove old phase labels
    for (const label of removeLabels) {
      await fetch(
        `https://api.github.com/repos/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `token ${token}`,
            Accept: "application/vnd.github+json",
          },
          signal: AbortSignal.timeout(5000),
        }
      ).catch(() => {});
    }

    // Add new labels
    if (addLabels.length > 0) {
      await fetch(
        `https://api.github.com/repos/${repo}/issues/${issueNumber}/labels`,
        {
          method: "POST",
          headers: {
            Authorization: `token ${token}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ labels: addLabels }),
          signal: AbortSignal.timeout(5000),
        }
      ).catch(() => {});
    }
  } catch (e: any) {
    console.warn(
      `[github-issues] Error updating labels on ${repo}#${issueNumber}: ${e?.message || e}`
    );
  }
}

// ---------------------------------------------------------------------------
// Core: Close Issue
// ---------------------------------------------------------------------------

async function closeIssue(
  repo: string,
  issueNumber: number,
  comment?: string
): Promise<void> {
  const token = await getGitHubToken().catch(() => null);
  if (!token) return;

  try {
    if (comment) {
      await fetch(
        `https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`,
        {
          method: "POST",
          headers: {
            Authorization: `token ${token}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ body: comment }),
          signal: AbortSignal.timeout(5000),
        }
      ).catch(() => {});
    }

    await fetch(
      `https://api.github.com/repos/${repo}/issues/${issueNumber}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ state: "closed" }),
        signal: AbortSignal.timeout(5000),
      }
    );
  } catch (e: any) {
    console.warn(
      `[github-issues] Error closing ${repo}#${issueNumber}: ${e?.message || e}`
    );
  }
}

// ---------------------------------------------------------------------------
// Public: Create Issue for Hive backlog item
// ---------------------------------------------------------------------------

export async function createBacklogIssue(item: {
  id: string;
  title: string;
  description: string;
  priority: string;
  category: string;
  theme?: string | null;
}): Promise<IssueResult | null> {
  const body = [
    `## ${item.title}`,
    ``,
    item.description,
    ``,
    `---`,
    `**Priority:** ${item.priority} | **Category:** ${item.category}${item.theme ? ` | **Theme:** ${item.theme}` : ""}`,
    `**Backlog ID:** \`${item.id}\``,
    ``,
    `*Auto-created by Hive work tracker*`,
  ].join("\n");

  const labels = backlogLabels();
  return createIssue(HIVE_REPO, `${item.priority}: ${item.title}`, body, labels);
}

// ---------------------------------------------------------------------------
// Public: Create Issue for company task (in company repo)
// ---------------------------------------------------------------------------

export async function createCompanyTaskIssue(
  githubRepo: string,
  task: {
    id: string;
    title: string;
    description: string;
    priority: number;
    category: string;
    source: string;
    acceptance?: string | null;
  },
  companySlug: string
): Promise<IssueResult | null> {
  const body = [
    `## ${task.title}`,
    ``,
    task.description,
    ``,
    task.acceptance ? `### Acceptance Criteria\n${task.acceptance}\n` : "",
    `---`,
    `**Priority:** P${task.priority} | **Category:** ${task.category} | **Source:** ${task.source}`,
    `**Task ID:** \`${task.id}\``,
    ``,
    `*Auto-created by Hive CEO for ${companySlug}*`,
  ]
    .filter(Boolean)
    .join("\n");

  const labels = companyTaskLabels(task);
  return createIssue(
    githubRepo,
    `[P${task.priority}] ${task.title}`,
    body,
    labels
  );
}

// ---------------------------------------------------------------------------
// Public: Sync backlog status → GitHub Issue labels
// ---------------------------------------------------------------------------

const PHASE_LABELS = [
  "phase:ready",
  "phase:dispatched",
  "phase:in-progress",
  "phase:pr-open",
  "phase:done",
  "phase:blocked",
];

export async function syncBacklogStatus(
  issueNumber: number,
  newStatus: string
): Promise<void> {
  const phaseLabel = `phase:${newStatus.replace("_", "-")}`;
  if (!PHASE_LABELS.includes(phaseLabel)) return;

  // If done or rejected, close the issue
  if (newStatus === "done") {
    await closeIssue(HIVE_REPO, issueNumber, "Completed and merged.");
    return;
  }

  if (newStatus === "rejected") {
    await closeIssue(HIVE_REPO, issueNumber, "Rejected — no longer needed.");
    return;
  }

  // Otherwise update labels
  const removeLabels = PHASE_LABELS.filter((l) => l !== phaseLabel);
  await updateIssueLabels(HIVE_REPO, issueNumber, [phaseLabel], removeLabels);
}

// ---------------------------------------------------------------------------
// Public: Sync company task status → GitHub Issue labels
// ---------------------------------------------------------------------------

export async function syncCompanyTaskStatus(
  githubRepo: string,
  issueNumber: number,
  newStatus: string
): Promise<void> {
  if (newStatus === "done") {
    await closeIssue(githubRepo, issueNumber, "Task completed.");
    return;
  }

  if (newStatus === "dismissed") {
    await closeIssue(githubRepo, issueNumber, "Task dismissed — no longer needed.");
    return;
  }

  const phaseLabel = `phase:${newStatus.replace("_", "-")}`;
  const allPhases = [
    "phase:proposed",
    "phase:approved",
    "phase:in-progress",
    "phase:done",
  ];
  const removeLabels = allPhases.filter((l) => l !== phaseLabel);
  await updateIssueLabels(githubRepo, issueNumber, [phaseLabel], removeLabels);
}

// ---------------------------------------------------------------------------
// Public: List recently merged PRs in a repo (for Sentinel polling)
// ---------------------------------------------------------------------------

export async function getRecentlyMergedPRs(
  repo: string,
  sinceDays: number = 1
): Promise<
  Array<{
    number: number;
    title: string;
    body: string;
    merged_at: string;
    head_ref: string;
  }>
> {
  const token = await getGitHubToken().catch(() => null);
  if (!token) return [];

  try {
    const since = new Date(
      Date.now() - sinceDays * 86400000
    ).toISOString();

    const res = await fetch(
      `https://api.github.com/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=30`,
      {
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github+json",
        },
        signal: AbortSignal.timeout(10000),
      }
    );

    if (!res.ok) return [];
    const pulls = await res.json();

    return pulls
      .filter(
        (pr: any) =>
          pr.merged_at && new Date(pr.merged_at) > new Date(since)
      )
      .map((pr: any) => ({
        number: pr.number,
        title: pr.title,
        body: pr.body || "",
        merged_at: pr.merged_at,
        head_ref: pr.head?.ref || "",
      }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Public: Link sub-issue to parent (GitHub Sub-Issues API, GA)
// ---------------------------------------------------------------------------

export async function linkSubIssue(
  repo: string,
  parentIssueNumber: number,
  childIssueInternalId: number
): Promise<boolean> {
  const token = await getGitHubToken().catch(() => null);
  if (!token) return false;

  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/issues/${parentIssueNumber}/sub_issues`,
      {
        method: "POST",
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sub_issue_id: childIssueInternalId }),
        signal: AbortSignal.timeout(10000),
      }
    );

    if (!res.ok) {
      console.warn(
        `[github-issues] Failed to link sub-issue to ${repo}#${parentIssueNumber}: ${res.status}`
      );
      return false;
    }
    return true;
  } catch (e: any) {
    console.warn(
      `[github-issues] Error linking sub-issue: ${e?.message || e}`
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public: Get internal issue ID from issue number (needed for sub-issues API)
// ---------------------------------------------------------------------------

export async function getIssueInternalId(
  repo: string,
  issueNumber: number
): Promise<number | null> {
  const token = await getGitHubToken().catch(() => null);
  if (!token) return null;

  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/issues/${issueNumber}`,
      {
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github+json",
        },
        signal: AbortSignal.timeout(5000),
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.id;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public: Create decomposition context document
// ---------------------------------------------------------------------------

export function createDecompositionContext(
  parent: { title: string; description: string; notes?: string | null; spec?: any },
  subTasks: Array<{ id: string; title: string; github_issue?: number }>
): DecompositionContext {
  // Extract failure history from parent notes
  const failureHistory: string[] = [];
  const attemptMatches = (parent.notes || "").matchAll(/\[attempt (\d+)\]([^\[]*)/g);
  for (const m of attemptMatches) {
    failureHistory.push(`Attempt ${m[1]}:${m[2].trim()}`);
  }

  return {
    goal: parent.description || parent.title,
    constraints: parent.spec?.risks || [],
    decisions: parent.spec?.approach || [],
    file_manifest: {},
    sub_tasks: subTasks.map((st) => ({
      id: st.id,
      github_issue: st.github_issue,
      status: "ready",
      title: st.title,
      summary: null,
    })),
    failure_history: failureHistory,
  };
}

// ---------------------------------------------------------------------------
// Public: Format decomposition context for Engineer prompt injection
// ---------------------------------------------------------------------------

export function formatDecompositionContextForPrompt(
  ctx: DecompositionContext,
  currentSubTaskTitle: string
): string {
  const lines: string[] = [
    "## Decomposition Context (from parent task)",
    "",
    `**Overall Goal:** ${ctx.goal}`,
    "",
  ];

  if (ctx.failure_history.length > 0) {
    lines.push("**Previous Attempts (learn from these):**");
    for (const f of ctx.failure_history) lines.push(`- ${f}`);
    lines.push("");
  }

  if (ctx.constraints.length > 0) {
    lines.push("**Constraints:**");
    for (const c of ctx.constraints) lines.push(`- ${c}`);
    lines.push("");
  }

  if (ctx.decisions.length > 0) {
    lines.push("**Approach decisions already made:**");
    for (const d of ctx.decisions) lines.push(`- ${d}`);
    lines.push("");
  }

  const completedSiblings = ctx.sub_tasks.filter(
    (st) => st.status === "done" && st.title !== currentSubTaskTitle
  );
  if (completedSiblings.length > 0) {
    lines.push("**Completed sibling tasks (already done — don't redo):**");
    for (const s of completedSiblings) {
      lines.push(`- ${s.title}${s.summary ? `: ${s.summary}` : ""}`);
    }
    lines.push("");
  }

  const fileEntries = Object.entries(ctx.file_manifest);
  if (fileEntries.length > 0) {
    lines.push("**Files already modified by other sub-tasks:**");
    for (const [file, note] of fileEntries) {
      lines.push(`- \`${file}\` — ${note}`);
    }
    lines.push("");
  }

  const pendingSiblings = ctx.sub_tasks.filter(
    (st) =>
      st.status !== "done" &&
      st.status !== "rejected" &&
      st.title !== currentSubTaskTitle
  );
  if (pendingSiblings.length > 0) {
    lines.push("**Other pending sub-tasks (don't do their work):**");
    for (const s of pendingSiblings) lines.push(`- ${s.title}`);
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Public: Extract "Fixes #N" references from PR body
// ---------------------------------------------------------------------------

export function extractFixesReferences(text: string): number[] {
  const pattern =
    /(?:fix(?:es)?|close[sd]?|resolve[sd]?)\s+#(\d+)/gi;
  const matches: number[] = [];
  let match;
  while ((match = pattern.exec(text)) !== null) {
    matches.push(parseInt(match[1], 10));
  }
  return [...new Set(matches)];
}
