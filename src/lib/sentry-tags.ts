import * as Sentry from "@sentry/nextjs";
import { NextRequest } from "next/server";
import { getDb } from "@/lib/db";
import { validateOIDC } from "@/lib/oidc";
import { requireAuth } from "@/lib/auth";

interface SentryContext {
  company_id?: string | null;
  agent?: string | null;
  action_type?: string | null;
}

/**
 * Extract and set Sentry tags for API routes to improve observability
 * Adds company_id, agent, and action_type tags to Sentry events
 */
export async function setSentryApiTags(request: NextRequest, options: {
  // Override auto-detection
  companyId?: string | null;
  agent?: string | null;
  actionType?: string | null;
  // Additional context
  skipAuth?: boolean;
} = {}): Promise<SentryContext> {
  const context: SentryContext = {};

  try {
    // Extract company_id
    context.company_id = await extractCompanyId(request, options);

    // Extract agent
    context.agent = await extractAgent(request, options);

    // Extract action_type
    context.action_type = extractActionType(request, options);

    // Set Sentry tags
    Sentry.setTag("company_id", context.company_id || "none");
    Sentry.setTag("agent", context.agent || "none");
    Sentry.setTag("action_type", context.action_type || "unknown");

    // Also set as context for richer debugging
    Sentry.setContext("api_context", {
      company_id: context.company_id,
      agent: context.agent,
      action_type: context.action_type,
      url: request.url,
      method: request.method,
    });

  } catch (error) {
    // Don't fail the main request if Sentry tagging fails
    console.warn("[sentry-tags] Failed to set tags:", error);
  }

  return context;
}

/**
 * Extract company_id from various sources
 */
async function extractCompanyId(request: NextRequest, options: any): Promise<string | null> {
  // 1. Explicit override
  if (options.companyId !== undefined) {
    return options.companyId;
  }

  const url = new URL(request.url);

  // 2. URL path parameter (e.g., /api/companies/[id])
  const pathMatch = url.pathname.match(/\/api\/companies\/([^\/]+)/);
  if (pathMatch) {
    return pathMatch[1];
  }

  // 3. Query parameter
  const companySlug = url.searchParams.get("company");
  if (companySlug) {
    return await lookupCompanyId(companySlug);
  }

  // 4. Request body company_slug (for non-GET requests)
  if (request.method !== "GET" && request.headers.get("content-type")?.includes("application/json")) {
    try {
      const body = await request.clone().json();
      if (body.company_slug) {
        return await lookupCompanyId(body.company_slug);
      }
    } catch {
      // Ignore JSON parsing errors
    }
  }

  return null;
}

/**
 * Extract agent from OIDC claims or route context
 */
async function extractAgent(request: NextRequest, options: any): Promise<string | null> {
  // 1. Explicit override
  if (options.agent !== undefined) {
    return options.agent;
  }

  // 2. OIDC claims (for agent routes)
  try {
    const claims = await validateOIDC(request);
    if (!(claims instanceof Response)) {
      return (claims.agent as string) || null;
    }
  } catch {
    // Not an OIDC route
  }

  // 3. Request body (for non-GET requests)
  if (request.method !== "GET" && request.headers.get("content-type")?.includes("application/json")) {
    try {
      const body = await request.clone().json();
      if (body.agent) {
        return body.agent;
      }
    } catch {
      // Ignore JSON parsing errors
    }
  }

  // 4. Infer from URL path
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/agents/")) {
    // Most agent API routes are called by the orchestrator or other agents
    return "orchestrator";
  }

  return null;
}

/**
 * Extract action_type from route and method
 */
function extractActionType(request: NextRequest, options: any): string | null {
  // 1. Explicit override
  if (options.actionType !== undefined) {
    return options.actionType;
  }

  // 2. Infer from URL and method
  const url = new URL(request.url);
  const method = request.method.toLowerCase();

  // Map common patterns
  const pathSegments = url.pathname.split("/").filter(Boolean);
  const apiRoute = pathSegments.slice(1).join("_"); // Remove 'api'

  // Common action patterns
  if (url.pathname.includes("/dispatch")) return "dispatch";
  if (url.pathname.includes("/health")) return "health_check";
  if (url.pathname.includes("/cron/")) return "cron_" + pathSegments[pathSegments.length - 1];
  if (url.pathname.includes("/webhook")) return "webhook";
  if (url.pathname.includes("/auth")) return "auth";

  // Default pattern: method_route
  return `${method}_${apiRoute}`;
}

/**
 * Look up company ID by slug
 */
async function lookupCompanyId(slug: string): Promise<string | null> {
  try {
    const sql = getDb();
    const [company] = await sql`
      SELECT id FROM companies WHERE slug = ${slug} LIMIT 1
    `.catch(() => []);
    return company?.id || null;
  } catch {
    return null;
  }
}