// Hive API tool definitions for OpenAI-format tool calling
// Agents can call these tools to query/update the Hive database instead of pre-loading all context

export const HIVE_TOOLS: Array<{
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: any;
  };
}> = [
  {
    type: "function" as const,
    function: {
      name: "query_playbook",
      description: "Query the cross-company playbook for insights and learnings by domain and category",
      parameters: {
        type: "object",
        properties: {
          company: {
            type: "string",
            description: "Company slug to filter by content language (optional)"
          },
          category: {
            type: "string",
            description: "Playbook category to filter by (e.g., 'growth', 'seo', 'engineering', 'payments')"
          },
          limit: {
            type: "number",
            description: "Maximum number of entries to return (default: 10)",
            default: 10
          }
        },
        required: []
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "get_metrics",
      description: "Get recent metrics for a company (revenue, MRR, customers, traffic, etc.)",
      parameters: {
        type: "object",
        properties: {
          company: {
            type: "string",
            description: "Company slug"
          },
          days: {
            type: "number",
            description: "Number of days to look back (default: 7)",
            default: 7
          }
        },
        required: ["company"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "get_company_status",
      description: "Get current status and context for a company (status, latest cycle, CEO plan, etc.)",
      parameters: {
        type: "object",
        properties: {
          slug: {
            type: "string",
            description: "Company slug"
          }
        },
        required: ["slug"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "update_task_status",
      description: "Update the status of a company task",
      parameters: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "Task ID to update"
          },
          status: {
            type: "string",
            description: "New status for the task",
            enum: ["pending", "in_progress", "done", "blocked"]
          },
          notes: {
            type: "string",
            description: "Optional notes about the status change"
          }
        },
        required: ["task_id", "status"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "get_research_reports",
      description: "Get research reports for a company by type",
      parameters: {
        type: "object",
        properties: {
          company: {
            type: "string",
            description: "Company slug"
          },
          report_type: {
            type: "string",
            description: "Type of research report (e.g., 'market_research', 'seo_keywords', 'competitive_analysis', 'lead_list')"
          },
          limit: {
            type: "number",
            description: "Maximum number of reports to return (default: 5)",
            default: 5
          }
        },
        required: ["company"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "log_agent_action",
      description: "Log an agent action to the database",
      parameters: {
        type: "object",
        properties: {
          company: {
            type: "string",
            description: "Company slug"
          },
          agent: {
            type: "string",
            description: "Agent name"
          },
          action_type: {
            type: "string",
            description: "Type of action performed"
          },
          description: {
            type: "string",
            description: "Description of the action"
          },
          status: {
            type: "string",
            description: "Action status",
            enum: ["success", "failed", "running"]
          },
          output: {
            type: "object",
            description: "Action output data"
          }
        },
        required: ["company", "agent", "action_type", "description", "status"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "create_payment_link",
      description: "Create a Stripe payment link for a product or service",
      parameters: {
        type: "object",
        properties: {
          company: {
            type: "string",
            description: "Company slug for this payment link"
          },
          name: {
            type: "string",
            description: "Product or service name"
          },
          amount: {
            type: "number",
            description: "Amount in euros (will be converted to cents)"
          },
          currency: {
            type: "string",
            description: "Currency code (default: EUR)",
            default: "EUR"
          },
          description: {
            type: "string",
            description: "Optional description for the payment link"
          }
        },
        required: ["company", "name", "amount"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "create_subscription",
      description: "Create a Stripe subscription for recurring payments",
      parameters: {
        type: "object",
        properties: {
          company: {
            type: "string",
            description: "Company slug for this subscription"
          },
          customer_email: {
            type: "string",
            description: "Customer email address"
          },
          price_id: {
            type: "string",
            description: "Stripe price ID for the subscription"
          },
          trial_days: {
            type: "number",
            description: "Optional trial period in days"
          }
        },
        required: ["company", "customer_email", "price_id"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "issue_refund",
      description: "Issue a full or partial refund for a charge",
      parameters: {
        type: "object",
        properties: {
          company: {
            type: "string",
            description: "Company slug for this refund"
          },
          charge_id: {
            type: "string",
            description: "Stripe charge ID to refund"
          },
          amount: {
            type: "number",
            description: "Amount to refund in euros (optional for partial refund)"
          },
          reason: {
            type: "string",
            description: "Reason for the refund",
            enum: ["duplicate", "fraudulent", "requested_by_customer"]
          }
        },
        required: ["company", "charge_id"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "apply_coupon",
      description: "Create and apply a discount coupon",
      parameters: {
        type: "object",
        properties: {
          company: {
            type: "string",
            description: "Company slug for this coupon"
          },
          coupon_id: {
            type: "string",
            description: "Unique coupon identifier"
          },
          discount_type: {
            type: "string",
            description: "Type of discount",
            enum: ["percent", "amount"]
          },
          discount_value: {
            type: "number",
            description: "Discount value (percentage or amount in euros)"
          },
          duration: {
            type: "string",
            description: "How long the coupon lasts",
            enum: ["once", "repeating", "forever"]
          },
          duration_in_months: {
            type: "number",
            description: "Number of months for repeating coupons"
          }
        },
        required: ["company", "coupon_id", "discount_type", "discount_value", "duration"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "get_stripe_tools",
      description: "Get available Stripe Agent Toolkit tools for a company",
      parameters: {
        type: "object",
        properties: {
          company: {
            type: "string",
            description: "Company slug to get restricted tools for"
          }
        },
        required: ["company"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "web_search",
      description: "Search the web for current information, competitors, market data, SEO keywords, news, or any topic. Returns top results with title, URL, and snippet.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query — be specific for better results (e.g., 'Portuguese tax calculator SaaS competitors 2025')"
          },
          count: {
            type: "number",
            description: "Number of results to return (1-10, default: 5)",
            default: 5
          }
        },
        required: ["query"]
      }
    }
  }
];

// Type-safe tool call handler interface
export interface HiveToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface HiveToolResult {
  toolCallId: string;
  result: any;
  error?: string;
}