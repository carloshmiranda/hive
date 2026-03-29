# Stripe MCP Server Integration

## Implementation Status

**Task:** Add @stripe/mcp to .mcp.json so Claude Code sessions and agents can perform Stripe operations directly.

## Required Changes

### 1. MCP Configuration (.mcp.json)

The `.mcp.json` file needs to be updated to include the Stripe MCP server. Add the following configuration:

```json
{
  "mcpServers": {
    "hive": {
      "type": "stdio",
      "command": "node",
      "args": ["mcp/server.js"],
      "env": {
        "DATABASE_URL": "${DATABASE_URL}",
        "CRON_SECRET": "${CRON_SECRET}",
        "NEXT_PUBLIC_URL": "${NEXT_PUBLIC_URL}"
      }
    },
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GH_PAT}"
      }
    },
    "stripe": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@stripe/mcp"],
      "env": {
        "STRIPE_API_KEY": "${STRIPE_MCP_KEY}"
      }
    }
  }
}
```

### 2. Environment Variable

A new environment variable `STRIPE_MCP_KEY` needs to be configured with a restricted Stripe API key (`rk_*` format) for security.

## Stripe MCP Server Capabilities

The @stripe/mcp package provides 26 tools for Stripe operations:

### Account & Balance
- `get_stripe_account_info` - Retrieve Stripe account information
- `retrieve_balance` - Get current account balance

### Customer Management
- `create_customer` - Create new customers
- `list_customers` - List and search customers

### Product & Pricing
- `create_product` - Create products programmatically
- `list_products` - List all products
- `create_price` - Create pricing for products
- `list_prices` - List all prices

### Payment Operations
- `create_payment_link` - Generate payment links for products
- `list_payment_intents` - List payment intents

### Invoicing
- `create_invoice` - Create invoices
- `create_invoice_item` - Add line items to invoices
- `finalize_invoice` - Finalize invoices for payment
- `list_invoices` - List all invoices

### Discounts & Promotions
- `create_coupon` - Create discount coupons
- `list_coupons` - List available coupons

### Subscription Management
- `list_subscriptions` - List customer subscriptions
- `update_subscription` - Modify existing subscriptions
- `cancel_subscription` - Cancel subscriptions

### Dispute Handling
- `list_disputes` - List payment disputes
- `update_dispute` - Update dispute information

### Refunds
- `create_refund` - Process refunds

### Search & Discovery
- `search_stripe_resources` - Search across Stripe objects
- `fetch_stripe_resources` - Retrieve specific resources
- `search_stripe_documentation` - Query Stripe documentation

## Benefits for Hive

1. **Agent Operations**: Hive agents can directly create products, payment links, and manage subscriptions without custom code
2. **Claude Code Sessions**: Direct Stripe operations during development and maintenance
3. **Reduced Manual Work**: Eliminates need for custom stripe.ts functions for common operations
4. **Security**: Restricted API keys limit agent access to specific operations

## Security Considerations

- Use restricted API keys (`rk_*` prefix) instead of full secret keys
- Restricted keys can be configured to only allow specific operations
- Separate from existing `stripe_secret_key` in settings for different use cases

## Implementation Notes

The current `src/lib/stripe.ts` file contains custom functions for:
- `createProduct()` - Will be supplemented by MCP `create_product` tool
- `getCompanyRevenue()` - Custom logic still needed for company-specific filtering
- `getPortfolioRevenue()` - Custom logic still needed
- `getCompanyMRR()` - Custom logic still needed
- `deactivateCompanyProducts()` - Custom logic still needed

The MCP server provides general Stripe operations while the custom stripe.ts functions provide Hive-specific business logic with metadata filtering.