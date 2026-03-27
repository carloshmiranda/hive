const fs = require('fs');
const path = require('path');
const glob = require('glob');

// Find all API route files
const apiRoutes = glob.sync('src/app/api/**/route.ts');

// Routes we've already updated
const updatedRoutes = [
  'src/app/api/agents/dispatch/route.ts',
  'src/app/api/health/route.ts',
  'src/app/api/companies/[id]/route.ts',
  'src/app/api/approvals/[id]/decide/route.ts'
];

// Function to determine action type based on route path
function getActionType(routePath) {
  if (routePath.includes('/agents/')) return 'agent_operation';
  if (routePath.includes('/companies/')) return 'company_operation';
  if (routePath.includes('/cycles/')) return 'cycle_operation';
  if (routePath.includes('/approvals/')) return 'approval_operation';
  if (routePath.includes('/metrics/')) return 'metrics_operation';
  if (routePath.includes('/cron/')) return 'cron_job';
  if (routePath.includes('/webhooks/')) return 'webhook';
  if (routePath.includes('/health')) return 'health_check';
  if (routePath.includes('/settings')) return 'settings_update';
  if (routePath.includes('/backlog/')) return 'backlog_operation';
  if (routePath.includes('/dashboard')) return 'dashboard_load';
  if (routePath.includes('/portfolio')) return 'portfolio_load';
  if (routePath.includes('/social')) return 'social_operation';
  return 'api_request';
}

// Function to check if file already has Sentry import
function hasSentryImport(content) {
  return content.includes('setSentryApiTags') || content.includes('@/lib/sentry-tags');
}

// Function to add Sentry import if missing
function addSentryImport(content) {
  if (hasSentryImport(content)) return content;

  // Find the last import statement
  const lines = content.split('\n');
  let lastImportIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('import ')) {
      lastImportIndex = i;
    }
  }

  if (lastImportIndex >= 0) {
    lines.splice(lastImportIndex + 1, 0, 'import { setSentryApiTags, extractRoutePath } from "@/lib/sentry-tags";');
  }

  return lines.join('\n');
}

// Function to add Sentry tags to HTTP handlers
function addSentryTags(content, routePath) {
  const actionType = getActionType(routePath);

  // Pattern to match function declarations
  const functionPattern = /export async function (GET|POST|PUT|PATCH|DELETE)\s*\([^)]+\)\s*{/g;

  return content.replace(functionPattern, (match, method, ...args) => {
    // Check if this function already has Sentry tags
    const funcStart = content.indexOf(match);
    const funcBlock = content.substring(funcStart, funcStart + 500);

    if (funcBlock.includes('setSentryApiTags')) {
      return match; // Already has Sentry tags
    }

    // Add Sentry tags after the function opening
    const actionName = `${method.toLowerCase()}_${actionType}`;
    const sentryTags = `\n  // Set Sentry tags for error context and triage\n  setSentryApiTags({\n    route: extractRoutePath(req),\n    action_type: "${actionName}",\n  });\n`;

    return match + sentryTags;
  });
}

// Process each route file
apiRoutes.forEach(routePath => {
  if (updatedRoutes.includes(routePath)) {
    console.log(`Skipping ${routePath} (already updated)`);
    return;
  }

  try {
    let content = fs.readFileSync(routePath, 'utf8');

    // Skip if no HTTP method handlers
    if (!content.includes('export async function')) {
      console.log(`Skipping ${routePath} (no HTTP handlers)`);
      return;
    }

    // Add import if missing
    content = addSentryImport(content);

    // Add Sentry tags to handlers
    const updatedContent = addSentryTags(content, routePath);

    // Only write if content changed
    if (updatedContent !== content) {
      fs.writeFileSync(routePath, updatedContent, 'utf8');
      console.log(`Updated ${routePath}`);
    } else {
      console.log(`No changes needed for ${routePath}`);
    }

  } catch (error) {
    console.error(`Error processing ${routePath}:`, error.message);
  }
});

console.log('Sentry tagging update complete!');