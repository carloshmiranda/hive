# Stripe MCP Server Configuration

This documents the remaining step to complete the Stripe MCP server integration.

## What's Done
- ✅ Installed `@stripe/mcp` package
- ✅ Added `STRIPE_MCP_API_KEY` to `.env.example`
- ✅ Build verified working

## Manual Step Required

Add the Stripe MCP server configuration to `.mcp.json`:

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
        "STRIPE_API_KEY": "${STRIPE_MCP_API_KEY}"
      }
    }
  }
}
```

## Environment Variable Setup

Set `STRIPE_MCP_API_KEY` to a restricted Stripe API key (prefix: `rk_*`) for security.

## Available Tools

Once configured, the Stripe MCP server provides 26 tools for:
- Create products/prices
- Generate payment links
- List invoices/subscriptions
- Manage customers
- Search resources

This replaces manual Stripe operations currently done through `stripe.ts`.