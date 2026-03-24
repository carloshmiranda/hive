// Backlog priority scoring engine
// Hybrid of WSJF (cost of delay), RICE (reach/impact), and dependency blocking.
// All signals computed from DB data — no subjective ratings needed.

export interface BacklogItem {
  id: string;
  priority: string;       // P0-P3
  title: string;
  description: string;
  category: string;       // bugfix, feature, refactor, infra, quality, research
  task_type: string;      // ui, api, infra, content, config, security
  status: string;
  created_at: string;
  notes?: string;         // attempt tracking, dispatch notes
}

export interface BacklogSignals {
  relatedErrors: number;        // errors matching this item's keywords in last 7d
  companiesAffected: number;    // how many companies are impacted
  systemFailureRate: number;    // overall agent failure rate (0-1)
  hasSimilarFailed: boolean;    // similar item attempted and failed in last 30d
  blocksAgents: string[];       // which agents this blocks (e.g., ['engineer', 'growth'])
  daysSinceCreated: number;     // age of the item
  totalCompanies: number;       // total active companies (for normalization)
  previousAttempts: number;     // how many times this item has been attempted and failed
  taskTypeSuccessRate: number;  // Engineer success rate for this task type (0-1)
}

export interface ScoredBacklogItem extends BacklogItem {
  priority_score: number;
  score_breakdown: {
    impact: number;
    urgency: number;
    reliability: number;
    blocking: number;
    novelty: number;
  };
}

// Priority base scores — the manual priority is a strong signal
const PRIORITY_BASE: Record<string, number> = {
  P0: 40, // Critical blocker
  P1: 25, // Important
  P2: 12, // Nice to have
  P3: 5,  // Future
};

// Category multipliers — bugfixes and infra are more urgent than features
const CATEGORY_MULTIPLIER: Record<string, number> = {
  bugfix: 1.4,
  infra: 1.3,
  quality: 1.1,
  refactor: 1.0,
  feature: 0.9,
  research: 0.7,
};

export function computeBacklogScore(item: BacklogItem, signals: BacklogSignals): ScoredBacklogItem {
  // 1. IMPACT (0-100, weight 35%)
  // How many companies benefit + is it systemic?
  const companyReach = signals.totalCompanies > 0
    ? (signals.companiesAffected / signals.totalCompanies) * 50
    : 0;
  const systemic = signals.companiesAffected >= 2 ? 25 : 0;
  const categoryBonus = item.category === "infra" ? 15 : item.category === "bugfix" ? 10 : 0;
  const impact = Math.min(100, companyReach + systemic + categoryBonus + PRIORITY_BASE[item.priority] * 0.5);

  // 2. URGENCY (0-100, weight 25%)
  // Age pressure + blocking penalty + error recurrence
  const agePressure = Math.min(30, (signals.daysSinceCreated / 7) * 10);
  const errorRecurrence = Math.min(30, signals.relatedErrors * 3);
  const priorityUrgency = item.priority === "P0" ? 30 : item.priority === "P1" ? 15 : 0;
  const urgency = Math.min(100, agePressure + errorRecurrence + priorityUrgency);

  // 3. RELIABILITY GAP (0-100, weight 20%)
  // How much does the current system hurt from not having this?
  const failureRateImpact = signals.systemFailureRate * 40; // reduced from 60
  const errorDensity = Math.min(30, signals.relatedErrors * 3); // reduced from 40
  // Boost score for task types Engineer is good at, penalize types Engineer struggles with
  const taskTypeBonus = signals.taskTypeSuccessRate > 0.8 ? 20
    : signals.taskTypeSuccessRate > 0.6 ? 10
    : signals.taskTypeSuccessRate < 0.4 ? -10 : 0;
  const reliability = Math.min(100, failureRateImpact + errorDensity + taskTypeBonus);

  // 4. BLOCKING FACTOR (0-100, weight 15%)
  // Does this unblock other work?
  const blockingScore = signals.blocksAgents.length > 0
    ? Math.min(100, signals.blocksAgents.length * 25 + 20)
    : 0;

  // 5. NOVELTY PENALTY (multiplier 0.3-1.0)
  // Deprioritize items that keep failing — let other work go first
  // Each failed attempt reduces score: attempt 1 → 0.7, attempt 2 → 0.5, attempt 3+ → 0.3
  // Also penalizes if a similar (different) item failed recently
  const attemptPenalty = signals.previousAttempts > 0
    ? Math.max(0.3, 1.0 - (signals.previousAttempts * 0.25))
    : 1.0;
  const similarPenalty = signals.hasSimilarFailed ? 0.8 : 1.0;
  const novelty = attemptPenalty * similarPenalty;

  // Weighted sum × category × novelty
  const rawScore = (
    (impact * 0.35) +
    (urgency * 0.25) +
    (reliability * 0.20) +
    (blockingScore * 0.15)
  ) * (CATEGORY_MULTIPLIER[item.category] || 1.0) * novelty;

  // Normalize to 0-100
  const priorityScore = Math.round(Math.min(100, rawScore));

  return {
    ...item,
    priority_score: priorityScore,
    score_breakdown: {
      impact: Math.round(impact),
      urgency: Math.round(urgency),
      reliability: Math.round(reliability),
      blocking: Math.round(blockingScore),
      novelty,
    },
  };
}

// Classify task type based on title and description keywords
export function classifyTaskType(title: string, description: string): string {
  const text = `${title} ${description}`.toLowerCase();

  // UI: frontend, styling, components, pages, forms, buttons
  if (/\b(ui|frontend|component|page|form|button|styling|tailwind|css|layout|responsive|design|modal|dashboard|interface|nav|menu|header|footer)\b/.test(text)) {
    return 'ui';
  }

  // Content: blog, SEO, copy, articles, documentation
  if (/\b(content|blog|seo|copy|article|documentation|docs|text|writing|markdown|meta|keywords|title|description|landing)\b/.test(text)) {
    return 'content';
  }

  // Infrastructure: deployment, database, CI/CD, hosting, monitoring
  if (/\b(infra|infrastructure|deploy|deployment|database|db|hosting|server|monitor|ci|cd|pipeline|docker|kubernetes|aws|vercel|neon|github\s+action|workflow)\b/.test(text)) {
    return 'infra';
  }

  // Security: auth, encryption, validation, CSRF, XSS, SQL injection
  if (/\b(security|auth|authentication|authorization|encryption|validation|csrf|xss|sql\s+injection|sanitize|secure|vulnerability|permissions)\b/.test(text)) {
    return 'security';
  }

  // Config: settings, environment, configuration, env vars
  if (/\b(config|configuration|settings|env|environment|variables|secret|key|token|credentials|setup)\b/.test(text)) {
    return 'config';
  }

  // Default to API for backend logic, endpoints, database operations
  return 'api';
}

// Determine which agents a backlog item might block based on keywords
export function detectBlockedAgents(title: string, description: string): string[] {
  const text = `${title} ${description}`.toLowerCase();
  const blocked: string[] = [];

  if (/engineer|build|provision|scaffold|deploy/.test(text)) blocked.push("engineer");
  if (/growth|content|seo|blog|social/.test(text)) blocked.push("growth");
  if (/ceo|cycle|plan|review|score/.test(text)) blocked.push("ceo");
  if (/outreach|email|resend|domain/.test(text)) blocked.push("outreach");
  if (/ops|health|metrics|monitor/.test(text)) blocked.push("ops");
  if (/scout|pipeline|proposal|idea/.test(text)) blocked.push("scout");
  if (/sentinel|cron|dispatch/.test(text)) blocked.push("sentinel");

  return blocked;
}

// Calculate Engineer success rate for a specific task type
// Returns success rate (0-1) based on completed backlog items in the last 60 days
export async function getTaskTypeSuccessRate(taskType: string, sql: any): Promise<number> {
  const results = await sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'done')::float as successes,
      COUNT(*)::float as total
    FROM hive_backlog
    WHERE task_type = ${taskType}
    AND status IN ('done', 'blocked', 'rejected')
    AND completed_at > NOW() - INTERVAL '60 days'
  `.catch(() => [{ successes: 0, total: 0 }]);

  const { successes, total } = results[0] || { successes: 0, total: 0 };

  // If we have no data for this task type, return neutral 0.5
  // If we have < 3 samples, use a conservative estimate
  if (total === 0) return 0.5;
  if (total < 3) return Math.max(0.4, (successes / total) * 0.8 + 0.2);

  return successes / total;
}
