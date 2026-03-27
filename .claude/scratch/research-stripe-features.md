# Stripe Feature Set Research for Hive

**Date:** 2026-03-26
**Purpose:** Comprehensive inventory of Stripe features relevant to an autonomous venture orchestrator managing multiple SaaS companies.

---

## 1. PRICING TIERS OVERVIEW

### What's Truly FREE (included with standard 2.9% + 30c processing)

| Feature | Cost | Notes |
|---------|------|-------|
| **Payment Links** | FREE | No-code payment pages, shareable URLs, API-creatable |
| **Checkout Sessions** | FREE | Hosted or embedded payment pages, highly customizable |
| **Elements** | FREE | Embeddable UI components (card inputs, payment forms) |
| **Customer Portal** | FREE | Self-service billing management for customers |
| **Webhooks** | FREE | 450+ event types, HMAC-SHA256 signed, 3-day retry |
| **Products/Prices API** | FREE | Full product catalog management |
| **Customers API** | FREE | Customer records, metadata, payment methods |
| **Payment Intents API** | FREE | Payment lifecycle management |
| **Subscriptions API** | FREE | Create/manage recurring billing (but see Billing fee below) |
| **Subscription Schedules** | FREE | Automate plan changes across phases |
| **Coupons & Promotion Codes** | FREE | Create, manage, apply discounts |
| **Free Trials** | FREE | Up to 730 days, configurable end behavior |
| **Metadata** | FREE | 50 key-value pairs per object |
| **Radar (basic)** | FREE | ML fraud detection on standard pricing (normally 5c/txn) |
| **Apple Pay / Google Pay** | FREE | Standard processing rate applies |
| **Entitlements API** | FREE | Map features to products, gate access by subscription |
| **Test Mode** | FREE | Full sandbox environment |
| **Test Clocks** | FREE | Time-travel simulation for billing cycles |
| **Stripe CLI** | FREE | Build, test, manage from command line |
| **Sandboxes** | FREE | Isolated test environments |
| **Dashboard** | FREE | Full management UI |
| **Reporting (basic)** | FREE | Standard reports in dashboard |
| **Search API** | FREE | Search across Stripe objects |
| **Agent Toolkit** | FREE | AI agent integration (Python + TypeScript) |
| **MCP Server** | FREE | 26 tools for AI assistant integration |
| **PCI Compliance** | FREE | Handled by Stripe |

### Products with ADDITIONAL Fees

| Product | Cost | Notes |
|---------|------|-------|
| **Stripe Billing** | **0.7% of billing volume** | Subscriptions + recurring invoices. Required for metered billing, smart retries, dunning. Applies to ALL billing volume including off-Stripe. |
| **Stripe Invoicing (Starter)** | **0.4% per invoice** | 25 free invoices/month, hosted invoice page |
| **Stripe Invoicing (Plus)** | **0.5% per invoice** | No free tier. Adds auto-collection, reconciliation, quotes |
| **Stripe Tax** | **0.5% per transaction** | Automatic sales tax/VAT/GST calculation |
| **Radar for Fraud Teams** | **2c/txn** (with standard pricing) or **7c/txn** standalone | Advanced fraud rules, manual review queues |
| **Stripe Sigma** | **2c/txn + $10/mo** | SQL analytics on Stripe data |
| **Revenue Recognition** | **0.25% of volume** | Was free on Billing until June 2025 |
| **Data Pipeline** | **3c/txn** | Sync Stripe data to warehouse |
| **Connect** | **0.25% + 25c payout fee** (capped at $25) | Multi-party payments, marketplace features |
| **Identity** | **$1.50/verification** | ID verification |
| **Issuing** | Per-card fees | Virtual/physical card issuance |
| **Terminal** | Hardware + per-txn fees | In-person payments |
| **Atlas** | **$500 one-time** | Company incorporation |
| **Custom Checkout domain** | **$10/month** | Custom domain for checkout |
| **Custom Billing domain** | **$10/month** | Custom domain for billing portal |
| **Climate** | Variable | Carbon removal contributions |

---

## 2. FREE API CAPABILITIES (Detailed)

### Products & Prices
- Create/update/delete products programmatically
- Multiple prices per product (different currencies, billing intervals)
- Recurring and one-time prices
- Tiered, volume, graduated, package pricing models
- Bulk import via API
- Product metadata for custom attributes

### Customers
- Create/update/delete customer records
- Store multiple payment methods per customer
- Customer metadata (50 key-value pairs)
- Tax ID management
- Shipping address storage
- Customer balance (credit system)

### Payment Links (no-code)
- Create via API or Dashboard
- Reusable links
- Customizable (branding, fields, quantities)
- Support subscriptions and one-time payments
- Adjustable quantities
- Custom fields (up to 3)
- After-payment redirects
- Automatic tax collection (with Tax)

### Checkout Sessions
- Hosted or embedded payment page
- One-time payments and subscriptions
- Custom fields (up to 3)
- Adjustable quantities
- Shipping address collection
- Tax collection (with Tax add-on)
- Metadata passthrough
- Custom branding
- 100+ payment methods
- No-cost orders (free trials, 100% off coupons)
- Consent collection

### Customer Portal (self-service)
- Subscription management (cancel, pause, resume, upgrade, downgrade)
- Payment method updates
- Invoice history/downloads
- Billing address updates
- Deep links to specific portal sections
- Configurable via API or Dashboard
- Fully branded

### Subscriptions
- Create/update/cancel subscriptions
- Multiple items per subscription
- Proration on plan changes
- Subscription pausing/resuming
- Pending updates (schedule changes for next cycle)
- Subscription metadata

### Subscription Schedules
- Multi-phase subscriptions
- Automate plan transitions (upgrades/downgrades)
- Schedule coupon application/removal
- Phase-specific pricing
- Automatic transitions on end_date

### Coupons & Promotions
- Percentage or fixed-amount discounts
- Duration: once, repeating, forever
- Redemption limits
- Expiration dates
- Customer-facing promotion codes
- Multiple discounts per subscription
- Custom coupon logic (compute discount dynamically)

### Free Trials
- Up to 730 days (2 years)
- No payment method required option
- Configurable end behavior (cancel, pause, charge)
- Trial-specific webhooks (trial_will_end 3 days before)

### Entitlements
- Define features in Stripe
- Map features to products
- Query active entitlements per customer
- Webhook on entitlement changes
- Gate access based on subscription status

### Metadata System
- 50 key-value pairs per object
- Keys up to 40 chars, values up to 500 chars
- Available on: customers, subscriptions, invoices, charges, products, prices, checkout sessions, payment intents, etc.
- Searchable via API
- Passed through webhooks

---

## 3. STRIPE BILLING (0.7% additional fee)

### What you get for the 0.7%:
- **Smart Retries (dunning)**: ML-optimized retry timing for failed payments
- **Revenue recovery emails**: Automated customer notifications for failed payments
- **Billing Meter API**: Usage-based billing infrastructure
  - Meter events at 1,000/sec (API v1) or 10,000/sec (API v2 streams)
  - 35-day retroactive event recording
  - Aggregation and analytics
- **Usage-based pricing models**: Per-unit, tiered, volume, graduated, package
- **Invoice customization**: Line items, memo, footer, metadata
- **Automatic proration**: On subscription changes
- **Billing thresholds**: Trigger invoices at usage/amount thresholds
- **Credit grants and balances**: Pre-paid credit systems
- **Multi-currency subscriptions**
- **Subscription lifecycle automation**

### LLM Token Billing (included in Billing)
- `@stripe/token-meter` package for OpenAI, Anthropic, Gemini
- `@stripe/ai-sdk` for Vercel AI SDK integration
- Automatic token counting and metering
- Customer-level consumption tracking
- Configurable markup
- Currently in private preview / waitlist

---

## 4. WEBHOOKS (Complete Reference)

### Retry Policy
- **Live mode**: Up to 3 days with exponential backoff
  - Immediately, 5 min, 30 min, 2 hrs, 5 hrs, 10 hrs, then every 12 hrs
- **Sandbox/Test**: 3 retries over a few hours
- Events NOT guaranteed in order
- Events may be sent MORE than once (design for idempotency)

### Signing
- HMAC-SHA256 signature in `Stripe-Signature` header
- Includes timestamp (t) to prevent replay attacks
- Unique secret per endpoint
- Verify with Stripe SDK: `stripe.webhooks.constructEvent()`

### Key Event Categories (450+ total events)
| Category | Key Events |
|----------|-----------|
| **Checkout** | session.completed, session.expired, async_payment_succeeded/failed |
| **Payment Intent** | created, succeeded, failed, canceled, processing, requires_action |
| **Customer** | created, updated, deleted |
| **Subscription** | created, updated, deleted, paused, resumed, trial_will_end, pending_update_applied/expired |
| **Invoice** | created, finalized, paid, payment_failed, payment_succeeded, upcoming, overdue, voided |
| **Charge** | succeeded, failed, refunded, disputed |
| **Dispute** | created, updated, closed, funds_withdrawn, funds_reinstated |
| **Product/Price** | created, updated, deleted |
| **Payment Link** | created, updated |
| **Payment Method** | attached, detached, updated, automatically_updated |
| **Coupon** | created, updated, deleted |
| **Promotion Code** | created, updated |
| **Billing Portal** | configuration.created/updated, session.created |
| **Billing Meter** | created, updated, deactivated, reactivated |
| **Billing Alert** | triggered |
| **Billing Credit** | balance_transaction.created, credit_grant.created/updated |
| **Entitlements** | active_entitlement_summary.updated |
| **Payout** | created, paid, failed, canceled |
| **Refund** | created, updated, failed |
| **Radar** | early_fraud_warning.created/updated |
| **Review** | opened, closed |
| **Subscription Schedule** | created, updated, completed, canceled, aborted, released, expiring |
| **Reporting** | report_run.succeeded/failed |
| **Test Helpers** | test_clock.advancing/ready/created/deleted |

---

## 5. STRIPE CLI & TESTING

### CLI Capabilities
- `stripe listen` — Forward webhooks to localhost (no tunneling needed)
- `stripe trigger <event>` — Trigger specific webhook events
- `stripe logs tail` — Real-time API request log streaming
- `stripe resources create/retrieve/update/delete` — Direct CRUD on any Stripe object
- `stripe samples` — Clone sample integrations
- `stripe fixtures` — Load test data
- Works in both test and live mode

### Test Clocks (Billing Simulations)
- Create a clock with a frozen time
- Advance time forward to simulate billing cycles
- Test trial expirations, renewals, payment failures, dunning
- Can advance up to 2 intervals at a time
- Triggers real webhook events in test mode
- Full API support (`test_helpers.test_clock.*`)

### Sandboxes
- Isolated test environments (separate from test mode)
- Independent data, configurations, settings
- No risk to live or test mode data
- Multiple sandboxes possible

### Test Cards
- Simulate successful payments, declines, fraud, 3D Secure
- Test specific error codes
- Test international cards
- Test specific card brands

---

## 6. STRIPE AGENT TOOLKIT & AI INTEGRATION

### Agent Toolkit (`stripe-agent-toolkit` / `@stripe/agent-toolkit`)
- **Languages**: Python 3.11+, TypeScript/Node 18+
- **Frameworks**: OpenAI Agent SDK, LangChain, CrewAI, Vercel AI SDK
- **How it works**: Exposes Stripe API operations as function-calling tools for LLMs
- **Security**: Use restricted API keys (`rk_*`) to limit agent access
- **Context**: Supports `account` context for connected accounts (multi-tenant)
- **Cost**: FREE (open source, MIT license)

### Stripe MCP Server (26 tools)
- Run locally: `npx -y @stripe/mcp --api-key=YOUR_KEY`
- Available tools:
  - `get_stripe_account_info`, `retrieve_balance`
  - `create_customer`, `list_customers`
  - `create_product`, `list_products`
  - `create_price`, `list_prices`
  - `create_payment_link`
  - `list_payment_intents`
  - `create_invoice`, `create_invoice_item`, `finalize_invoice`, `list_invoices`
  - `create_coupon`, `list_coupons`
  - `list_subscriptions`, `update_subscription`, `cancel_subscription`
  - `list_disputes`, `update_dispute`
  - `create_refund`
  - `search_stripe_resources`, `fetch_stripe_resources`
  - `search_stripe_documentation`

### Agentic Commerce Suite (Dec 2025)
- Product discoverability for AI agents
- Simplified checkout for agent-initiated purchases
- Agentic payments via single integration
- Designed for AI shopping agents

### Token Metering
- `@stripe/token-meter`: Framework-agnostic LLM billing
  - OpenAI, Anthropic, Google Gemini support
  - Automatic token counting → Stripe Billing Meter
- `@stripe/ai-sdk`: Vercel AI SDK integration
  - Middleware for billing in AI apps

---

## 7. CONNECT vs SINGLE ACCOUNT (Multi-Business Architecture)

### Single Account (Current Hive approach)
- One Stripe account, multiple products
- Simpler setup, no additional fees
- All revenue in one account
- Limitations: all companies share one Stripe dashboard, one set of branding, one bank account

### Connect (Platform model)
- **Standard Connect**: Connected accounts manage their own Stripe dashboard
- **Express Connect**: Simplified onboarding, you manage most things
- **Custom Connect**: Full control, embedded everything
- **Additional cost**: 0.25% + 25c per payout (capped at $25)
- **Benefits for Hive**:
  - Separate accounts per company (clean financials)
  - Per-company branding, bank accounts
  - Separate dispute/chargeback management
  - Platform fee collection
  - Tax reporting per connected account
  - Independent customer management
- **When to use**: When companies need true financial separation or when Hive takes a platform fee

### Recommendation for Hive
For early stage (1-2 companies): single account with product separation is sufficient.
For scale (3+ companies): Connect with Express or Custom accounts gives proper financial separation.

---

## 8. FEATURES ESPECIALLY RELEVANT TO HIVE

### Autonomous Company Management
1. **Products/Prices API** — Programmatically create entire product catalogs per company
2. **Payment Links** — Generate no-code checkout URLs for any product (zero frontend work)
3. **Checkout Sessions** — Full checkout flows created via API
4. **Customer Portal** — Zero-maintenance billing self-service
5. **Subscriptions + Schedules** — Automate plan lifecycle (trials, upgrades, downgrades, cancellations)
6. **Entitlements** — Map features to subscription tiers, gate access automatically
7. **Webhooks** — React to every payment event programmatically
8. **Metadata** — Store company_id, agent context, etc. on every Stripe object

### Revenue Operations (Automated)
1. **Coupons/Promotions** — Launch marketing campaigns programmatically
2. **Free Trials** — Test market fit with configurable trial periods
3. **Smart Retries** — Automatic failed payment recovery (Billing required)
4. **Dunning emails** — Automated customer communication for failed payments
5. **Customer Portal** — Reduce churn by letting customers self-service

### Agent Integration
1. **Agent Toolkit** — Let Hive agents create products, prices, payment links, manage subscriptions
2. **MCP Server** — 26 tools accessible to Claude/LLM agents
3. **Token Metering** — If any Hive company sells AI, built-in LLM billing
4. **Restricted API Keys** — Per-agent security boundaries

### Testing & Validation
1. **Test Clocks** — Simulate entire subscription lifecycles in minutes
2. **Sandboxes** — Isolated environments per company
3. **CLI** — Automate testing from CI/CD
4. **Webhook simulation** — Test event handling without real transactions

### Analytics (Free vs Paid)
- **FREE**: Dashboard reports, basic analytics, search API
- **PAID**: Sigma (SQL, 2c/txn + $10/mo), Data Pipeline (3c/txn), Revenue Recognition (0.25%)

---

## 9. COST ANALYSIS FOR HIVE

### Scenario: 2 SaaS Companies, Subscription-Based

**If using FREE features only (no Stripe Billing):**
- Payment processing: 2.9% + 30c per transaction
- Can still create subscriptions via API
- NO smart retries, NO dunning, NO metered billing
- Must build own failed payment recovery

**If using Stripe Billing (recommended):**
- Payment processing: 2.9% + 30c per transaction
- Billing fee: 0.7% of billing volume
- Total effective rate: ~3.6% + 30c
- Gets: smart retries, dunning, metered billing, billing meter API, credit grants

**If using Stripe Tax:**
- Additional 0.5% per transaction
- Automatic tax calculation in 50+ countries
- Tax registration monitoring
- Filing assistance

### Minimum Viable Stripe Stack for Hive (FREE)
1. Products/Prices API
2. Payment Links or Checkout Sessions
3. Customer Portal
4. Webhooks
5. Subscriptions API (basic, no smart retries)
6. Entitlements API
7. Agent Toolkit / MCP Server
8. Test Clocks + CLI

### Recommended Stack (with Billing)
All of the above, plus:
1. Stripe Billing (0.7%) — for smart retries, dunning, metered billing
2. Stripe Invoicing Starter (25 free/mo) — for B2B customers
3. Radar basic (free) — fraud protection

---

## Sources

- [Stripe Pricing](https://stripe.com/pricing)
- [Stripe Billing Pricing](https://stripe.com/billing/pricing)
- [Stripe Agent Toolkit (GitHub)](https://github.com/stripe/ai)
- [Stripe MCP Documentation](https://docs.stripe.com/mcp)
- [Stripe Agents Documentation](https://docs.stripe.com/agents)
- [Stripe Webhook Event Types](https://docs.stripe.com/api/events/types)
- [Stripe Webhooks Documentation](https://docs.stripe.com/webhooks)
- [Stripe CLI Documentation](https://docs.stripe.com/stripe-cli)
- [Stripe Test Clocks](https://docs.stripe.com/billing/testing/test-clocks)
- [Stripe Usage-Based Billing](https://docs.stripe.com/billing/subscriptions/usage-based)
- [Stripe Subscription Schedules](https://docs.stripe.com/billing/subscriptions/subscription-schedules)
- [Stripe Entitlements](https://docs.stripe.com/billing/entitlements)
- [Stripe Customer Portal](https://docs.stripe.com/customer-management)
- [Stripe Agentic Commerce Suite](https://stripe.com/blog/agentic-commerce-suite)
- [Stripe Connect Pricing](https://stripe.com/connect/pricing)
- [Stripe LLM Token Billing](https://docs.stripe.com/billing/token-billing)
- [Stripe Billing Changes (Starter/Scale)](https://support.stripe.com/questions/changes-to-the-stripe-billing-starter-and-scale-plans)
- [Stripe Invoicing Pricing](https://support.stripe.com/questions/stripe-invoicing-pricing)
- [Stripe Tax Pricing](https://stripe.com/tax/pricing)
- [Stripe Radar Pricing](https://stripe.com/radar/pricing)
- [Stripe Sigma Pricing](https://stripe.com/sigma/pricing)
- [Stripe Fees 2026 Guide](https://www.wearefounders.uk/a-guide-to-stripe-fees-in-2025-what-founders-need-to-know/)
- [Stripe Pricing Breakdown (Orb)](https://www.withorb.com/blog/stripe-pricing)
- [Stripe Billing Review (Togai)](https://www.togai.com/blog/stripe-billing-pricing-fees/)
- [Stripe Connect Guide 2026](https://greenmoov.app/articles/en/stripe-connect-for-marketplace-payments-explained-account-types-onboarding-and-pricing-2026-guide/)
