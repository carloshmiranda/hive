import { NextRequest } from "next/server";
import { getDb, json, err } from "@/lib/db";
import { type HiveToolCall, type HiveToolResult } from "@/lib/hive-tools";
import { setSentryTags } from "@/lib/sentry-tags";
import { getStripeToolkit, getStripeAgentTools } from "@/lib/stripe";

// Tool execution endpoint for Hive API functions
// Called by agents via tool calling to query/update the Hive database

export async function POST(req: NextRequest) {
  // Auth: CRON_SECRET bearer token (same as other agent endpoints)
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return err("Unauthorized", 401);
  }

  const sql = getDb();

  try {
    const body = await req.json();
    const { toolCalls, agent, company } = body as {
      toolCalls: HiveToolCall[];
      agent?: string;
      company?: string;
    };

    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
      return err("toolCalls array is required", 400);
    }

    // Set Sentry tags for error triage
    setSentryTags({
      agent: agent || "unknown",
      action_type: "tool_execution",
      route: "/api/agents/tools"
    });

    const results: HiveToolResult[] = [];

    // Execute each tool call
    for (const toolCall of toolCalls) {
      try {
        const args = JSON.parse(toolCall.function.arguments);
        const result = await executeTool(sql, toolCall.function.name, args);

        results.push({
          toolCallId: toolCall.id,
          result,
        });
      } catch (error: any) {
        console.warn(`[tools] Tool execution failed for ${toolCall.function.name}: ${error.message}`);

        results.push({
          toolCallId: toolCall.id,
          result: null,
          error: error.message || "Tool execution failed",
        });
      }
    }

    return json({
      ok: true,
      results,
    });

  } catch (error: any) {
    console.error("[tools] Tool execution request failed:", error);
    return err(`Tool execution failed: ${error.message}`, 500);
  }
}

// Execute individual tool functions
async function executeTool(sql: any, toolName: string, args: any): Promise<any> {
  switch (toolName) {
    case "query_playbook":
      return await queryPlaybook(sql, args);

    case "get_metrics":
      return await getMetrics(sql, args);

    case "get_company_status":
      return await getCompanyStatus(sql, args);

    case "update_task_status":
      return await updateTaskStatus(sql, args);

    case "get_research_reports":
      return await getResearchReports(sql, args);

    case "log_agent_action":
      return await logAgentAction(sql, args);

    case "create_payment_link":
      return await createPaymentLink(sql, args);

    case "create_subscription":
      return await createSubscription(sql, args);

    case "issue_refund":
      return await issueRefund(sql, args);

    case "apply_coupon":
      return await applyCoupon(sql, args);

    case "get_stripe_tools":
      return await getStripeTools(sql, args);

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

// Tool implementations

async function queryPlaybook(sql: any, args: { company?: string; category?: string; limit?: number }): Promise<any> {
  const { company, category, limit = 10 } = args;

  // Get content language for filtering if company provided
  let contentLanguage = 'en';
  if (company) {
    const [companyData] = await sql`
      SELECT content_language FROM companies WHERE slug = ${company}
    `.catch(() => []);
    if (companyData?.content_language) {
      contentLanguage = companyData.content_language;
    }
  }

  const playbook = await sql`
    SELECT domain, insight, confidence, created_at
    FROM playbook
    WHERE superseded_by IS NULL
      AND confidence >= 0.6
      AND (content_language IS NULL OR content_language = ${contentLanguage})
      ${category ? sql`AND domain = ${category}` : sql``}
    ORDER BY confidence DESC
    LIMIT ${limit}
  `.catch(() => []);

  return {
    entries: playbook,
    total: playbook.length,
    content_language: contentLanguage,
  };
}

async function getMetrics(sql: any, args: { company: string; days?: number }): Promise<any> {
  const { company, days = 7 } = args;

  // Get company ID
  const [companyData] = await sql`
    SELECT id FROM companies WHERE slug = ${company}
  `;
  if (!companyData) throw new Error(`Company not found: ${company}`);

  const metrics = await sql`
    SELECT date, revenue, mrr, customers, page_views, signups, churn_rate,
           waitlist_signups, waitlist_total
    FROM metrics
    WHERE company_id = ${companyData.id}
      AND date >= CURRENT_DATE - INTERVAL '${days} days'
    ORDER BY date DESC
    LIMIT 50
  `.catch(() => []);

  return {
    company: company,
    days_requested: days,
    metrics,
    total_entries: metrics.length,
  };
}

async function getCompanyStatus(sql: any, args: { slug: string }): Promise<any> {
  const { slug } = args;

  // Get company data
  const [company] = await sql`
    SELECT id, name, slug, status, description, capabilities,
           company_type, content_language, github_repo
    FROM companies
    WHERE slug = ${slug}
  `;
  if (!company) throw new Error(`Company not found: ${slug}`);

  // Get latest cycle
  const [latestCycle] = await sql`
    SELECT id, cycle_number, ceo_plan, started_at, finished_at
    FROM cycles
    WHERE company_id = ${company.id}
    ORDER BY started_at DESC
    LIMIT 1
  `.catch(() => []);

  // Get recent agent actions
  const recentActions = await sql`
    SELECT agent, action_type, status, description, finished_at
    FROM agent_actions
    WHERE company_id = ${company.id}
      AND finished_at > NOW() - INTERVAL '24 hours'
    ORDER BY finished_at DESC
    LIMIT 10
  `.catch(() => []);

  return {
    company,
    latest_cycle: latestCycle,
    recent_actions: recentActions,
  };
}

async function updateTaskStatus(sql: any, args: { task_id: string; status: string; notes?: string }): Promise<any> {
  const { task_id, status, notes } = args;

  // Validate status
  const validStatuses = ['pending', 'in_progress', 'done', 'blocked'];
  if (!validStatuses.includes(status)) {
    throw new Error(`Invalid status: ${status}. Must be one of: ${validStatuses.join(', ')}`);
  }

  const [updated] = await sql`
    UPDATE company_tasks
    SET status = ${status}${notes ? sql`, notes = ${notes}` : sql``},
        updated_at = NOW()
    WHERE id = ${task_id}
    RETURNING id, title, status, updated_at
  `;

  if (!updated) throw new Error(`Task not found: ${task_id}`);

  return {
    task_id: task_id,
    updated_task: updated,
  };
}

async function getResearchReports(sql: any, args: { company: string; report_type?: string; limit?: number }): Promise<any> {
  const { company, report_type, limit = 5 } = args;

  // Get company ID
  const [companyData] = await sql`
    SELECT id FROM companies WHERE slug = ${company}
  `;
  if (!companyData) throw new Error(`Company not found: ${company}`);

  const reports = await sql`
    SELECT report_type, summary, content, created_at
    FROM research_reports
    WHERE company_id = ${companyData.id}
      ${report_type ? sql`AND report_type = ${report_type}` : sql``}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `.catch(() => []);

  return {
    company: company,
    report_type: report_type,
    reports,
    total: reports.length,
  };
}

async function logAgentAction(sql: any, args: { company: string; agent: string; action_type: string; description: string; status: string; output?: any }): Promise<any> {
  const { company, agent, action_type, description, status, output } = args;

  // Get company ID
  const [companyData] = await sql`
    SELECT id FROM companies WHERE slug = ${company}
  `;
  if (!companyData) throw new Error(`Company not found: ${company}`);

  const [loggedAction] = await sql`
    INSERT INTO agent_actions (
      company_id, agent, action_type, description, status, output,
      started_at, finished_at
    ) VALUES (
      ${companyData.id}, ${agent}, ${action_type}, ${description},
      ${status}, ${output ? JSON.stringify(output) : null}::jsonb,
      ${new Date().toISOString()}, ${new Date().toISOString()}
    )
    RETURNING id, agent, action_type, status, finished_at
  `;

  return {
    logged_action: loggedAction,
    company: company,
  };
}

// Stripe Agent Toolkit tool implementations

async function createPaymentLink(sql: any, args: { company: string; name: string; amount: number; currency?: string; description?: string }): Promise<any> {
  const { company, name, amount, currency = "EUR", description } = args;

  // Verify company exists
  const [companyData] = await sql`
    SELECT id FROM companies WHERE slug = ${company}
  `;
  if (!companyData) throw new Error(`Company not found: ${company}`);

  try {
    const toolkit = await getStripeToolkit(company);

    // Use the MCP client to call the tool directly
    const result = await toolkit.mcpClient.callTool("create_payment_link", {
      line_items: [{
        price_data: {
          currency: currency.toLowerCase(),
          product_data: {
            name,
            description,
            metadata: { hive_company: company }
          },
          unit_amount: Math.round(amount * 100), // Convert to cents
        },
        quantity: 1,
      }],
      metadata: { hive_company: company }
    });

    return {
      company,
      payment_link: JSON.parse(result),
    };
  } catch (error: any) {
    throw new Error(`Failed to create payment link: ${error.message}`);
  }
}

async function createSubscription(sql: any, args: { company: string; customer_email: string; price_id: string; trial_days?: number }): Promise<any> {
  const { company, customer_email, price_id, trial_days } = args;

  // Verify company exists
  const [companyData] = await sql`
    SELECT id FROM companies WHERE slug = ${company}
  `;
  if (!companyData) throw new Error(`Company not found: ${company}`);

  try {
    const toolkit = await getStripeToolkit(company);

    const subscriptionParams: any = {
      customer: {
        email: customer_email,
      },
      items: [{
        price: price_id,
      }],
      metadata: { hive_company: company }
    };

    if (trial_days) {
      subscriptionParams.trial_period_days = trial_days;
    }

    const result = await toolkit.mcpClient.callTool("create_subscription", subscriptionParams);

    return {
      company,
      subscription: JSON.parse(result),
    };
  } catch (error: any) {
    throw new Error(`Failed to create subscription: ${error.message}`);
  }
}

async function issueRefund(sql: any, args: { company: string; charge_id: string; amount?: number; reason?: string }): Promise<any> {
  const { company, charge_id, amount, reason } = args;

  // Verify company exists
  const [companyData] = await sql`
    SELECT id FROM companies WHERE slug = ${company}
  `;
  if (!companyData) throw new Error(`Company not found: ${company}`);

  try {
    const toolkit = await getStripeToolkit(company);

    const refundParams: any = {
      charge: charge_id,
      metadata: { hive_company: company }
    };

    if (amount) {
      refundParams.amount = Math.round(amount * 100); // Convert to cents
    }

    if (reason) {
      refundParams.reason = reason;
    }

    const result = await toolkit.mcpClient.callTool("create_refund", refundParams);

    return {
      company,
      refund: JSON.parse(result),
    };
  } catch (error: any) {
    throw new Error(`Failed to issue refund: ${error.message}`);
  }
}

async function applyCoupon(sql: any, args: { company: string; coupon_id: string; discount_type: string; discount_value: number; duration: string; duration_in_months?: number }): Promise<any> {
  const { company, coupon_id, discount_type, discount_value, duration, duration_in_months } = args;

  // Verify company exists
  const [companyData] = await sql`
    SELECT id FROM companies WHERE slug = ${company}
  `;
  if (!companyData) throw new Error(`Company not found: ${company}`);

  try {
    const toolkit = await getStripeToolkit(company);

    const couponParams: any = {
      id: coupon_id,
      duration,
      metadata: { hive_company: company }
    };

    if (discount_type === "percent") {
      couponParams.percent_off = discount_value;
    } else {
      couponParams.amount_off = Math.round(discount_value * 100); // Convert to cents
      couponParams.currency = "eur";
    }

    if (duration === "repeating" && duration_in_months) {
      couponParams.duration_in_months = duration_in_months;
    }

    const result = await toolkit.mcpClient.callTool("create_coupon", couponParams);

    return {
      company,
      coupon: JSON.parse(result),
    };
  } catch (error: any) {
    throw new Error(`Failed to create coupon: ${error.message}`);
  }
}

async function getStripeTools(sql: any, args: { company: string }): Promise<any> {
  const { company } = args;

  // Verify company exists
  const [companyData] = await sql`
    SELECT id FROM companies WHERE slug = ${company}
  `;
  if (!companyData) throw new Error(`Company not found: ${company}`);

  try {
    const tools = await getStripeAgentTools(company);

    return {
      company,
      available_tools: tools.map(tool => ({
        name: tool.function.name,
        description: tool.function.description,
      })),
      total_tools: tools.length,
    };
  } catch (error: any) {
    throw new Error(`Failed to get Stripe tools: ${error.message}`);
  }
}