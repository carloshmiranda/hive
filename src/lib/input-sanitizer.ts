/**
 * Input sanitization utilities to prevent injection attacks and malformed data
 * before database operations and GitHub dispatches
 */

// Control characters and dangerous patterns to remove/detect
const CONTROL_CHARS_REGEX = /[\x00-\x1F\x7F]/g;

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
  {
    name: 'code_execution',
    regex: /(^|\n|\s)(rm\s+-rf|curl.*\|\s*bash|wget.*\|\s*bash|eval\s*\()/gm
  },

  // 5. Script injection
  {
    name: 'script_injection',
    regex: /<script[\s\S]*?>/gi
  },

  // 6. SQL injection patterns
  {
    name: 'sql_injection',
    regex: /(\bUNION\b|\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bDROP\b)[\s\S]*?(\bFROM\b|\bINTO\b|\bWHERE\b)/gi
  },

  // 7. Command injection
  {
    name: 'command_injection',
    regex: /;\s*(rm|ls|cat|curl|wget|nc|netcat|bash|sh|cmd|powershell)/gi
  },

  // 8. Directory traversal
  {
    name: 'directory_traversal',
    regex: /\.\.\/|\.\.\\|%2e%2e%2f|%2e%2e%5c/gi
  },

  // 9. Prototype pollution
  {
    name: 'prototype_pollution',
    regex: /__proto__|constructor\.prototype|prototype\.constructor/gi
  },

  // 10. GitHub Actions injection
  {
    name: 'github_actions_injection',
    regex: /\$\{\{[\s\S]*?\}\}/g
  }
];

/**
 * Sanitizes a string by removing control characters, trimming, and truncating
 * @param input - The string to sanitize
 * @param maxLen - Maximum allowed length (default: 2000)
 * @returns Sanitized string
 */
export function sanitizeString(input: string, maxLen: number = 2000): string {
  if (typeof input !== 'string') {
    return '';
  }

  return input
    .replace(CONTROL_CHARS_REGEX, '') // Remove control characters
    .trim()                           // Remove leading/trailing whitespace
    .slice(0, maxLen);               // Truncate to max length
}

/**
 * Sanitizes a JSON object by recursively sanitizing all string values
 * and preventing prototype pollution
 * @param obj - The object to sanitize
 * @param maxDepth - Maximum recursion depth (default: 3)
 * @param currentDepth - Current recursion level (internal use)
 * @returns Sanitized object
 */
export function sanitizeJSON(obj: any, maxDepth: number = 3, currentDepth: number = 0): any {
  if (currentDepth >= maxDepth) {
    return '[MAX_DEPTH_REACHED]';
  }

  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    return sanitizeString(obj);
  }

  if (typeof obj === 'number' || typeof obj === 'boolean') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeJSON(item, maxDepth, currentDepth + 1));
  }

  if (typeof obj === 'object') {
    const sanitized: any = {};

    for (const key in obj) {
      // Prevent prototype pollution
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        continue;
      }

      if (obj.hasOwnProperty(key)) {
        const sanitizedKey = sanitizeString(key, 100); // Limit key length
        sanitized[sanitizedKey] = sanitizeJSON(obj[key], maxDepth, currentDepth + 1);
      }
    }

    return sanitized;
  }

  return obj;
}

/**
 * Validates dispatch payload structure and types
 * @param body - The request body to validate
 * @returns Validation result
 */
export function validateDispatchPayload(body: any): { isValid: boolean; error?: string } {
  if (!body || typeof body !== 'object') {
    return { isValid: false, error: 'Request body must be a valid JSON object' };
  }

  // Prevent prototype pollution in the payload itself
  if ('__proto__' in body || 'constructor' in body || 'prototype' in body) {
    return { isValid: false, error: 'Invalid payload structure' };
  }

  return { isValid: true };
}

/**
 * Checks if input contains suspicious patterns that could indicate malicious intent
 * @param input - The string to check
 * @returns Object with detection results including patterns found and risk level
 */
export function hasSuspiciousPatterns(input: string): {
  hasSuspicious: boolean;
  patterns: string[];
  riskLevel: 'low' | 'medium' | 'high';
} {
  if (typeof input !== 'string') {
    return { hasSuspicious: false, patterns: [], riskLevel: 'low' };
  }

  const detectedPatterns: string[] = [];

  // Check each dangerous pattern
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.regex.test(input)) {
      detectedPatterns.push(pattern.name);
    }
  }

  // Check for unbalanced backticks that could break markdown formatting
  const backtickMatches = input.match(/`/g);
  if (backtickMatches && backtickMatches.length % 2 !== 0) {
    detectedPatterns.push('unbalanced_backticks');
  }

  // Determine risk level based on number and type of patterns found
  let riskLevel: 'low' | 'medium' | 'high' = 'low';
  if (detectedPatterns.length >= 3) {
    riskLevel = 'high';
  } else if (detectedPatterns.length >= 1) {
    // Check for high-risk patterns
    const highRiskPatterns = ['sql_injection', 'command_injection', 'github_actions_injection', 'prototype_pollution'];
    const hasHighRisk = detectedPatterns.some(pattern => highRiskPatterns.includes(pattern));
    riskLevel = hasHighRisk ? 'high' : 'medium';
  }

  return {
    hasSuspicious: detectedPatterns.length > 0,
    patterns: detectedPatterns,
    riskLevel
  };
}

/**
 * Legacy function for backward compatibility
 * @deprecated Use hasSuspiciousPatterns() instead for detailed results
 */
export function hasSuspiciousPatternsSimple(text: string): boolean {
  return hasSuspiciousPatterns(text).hasSuspicious;
}

/**
 * Sanitizes task input specifically for GitHub dispatches and agent prompts
 * @param input - The task description or trigger to sanitize
 * @returns Sanitized task input
 */
export function sanitizeTaskInput(input: string): string {
  if (typeof input !== 'string') {
    return '';
  }

  // First apply basic string sanitization with longer length for task descriptions
  let sanitized = sanitizeString(input, 5000);
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
        sanitized = sanitized.replace(pattern.regex, (match, prefix) => {
          return prefix + '<!-- Removed potentially dangerous command -->';
        });
        break;
      case 'script_injection':
        sanitized = sanitized.replace(pattern.regex, '<!-- Removed script tag -->');
        break;
      case 'sql_injection':
        sanitized = sanitized.replace(pattern.regex, '<!-- Removed SQL injection attempt -->');
        break;
      case 'command_injection':
        sanitized = sanitized.replace(pattern.regex, '<!-- Removed command injection attempt -->');
        break;
      case 'directory_traversal':
        sanitized = sanitized.replace(pattern.regex, '<!-- Removed directory traversal attempt -->');
        break;
      case 'prototype_pollution':
        sanitized = sanitized.replace(pattern.regex, '<!-- Removed prototype pollution attempt -->');
        break;
      case 'github_actions_injection':
        sanitized = sanitized.replace(pattern.regex, '<!-- Removed GitHub Actions expression -->');
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
    const lastIndex = sanitized.lastIndexOf('`');
    sanitized = sanitized.substring(0, lastIndex) + '\\`' + sanitized.substring(lastIndex + 1);
    removedPatterns.push('unbalanced_backticks');
  }

  // Log warning if any patterns were removed
  if (removedPatterns.length > 0) {
    console.warn(`[INPUT_SANITIZER] Removed suspicious patterns from task input: ${removedPatterns.join(', ')}`, {
      originalLength: input.length,
      sanitizedLength: sanitized.length,
      patternsRemoved: removedPatterns
    });
  }

  return sanitized;
}