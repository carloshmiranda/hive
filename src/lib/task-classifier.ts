// Task Complexity Classifier
//
// Analyzes task descriptions to determine optimal model routing:
// - mechanical: No LLM needed (shell/DB operations)
// - standard: Medium complexity (Sonnet/Gemini sufficient)
// - complex: High complexity (Opus required)
//
// Reduces Claude Max usage by routing simple tasks to cheaper providers.

export type TaskComplexity = "mechanical" | "standard" | "complex";

export interface ClassificationResult {
  complexity: TaskComplexity;
  confidence: number; // 0-1, how confident the classifier is
  reasoning: string;  // Human readable explanation
  suggested_provider?: string; // Recommended provider based on current routing
}

export interface TaskClassificationInput {
  title: string;
  description: string;
  category?: string; // From backlog: bugfix, feature, refactor, infra, quality, research
  agent?: string;    // Target agent if known
  attempt?: number;  // Retry attempt number (higher attempts may need more capable models)
}

// Patterns that indicate mechanical tasks (no LLM needed)
const MECHANICAL_PATTERNS = [
  // Database operations
  /\b(sql|query|database|db)\s+(migration|update|insert|delete|select)\b/i,
  /\brun\s+(migration|seed|backup|restore)\b/i,
  /\bcreate\s+(table|index|constraint)\b/i,

  // File/directory operations
  /\b(create|delete|move|copy|rename)\s+(file|directory|folder)\b/i,
  /\bfile\s+(permission|ownership)\b/i,
  /\bcleanup\s+(temp|cache|old)\s+files/i,

  // Git operations
  /\bgit\s+(checkout|branch|merge|rebase|tag|commit|push|pull)\b/i,
  /\bcreate\s+(branch|tag|pr|pull\s+request)\b/i,

  // Deployment/infra operations
  /\b(restart|reload|stop|start)\s+(service|server|process)\b/i,
  /\b(deploy|undeploy)\s+to\s+(staging|production)\b/i,
  /\bupdate\s+(env|environment)\s+(variable|vars)/i,

  // Settings/config updates
  /\bupdate\s+(setting|config|configuration)\b/i,
  /\bchange\s+(api\s+key|token|credential)\b/i,
];

// Patterns that indicate complex tasks (need Opus)
const COMPLEX_PATTERNS = [
  // Architecture and system design
  /\b(architecture|architect|design\s+system)\b/i,
  /\b(refactor|redesign|restructure)\s+(core|fundamental|major)\b/i,
  /\bdesign\s+(pattern|framework|abstraction)\b/i,

  // AI/ML and sophisticated algorithms
  /\b(ai|artificial\s+intelligence|machine\s+learning|ml|neural|model)\b/i,
  /\b(algorithm|optimization|heuristic|complex\s+logic)\b/i,
  /\bnatural\s+language\s+(processing|understanding|generation)\b/i,

  // Strategic and business logic
  /\b(strategy|strategic|business\s+logic|business\s+rule)\b/i,
  /\b(recommendation|scoring|ranking)\s+(algorithm|system|engine)\b/i,
  /\b(analyze|analysis)\s+.*(market|competitor|user\s+behavior|trend)/i,

  // Complex integrations
  /\bintegrat.*\bmultiple\s+(system|service|api)/i,
  /\b(workflow|pipeline|orchestration)\s+engine\b/i,
  /\bcomplex\s+(workflow|state\s+machine|multi-step)\b/i,

  // Research and exploration
  /\b(research|investigate|explore)\s+.*(approach|solution|alternative)/i,
  /\bproof\s+of\s+concept|poc\b/i,
  /\bevaluate\s+.*\b(option|choice|alternative)/i,

  // Security and compliance
  /\b(security\s+(audit|review|assessment)|penetration\s+test)\b/i,
  /\b(compliance|gdpr|hipaa|sox)\s+(implementation|audit)\b/i,

  // Performance and scaling
  /\b(performance|optimization)\s+.*(complex|sophisticated|advanced)/i,
  /\b(scaling|scale)\s+.*(architecture|system|infrastructure)/i,
];

// Keywords that boost complexity when combined with other factors
const COMPLEXITY_INDICATORS = {
  high: [
    "complex", "sophisticated", "advanced", "intelligent", "adaptive",
    "multi-tenant", "real-time", "distributed", "scalable", "enterprise",
    "critical", "mission-critical", "high-stakes"
  ],
  medium: [
    "integrate", "automation", "workflow", "pipeline", "framework",
    "algorithm", "calculation", "validation", "parsing", "transformation"
  ],
  low: [
    "simple", "basic", "straightforward", "trivial", "routine",
    "manual", "copy", "move", "update", "change", "fix", "patch"
  ]
};

// Agent-specific complexity modifiers
const AGENT_COMPLEXITY_BIAS: Record<string, number> = {
  ceo: 0.3,      // Strategic decisions often complex
  scout: 0.2,    // Market research moderately complex
  evolver: 0.3,  // Meta-cognitive tasks complex
  engineer: 0,   // Neutral - depends on task
  growth: -0.1,  // Content creation usually standard
  outreach: -0.2, // Email writing usually simple
  ops: -0.1,     // Health checks usually simple
};

function countPatternMatches(text: string, patterns: RegExp[]): number {
  return patterns.filter(pattern => pattern.test(text)).length;
}

function analyzeComplexityIndicators(text: string): { high: number; medium: number; low: number } {
  const lowerText = text.toLowerCase();
  const counts = { high: 0, medium: 0, low: 0 };

  for (const level of ["high", "medium", "low"] as const) {
    for (const keyword of COMPLEXITY_INDICATORS[level]) {
      if (lowerText.indexOf(keyword) >= 0) {
        counts[level]++;
      }
    }
  }

  return counts;
}

function getCategoryComplexityBias(category?: string): number {
  switch (category) {
    case "research": return 0.2;      // Research usually complex
    case "feature": return 0.1;       // New features moderately complex
    case "refactor": return 0.15;     // Refactoring can be complex
    case "infra": return -0.1;        // Infra often mechanical
    case "bugfix": return -0.05;      // Bugfixes usually standard
    case "quality": return 0;         // Neutral
    default: return 0;
  }
}

export function classifyTask(input: TaskClassificationInput): ClassificationResult {
  const { title, description, category, agent, attempt = 1 } = input;
  const fullText = `${title} ${description}`.toLowerCase();

  // Check for mechanical patterns first
  const mechanicalMatches = countPatternMatches(fullText, MECHANICAL_PATTERNS);
  if (mechanicalMatches > 0) {
    return {
      complexity: "mechanical",
      confidence: Math.min(0.9, 0.6 + mechanicalMatches * 0.15),
      reasoning: `Contains ${mechanicalMatches} mechanical operation pattern(s): pure shell/database work`,
      suggested_provider: "none" // No LLM needed
    };
  }

  // Check for complex patterns
  const complexMatches = countPatternMatches(fullText, COMPLEX_PATTERNS);
  const indicators = analyzeComplexityIndicators(fullText);

  // Base complexity score (0-1)
  let complexityScore = 0.3; // Start neutral

  // Pattern matching adjustments
  complexityScore += complexMatches * 0.2;
  complexityScore += indicators.high * 0.15;
  complexityScore += indicators.medium * 0.08;
  complexityScore -= indicators.low * 0.1;

  // Agent bias
  if (agent && AGENT_COMPLEXITY_BIAS[agent]) {
    complexityScore += AGENT_COMPLEXITY_BIAS[agent];
  }

  // Category bias
  complexityScore += getCategoryComplexityBias(category);

  // Attempt escalation (later attempts may need more powerful models)
  if (attempt > 1) {
    complexityScore += (attempt - 1) * 0.15;
  }

  // Word count heuristic (longer descriptions often more complex)
  const wordCount = fullText.split(/\s+/).length;
  if (wordCount > 100) complexityScore += 0.1;
  if (wordCount > 200) complexityScore += 0.1;

  // Clamp to valid range
  complexityScore = Math.max(0, Math.min(1, complexityScore));

  // Determine final classification
  let complexity: TaskComplexity;
  let suggestedProvider: string;
  let reasoning: string;

  if (complexityScore >= 0.7) {
    complexity = "complex";
    suggestedProvider = "claude-opus";
    reasoning = `High complexity score ${complexityScore.toFixed(2)}: ${complexMatches} complex pattern(s), ${indicators.high} high-complexity indicator(s)`;
  } else if (complexityScore <= 0.4) {
    complexity = "standard";
    suggestedProvider = "claude-sonnet"; // Or gemini for worker agents
    reasoning = `Low-medium complexity score ${complexityScore.toFixed(2)}: suitable for standard models`;
  } else {
    complexity = "standard";
    suggestedProvider = "claude-sonnet";
    reasoning = `Medium complexity score ${complexityScore.toFixed(2)}: standard model recommended`;
  }

  // Override for agent-specific routing if needed
  if (agent && ["growth", "outreach"].indexOf(agent) >= 0) {
    suggestedProvider = "gemini-flash";
  }

  // Confidence calculation based on pattern strength and clarity
  const confidence = Math.min(0.95, 0.4 +
    Math.abs(complexityScore - 0.5) + // Distance from neutral
    (mechanicalMatches + complexMatches) * 0.1 + // Pattern strength
    (indicators.high + indicators.low) * 0.05    // Clear indicators
  );

  return {
    complexity,
    confidence,
    reasoning,
    suggested_provider: suggestedProvider
  };
}

// Convenience function for quick classification
export function getTaskComplexity(title: string, description: string): TaskComplexity {
  return classifyTask({ title, description }).complexity;
}

// Get recommended provider for a task based on classification and agent
export function getRecommendedProvider(
  input: TaskClassificationInput
): { provider: string; model: string; reasoning: string } {
  const classification = classifyTask(input);
  const { agent } = input;

  if (classification.complexity === "mechanical") {
    return {
      provider: "none",
      model: "none",
      reasoning: "Mechanical task - no LLM needed"
    };
  }

  // For brain agents (CEO, Scout, Evolver), always use Claude
  if (agent && ["ceo", "scout", "evolver"].indexOf(agent) >= 0) {
    const model = classification.complexity === "complex" ? "claude-opus" : "claude-sonnet";
    return {
      provider: "claude",
      model,
      reasoning: `Brain agent ${agent} - Claude ${model.split('-').pop()}`
    };
  }

  // For worker agents, use free tier when possible
  if (agent && ["growth", "outreach"].indexOf(agent) >= 0) {
    if (classification.complexity === "complex") {
      return {
        provider: "claude",
        model: "claude-sonnet",
        reasoning: "Worker agent with complex task - fallback to Claude Sonnet"
      };
    }
    return {
      provider: "gemini",
      model: "gemini-2.5-flash",
      reasoning: "Worker agent with standard task - use free tier"
    };
  }

  if (agent === "ops") {
    if (classification.complexity === "complex") {
      return {
        provider: "claude",
        model: "claude-sonnet",
        reasoning: "Ops agent with complex task - fallback to Claude Sonnet"
      };
    }
    return {
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      reasoning: "Ops agent with standard task - use Groq"
    };
  }

  // Default fallback - use Claude based on complexity
  const model = classification.complexity === "complex" ? "claude-opus" : "claude-sonnet";
  return {
    provider: "claude",
    model,
    reasoning: `Default routing - Claude ${model.split('-').pop()} for ${classification.complexity} task`
  };
}