# 🚀 Hive: Autonomous Venture Orchestrator

Build and run multiple digital companies with AI agents. Hive generates business ideas, creates complete web applications, grows them autonomously, and kills the failures. It's like having a tireless business partner that works 24/7.

**🎯 You only approve 4 decisions:** New company, growth strategy, spend >€20, company shutdown. Everything else happens autonomously.

## ✨ What Hive Does

- **🔍 Discovers opportunities** - Scouts markets, analyzes trends, finds profitable niches
- **🏗️ Builds complete apps** - Scaffolds Next.js sites, sets up payments, deploys to production
- **📈 Grows autonomously** - Creates SEO content, manages social media, runs outreach campaigns
- **💰 Tracks performance** - Monitors metrics, revenue, user engagement across all companies
- **🧠 Learns and adapts** - Improves from successes and failures across the portfolio
- **⚡ Operates 24/7** - No downtime, works while you sleep, Mac not required

## 🎥 How It Works

**Phase 1: Idea Generation**
- Scout agent researches markets via web search
- CEO evaluates ideas for automation potential and market size
- You approve which companies to build

**Phase 2: Company Creation**
- Engineer provisions GitHub repo, Vercel hosting, Neon database, Stripe payments
- Boilerplate Next.js app deployed with authentication and checkout flow
- Company enters autonomous build cycles

**Phase 3: Autonomous Growth**
- Growth agent creates blog content, SEO pages, social media posts
- Outreach agent finds prospects and sends personalized cold emails
- Ops agent monitors performance and fixes issues
- CEO reviews progress and adjusts strategy

**Phase 4: Portfolio Management**
- Daily digest emails with portfolio performance
- Kill switch for underperforming companies
- Cross-company learning improves future ventures

## 🤖 The AI Team

| Agent | Role | Capabilities |
|-------|------|-------------|
| **🎯 CEO** | Strategic planning | Plans build cycles, reviews performance, portfolio analysis |
| **🔍 Scout** | Market research | Finds opportunities, analyzes competitors, discovers SEO keywords |
| **⚙️ Engineer** | Technical execution | Builds features, fixes bugs, scaffolds new companies |
| **📈 Growth** | Content & SEO | Creates blog posts, landing pages, social media content |
| **📧 Outreach** | Business development | Finds leads, writes cold emails, manages follow-ups |
| **🛡️ Ops** | Monitoring & health | Tracks metrics, detects issues, ensures uptime |
| **🔬 Evolver** | Continuous improvement | Analyzes performance, optimizes AI prompts |

## 🏗️ Architecture

Hive runs 7 AI agents across a hybrid cloud architecture optimized for cost and performance:

**🧠 Brain Tier (GitHub Actions + Claude)**
- Strategic agents (CEO, Scout, Engineer, Evolver) use Claude Opus/Sonnet
- Run on GitHub Actions with 1-year OAuth token from Claude Max 5x
- Handle planning, analysis, code generation, and decision-making

**⚡ Worker Tier (Vercel Serverless + Free APIs)**
- Operational agents (Growth, Outreach, Ops) use Gemini Flash and Groq
- Run on Vercel serverless functions for speed and scalability
- Handle content creation, outreach, and monitoring

**🔄 Event-Driven Execution**
No scheduled crons - agents work on-demand via three triggers:

- **Events** — Payments, deploys, GitHub issues trigger instant responses
- **Chains** — Agents dispatch each other: Scout → Growth → CEO Review
- **Conditions** — Sentinel checks hourly for work that needs doing

```
┌─────────────┐    ┌──────────────┐    ┌─────────────────┐
│   Events    │    │    Chains    │    │   Conditions    │
│ (payments,  │───▶│ Scout → CEO  │───▶│ Sentinel (1h)   │
│  deploys)   │    │ CEO → Growth │    │ (health checks) │
└─────────────┘    └──────────────┘    └─────────────────┘
                           │                     │
                           ▼                     ▼
                  ┌─────────────────────────────────────┐
                  │        AI Agent Execution           │
                  │  (GitHub Actions + Vercel)          │
                  └─────────────────────────────────────┘
```

## 💰 Cost Structure

| Service | Tier | Monthly Cost | Usage |
|---------|------|--------------|-------|
| **Claude Max 5x** | Premium | $100 | Brain agents (CEO, Scout, Engineer, Evolver) |
| **GitHub Actions** | Free (private) | $0 | 2,000 min/mo for brain agents |
| **GitHub Actions** | Free (public) | $0 | Unlimited for company repos |
| **Vercel** | Hobby | $0 | Worker agents + company hosting |
| **Neon Database** | Free | $0 | 0.5 GB, 10 projects |
| **Gemini API** | Free | $0 | 250 req/day for Growth/Outreach |
| **Groq API** | Free | $0 | 6,000 req/day for Ops monitoring |
| **Resend Email** | Free | $0 | 100 emails/day |

**🎯 Total: $100/month** - same as a Claude subscription you might already have!

### 📊 What You Get

- **Unlimited digital companies** (subject to free tier limits)
- **24/7 autonomous operation** (no Mac required)
- **Full source code** and operational visibility
- **Cross-company learning** system
- **Built-in metrics** and performance tracking
- **Email digest** with daily portfolio updates

## 🚀 Key Features

### 🎯 Autonomous Company Creation
- Generates 3 business ideas with market research
- Creates GitHub repos with full Next.js applications
- Sets up Stripe payments, authentication, and databases
- Deploys to production on Vercel automatically

### 📈 Intelligent Growth Engine
- Writes SEO-optimized blog content
- Creates social media posts and campaigns
- Builds email marketing sequences
- Manages cold outreach with personalization

### 🛡️ Built-in Monitoring & Healing
- Tracks website performance and uptime
- Monitors revenue, user growth, and engagement
- Auto-fixes common deployment issues
- Escalates complex problems for human review

### 🧠 Cross-Company Learning
- Successful strategies automatically propagate to other companies
- Failed approaches are documented and avoided
- Playbook grows smarter with each venture
- Knowledge compounds across the portfolio

### 📊 Portfolio Management Dashboard
- Real-time view of all companies and metrics
- Approval gates for major decisions
- Task tracking and agent activity logs
- Daily email digest with key insights

## 🎮 How to Interact

**Dashboard** (Web UI)
- View portfolio performance and metrics
- Approve/reject company proposals
- Review agent activity and logs
- Issue directives via command bar

**GitHub Issues** (Programmatic)
- `directive` label → CEO breaks down into tasks
- `feature` label → Engineer implements immediately
- `research` label → Scout investigates market
- Mention @agent → Direct agent communication

**Email** (Notifications)
- Daily portfolio digest at 8am UTC
- Approval notifications for gates
- Error alerts and escalations

## 🛠️ Quick Setup

**Prerequisites:** Claude Max 5x subscription, GitHub account, Vercel account

```bash
# 1. Fork this repo and clone it
git clone https://github.com/yourusername/hive.git

# 2. Generate Claude OAuth token
claude setup-token

# 3. Set up GitHub Actions secrets
# (DATABASE_URL, CLAUDE_CODE_OAUTH_TOKEN, GH_PAT, CRON_SECRET)

# 4. Deploy to Vercel
vercel deploy --prod

# 5. Run database migration
psql $DATABASE_URL < schema.sql
```

**📖 [Complete Setup Guide →](./SETUP.md)**

The setup guide includes:
- Step-by-step instructions for each service
- API key configuration for free tiers
- Email domain setup for outreach
- Troubleshooting common issues

## 📁 Project Structure

```
hive/
├── 🤖 .github/workflows/    # AI agent definitions
│   ├── hive-ceo.yml        # Strategic planning & portfolio management
│   ├── hive-scout.yml      # Market research & idea generation
│   ├── hive-engineer.yml   # Code implementation & deployments
│   └── hive-sentinel.yml   # Health monitoring (hourly, legacy fallback)
├── 🎯 src/app/
│   ├── api/agents/         # Worker agent dispatch & OIDC auth
│   ├── api/webhooks/       # Stripe/GitHub event handlers
│   ├── page.tsx           # Portfolio dashboard
│   └── settings/          # API key management
├── 📚 Documentation
│   ├── SETUP.md           # Detailed setup instructions
│   ├── ARCHITECTURE.md    # System design & data flow
│   ├── DECISIONS.md       # Architectural decision records
│   └── BRIEFING.md        # Current operational state
├── 🏗️ templates/          # Company boilerplate
└── 🗃️ schema.sql          # Database structure (17 tables)
```

## 📚 Documentation

- **[SETUP.md](./SETUP.md)** - Complete setup guide with troubleshooting
- **[ARCHITECTURE.md](./ARCHITECTURE.md)** - Deep dive into system design
- **[BRIEFING.md](./BRIEFING.md)** - Current state and recent changes
- **[DECISIONS.md](./DECISIONS.md)** - Why things are built this way
- **[MISTAKES.md](./MISTAKES.md)** - Production learnings and fixes

## 🌟 Example Companies

Hive can build various types of digital businesses:

**SaaS Applications**
- Productivity tools, calculators, form builders
- Authentication, payments, and user dashboards
- Feature development cycles with user feedback

**Content Businesses**
- SEO-optimized blogs with automated posting
- Newsletter platforms with subscriber management
- Affiliate marketing sites with conversion tracking

**Service Marketplaces**
- Directory sites with search and filters
- Lead generation with contact forms
- Social proof with testimonials and reviews

## 🤝 Contributing

This is an open-source project! Contributions welcome:

1. **Fork and experiment** - try building your own venture portfolio
2. **Share learnings** - document what works in your market/niche
3. **Improve agents** - better prompts, new capabilities, bug fixes
4. **Add integrations** - new LLM providers, marketing tools, analytics

## 📄 License

MIT License - feel free to fork, modify, and create your own AI venture empire!
