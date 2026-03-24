/**
 * Task Complexity Classifier
 *
 * Classifies engineering tasks by complexity to optimize model routing:
 * - mechanical: Shell jobs, config changes, simple edits → Groq/Gemini
 * - standard: Regular dev work, features, bug fixes → Sonnet/Gemini Flash
 * - complex: Architecture, security, optimization → Opus
 *
 * Used by CEO agent to set complexity field and by dispatch system
 * to route tasks to appropriate models, reducing Claude Max usage.
 */

export type TaskComplexity = "mechanical" | "standard" | "complex";

export interface TaskAnalysis {
  complexity: TaskComplexity;
  confidence: number; // 0-1, how confident we are in the classification
  reasoning: string; // Why this classification was chosen
  recommended_model: string; // Suggested model for this complexity
}

// Keywords and patterns that indicate different complexity levels
const COMPLEXITY_PATTERNS = {
  mechanical: {
    keywords: [
      // File operations
      "add file", "create file", "copy file", "move file", "delete file", "rename file",
      "update package.json", "install package", "update dependency", "add dependency",
      // Config changes
      "update config", "change setting", "set environment variable", "add env var",
      "update .env", "add to .gitignore", "update tsconfig", "add script",
      // Simple edits
      "fix typo", "update text", "change color", "update copy", "add link",
      "remove comment", "add import", "export function", "update version",
      // Infrastructure tasks
      "deploy to", "build project", "run tests", "lint code", "format code",
      "commit changes", "merge branch", "push to git", "pull latest"
    ],
    patterns: [
      /^(add|create|update|remove|delete|install|uninstall|move|copy|rename)\s+/i,
      /^(fix typo|update text|change color|set \w+)/i,
      /config|package\.json|\.env|tsconfig|script/i,
      /build|deploy|test|lint|format/i
    ],
    weight: 1.0
  },

  standard: {
    keywords: [
      // Feature development
      "implement", "build", "create component", "add feature", "develop",
      "integrate", "connect", "setup", "configure", "customize",
      // UI/UX work
      "design", "style", "responsive", "mobile", "layout", "form", "modal",
      "navigation", "header", "footer", "sidebar", "dashboard", "page",
      // Data/API work
      "fetch data", "api endpoint", "database query", "crud", "validation",
      "form handling", "user input", "data processing", "filter", "search",
      // Bug fixes (non-trivial)
      "debug", "investigate", "troubleshoot", "resolve issue", "fix bug",
      "handle error", "improve performance", "optimize query"
    ],
    patterns: [
      /^(implement|build|create|develop|integrate|setup|configure)\s+/i,
      /component|feature|page|form|modal|api|endpoint/i,
      /responsive|mobile|design|style|layout/i,
      /database|query|crud|validation|processing/i,
      /(debug|investigate|troubleshoot|resolve)/i
    ],
    weight: 1.0
  },

  complex: {
    keywords: [
      // Architecture decisions
      "architecture", "design system", "refactor", "redesign", "restructure",
      "migrate", "upgrade major", "breaking changes", "backward compatibility",
      // Security
      "security", "authentication", "authorization", "encrypt", "decrypt",
      "secure", "vulnerability", "audit", "penetration", "compliance",
      // Performance/Scale
      "optimize", "scale", "performance", "bottleneck", "load testing",
      "caching", "distributed", "microservices", "concurrent", "parallel",
      // Strategic decisions
      "strategy", "approach", "methodology", "framework selection",
      "technology choice", "vendor evaluation", "cost analysis",
      // Complex integrations
      "payment processing", "third-party integration", "webhook system",
      "event-driven", "message queue", "real-time", "websocket"
    ],
    patterns: [
      /architect|design\s+system|refactor|restructure|migrate/i,
      /(security|auth|encrypt|vulnerability|compliance)/i,
      /(optimize|scale|performance|bottleneck|caching)/i,
      /(strategy|approach|framework|methodology)/i,
      /(payment|webhook|integration|real-time|websocket)/i,
      /breaking\s+change|major\s+upgrade|backward\s+compatibility/i
    ],
    weight: 1.0
  }
};

// Model recommendations based on complexity
const MODEL_RECOMMENDATIONS = {
  mechanical: "groq", // Fast, cheap for simple operations
  standard: "gemini", // Good balance for regular dev work
  complex: "claude"   // High reasoning for complex tasks
} as const;

/**
 * Analyze task description and classify its complexity
 */
export function classifyTask(task: string, context?: {
  specialist?: string;
  files_allowed?: string[];
  acceptance_criteria?: string[];
}): TaskAnalysis {
  const taskLower = task.toLowerCase();

  // Score each complexity level
  const scores = {
    mechanical: 0,
    standard: 0,
    complex: 0
  };

  // Check keywords and patterns for each complexity level
  for (const [complexity, config] of Object.entries(COMPLEXITY_PATTERNS)) {
    const complexityKey = complexity as TaskComplexity;

    // Keyword matching
    for (const keyword of config.keywords) {
      if (taskLower.includes(keyword.toLowerCase())) {
        scores[complexityKey] += config.weight;
      }
    }

    // Pattern matching
    for (const pattern of config.patterns) {
      if (pattern.test(task)) {
        scores[complexityKey] += config.weight * 1.2; // Patterns are more specific
      }
    }
  }

  // Context-based adjustments
  if (context) {
    // Specialist type influences complexity
    if (context.specialist) {
      switch (context.specialist) {
        case "infra":
        case "auth":
        case "backend":
          scores.complex += 0.5;
          break;
        case "ui":
        case "content":
          scores.standard += 0.3;
          break;
        case "seo":
          scores.standard += 0.2;
          break;
      }
    }

    // File restrictions indicate complexity
    if (context.files_allowed) {
      const restrictedFiles = context.files_allowed.some(file =>
        file.includes("lib/auth") ||
        file.includes("middleware") ||
        file.includes("lib/crypto") ||
        file.includes("schema.sql")
      );
      if (restrictedFiles) {
        scores.complex += 0.8;
      }
    }

    // Complex acceptance criteria
    if (context.acceptance_criteria) {
      const complexCriteria = context.acceptance_criteria.some(criteria =>
        /security|performance|scale|compatibility/i.test(criteria)
      );
      if (complexCriteria) {
        scores.complex += 0.6;
      }
    }
  }

  // Additional heuristics based on task structure

  // Long, detailed tasks tend to be more complex
  if (task.length > 200) {
    scores.complex += 0.3;
    scores.standard += 0.1;
  } else if (task.length < 50) {
    scores.mechanical += 0.2;
  }

  // Multiple sentences suggest complexity
  const sentenceCount = task.split(/[.!?]+/).filter(s => s.trim().length > 0).length;
  if (sentenceCount > 3) {
    scores.complex += 0.4;
  } else if (sentenceCount === 1) {
    scores.mechanical += 0.2;
  }

  // Technical jargon density
  const technicalTerms = /api|database|component|framework|library|service|endpoint|authentication|authorization|webhook|integration|performance|security/gi;
  const matches = task.match(technicalTerms) || [];
  if (matches.length > 3) {
    scores.complex += 0.3;
  } else if (matches.length === 0) {
    scores.mechanical += 0.3;
  }

  // Determine the winner
  const maxScore = Math.max(scores.mechanical, scores.standard, scores.complex);
  const winner = Object.entries(scores).find(([_, score]) => score === maxScore)?.[0] as TaskComplexity;

  // Default to standard if no clear winner or all scores are 0
  const finalComplexity = winner && maxScore > 0 ? winner : "standard";

  // Calculate confidence based on score separation
  const sortedScores = Object.values(scores).sort((a, b) => b - a);
  const confidence = maxScore > 0 ?
    Math.min(0.95, 0.5 + (sortedScores[0] - sortedScores[1]) / (sortedScores[0] + 0.1)) :
    0.3; // Low confidence for unclear tasks

  // Generate reasoning
  const reasoning = generateReasoning(task, finalComplexity, scores, context);

  return {
    complexity: finalComplexity,
    confidence,
    reasoning,
    recommended_model: MODEL_RECOMMENDATIONS[finalComplexity]
  };
}

/**
 * Generate human-readable reasoning for the classification
 */
function generateReasoning(
  task: string,
  complexity: TaskComplexity,
  scores: Record<TaskComplexity, number>,
  context?: any
): string {
  const reasons = [];

  // Primary classification reason
  switch (complexity) {
    case "mechanical":
      reasons.push("Task appears to be a simple, deterministic operation");
      if (scores.mechanical > 1) {
        reasons.push("Contains mechanical keywords like file operations or config changes");
      }
      break;
    case "standard":
      reasons.push("Task requires regular development work");
      if (scores.standard > 1) {
        reasons.push("Involves feature implementation, UI work, or data processing");
      }
      break;
    case "complex":
      reasons.push("Task involves strategic or architectural decisions");
      if (scores.complex > 1) {
        reasons.push("Contains security, performance, or design system considerations");
      }
      break;
  }

  // Context influences
  if (context?.specialist) {
    reasons.push(`Specialist type '${context.specialist}' influences complexity`);
  }

  // Score details for debugging
  const scoreDetails = Object.entries(scores)
    .filter(([_, score]) => score > 0)
    .map(([type, score]) => `${type}: ${score.toFixed(1)}`)
    .join(", ");

  if (scoreDetails) {
    reasons.push(`Scores: ${scoreDetails}`);
  }

  return reasons.join(". ");
}

/**
 * Classify a batch of tasks efficiently
 */
export function classifyTasks(tasks: Array<{
  id: string;
  task: string;
  specialist?: string;
  files_allowed?: string[];
  acceptance_criteria?: string[];
}>): Record<string, TaskAnalysis> {
  return tasks.reduce((results, taskObj) => {
    results[taskObj.id] = classifyTask(taskObj.task, {
      specialist: taskObj.specialist,
      files_allowed: taskObj.files_allowed,
      acceptance_criteria: taskObj.acceptance_criteria
    });
    return results;
  }, {} as Record<string, TaskAnalysis>);
}

/**
 * Get model routing recommendation based on complexity and agent
 */
export function getModelRecommendation(
  complexity: TaskComplexity,
  agent: string = "engineer",
  fallbackToDefault: boolean = true
): string {
  // Override for specific agents that always use premium models
  const premiumAgents = ["ceo", "scout", "evolver"];
  if (premiumAgents.includes(agent.toLowerCase())) {
    return "claude";
  }

  // Use complexity-based recommendation
  const recommendation = MODEL_RECOMMENDATIONS[complexity];

  // Fallback to agent's default if requested
  if (!recommendation && fallbackToDefault) {
    // These come from the existing AGENT_ROUTING in llm.ts
    const agentDefaults: Record<string, string> = {
      growth: "gemini",
      outreach: "gemini",
      ops: "groq",
      engineer: "claude" // Current default for engineer
    };

    return agentDefaults[agent.toLowerCase()] || "claude";
  }

  return recommendation;
}

/**
 * Utility to test the classifier with sample tasks
 */
export function testClassifier(): void {
  const testTasks = [
    "Add a new file called utils.ts with helper functions",
    "Build a responsive landing page with hero section and pricing table",
    "Design and implement a distributed authentication system with JWT tokens and role-based access control",
    "Fix typo in button text",
    "Implement search functionality with filters and pagination",
    "Refactor the entire database schema for better performance and scalability",
    "Update package.json to latest Next.js version",
    "Create a secure payment processing flow with Stripe webhooks",
    "Add mobile responsive styles to the navigation component"
  ];

  console.log("Task Complexity Classification Test:");
  console.log("=====================================");

  testTasks.forEach((task, index) => {
    const analysis = classifyTask(task);
    console.log(`\nTask ${index + 1}: "${task}"`);
    console.log(`Complexity: ${analysis.complexity} (confidence: ${(analysis.confidence * 100).toFixed(1)}%)`);
    console.log(`Recommended: ${analysis.recommended_model}`);
    console.log(`Reasoning: ${analysis.reasoning}`);
  });
}