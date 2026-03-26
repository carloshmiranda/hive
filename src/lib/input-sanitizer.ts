/**
 * Input sanitization utilities to prevent prompt injection attacks.
 * Strips potentially dangerous patterns from task descriptions before they reach agents.
 */

interface SanitizationPattern {
  name: string;
  regex: RegExp;
  flags?: string;
}

// Patterns that could be used for prompt injection attacks
const DANGEROUS_PATTERNS: SanitizationPattern[] = [
  // 1. System prompt overrides
  {
    name: 'system_prompt_override',
    regex: /^(You are|Ignore previous|System:|SYSTEM:).*$/gmi
  },

  // 2. Instruction injection
  {
    name: 'instruction_injection',
    regex: /(Do not follow|Instead do|Override|Forget your instructions)/gi
  },

  // 3. Role switching
  {
    name: 'role_switching',
    regex: /(Act as|Pretend to be|You must now)/gi
  },

  // 4. Code execution (dangerous shell commands outside of code blocks)
  // This is more complex - we need to avoid code blocks but catch dangerous patterns
  {
    name: 'code_execution',
    regex: /(^|\n|\s)(rm\s+-rf|curl.*\|\s*bash|wget.*\|\s*bash|eval\s*\()/gm
  }
];

/**
 * Checks if text contains any suspicious patterns that could be prompt injection attempts.
 */
export function hasSuspiciousPatterns(text: string): boolean {
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.regex.test(text)) {
      return true;
    }
  }

  // Check for unbalanced backticks that could break markdown formatting
  const backtickMatches = text.match(/`/g);
  if (backtickMatches && backtickMatches.length % 2 !== 0) {
    return true;
  }

  return false;
}

/**
 * Sanitizes task input by removing or neutralizing potential prompt injection patterns.
 * Logs a warning when content is removed for Sentry tracking.
 */
export function sanitizeTaskInput(text: string): string {
  let sanitized = text;
  let removedPatterns: string[] = [];

  // Apply each sanitization pattern
  for (const pattern of DANGEROUS_PATTERNS) {
    const originalLength = sanitized.length;

    // Replace dangerous patterns with neutral alternatives or remove them
    switch (pattern.name) {
      case 'system_prompt_override':
        sanitized = sanitized.replace(pattern.regex, '<!-- Removed system prompt override -->');
        break;
      case 'instruction_injection':
        sanitized = sanitized.replace(pattern.regex, '<!-- Removed instruction injection -->');
        break;
      case 'role_switching':
        sanitized = sanitized.replace(pattern.regex, '<!-- Removed role switching attempt -->');
        break;
      case 'code_execution':
        // More careful replacement - preserve context but neutralize the command
        sanitized = sanitized.replace(pattern.regex, (match, prefix) => {
          return prefix + '<!-- Removed potentially dangerous command -->';
        });
        break;
    }

    // Track if this pattern caused changes
    if (sanitized.length !== originalLength) {
      removedPatterns.push(pattern.name);
    }
  }

  // Handle unbalanced backticks by escaping them
  const backtickMatches = sanitized.match(/`/g);
  if (backtickMatches && backtickMatches.length % 2 !== 0) {
    // Find the last unmatched backtick and escape it
    const lastIndex = sanitized.lastIndexOf('`');
    sanitized = sanitized.substring(0, lastIndex) + '\\`' + sanitized.substring(lastIndex + 1);
    removedPatterns.push('unbalanced_backticks');
  }

  // Log warning if any patterns were removed
  if (removedPatterns.length > 0) {
    console.warn(`[INPUT_SANITIZER] Removed suspicious patterns from task input: ${removedPatterns.join(', ')}`, {
      originalLength: text.length,
      sanitizedLength: sanitized.length,
      patternsRemoved: removedPatterns
    });
  }

  return sanitized;
}