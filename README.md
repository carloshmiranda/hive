# 🐝 Hive — Venture Orchestrator

An autonomous system that spins up companies, builds MVPs, runs growth, and kills failures. You approve the big decisions. Hive does everything else.

## Architecture

```
┌─────────────────────────────────────────────┐
│  YOUR MAC (intelligence layer)              │
│  ├─ orchestrator.ts (launchd, midnight)     │
│  ├─ claude -p (Max 5x subscription)         │
│  └─ pushes state to Neon + Vercel via APIs  │
└─────────────┬───────────────────────────────┘
              │
┌─────────────▼───────────────────────────────┐
│  VERCEL (serving layer)                     │
│  ├─ Hive Dashboard (Next.js, Hobby plan)    │
│  ├─ Company A site (Pro when revenue)       │
│  ├─ Company B site (Hobby while MVP)        │
│  └─ API routes → Neon                       │
└─────────────┬───────────────────────────────┘
              │
┌─────────────▼───────────────────────────────┐
│  NEON (single source of truth)              │
│  ├─ Hive DB (orchestrator state)            │
│  ├─ Company A DB (its own Neon project)     │
│  └─ Company B DB (its own Neon project)     │
└─────────────────────────────────────────────┘
```

## Setup (one-time, ~45 minutes)

### 1. Prerequisites
- macOS with Claude Code CLI installed and logged into Max 5x
- Node.js 20+, npm, npx, ts-node
- Git configured with GitHub access

### 2. Create accounts (all free tier)
- **Neon**: https://neon.tech → create project "hive" → copy DATABASE_URL
- **Vercel**: https://vercel.com → link GitHub account
- **Stripe**: https://dashboard.stripe.com → enable Connect → get API keys
- **Resend**: https://resend.com → verify domain → get API key
- **GitHub**: create a Personal Access Token with `repo` + `workflow` scopes

### 3. Setup Hive database
```bash
# Run the schema against your Neon project
psql $DATABASE_URL -f schema.sql
```

### 4. Deploy the dashboard
```bash
cd hive
npm install
vercel link        # link to your Vercel account
vercel env add DATABASE_URL         # paste Neon connection string
vercel env add STRIPE_SECRET_KEY    # paste Stripe key
vercel env add RESEND_API_KEY       # paste Resend key
vercel env add GITHUB_TOKEN         # paste GitHub PAT
vercel deploy --prod
```

### 5. Install the orchestrator schedule
```bash
# Create logs directory
mkdir -p ~/code/hive/logs

# Edit the plist to set your DATABASE_URL
nano com.hive.orchestrator.plist

# Install the LaunchAgent
cp com.hive.orchestrator.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.hive.orchestrator.plist

# Test manually
npx ts-node orchestrator.ts --dry-run
```

### 6. Seed your first company
```sql
INSERT INTO companies (name, slug, description, status)
VALUES ('YourFirstIdea', 'your-first-idea', 'Description here', 'approved');
```

The next nightly run will pick it up, provision infrastructure, and start building.

## Daily workflow

1. **Midnight**: Orchestrator wakes, provisions approved companies, onboards imports, processes active companies
2. **~1am**: Cycles complete, digest email sent
3. **Morning**: Read the email, open the dashboard
4. **Command bar**: Type directives like `pawly: add free trial` or `@engineer fix mobile layout` — creates GitHub Issue, processed next cycle
5. **Approve/reject**: Action any pending gates
6. **Import**: Click Import to bring an existing repo under Hive management

## Interacting with Hive

Three ways to communicate with the orchestrator:

1. **Dashboard command bar** — type a directive, it becomes a GitHub Issue, gets processed next cycle
2. **GitHub Issues** — create issues on the Hive repo with labels `hive-directive`, `company:{slug}`, `agent:{name}`
3. **CLI** — run `npx ts-node orchestrator.ts --company pawly` for an immediate single-company cycle

Directive format:
- `pawly: add pricing page` → targets Pawly's CEO agent
- `@engineer refactor the checkout flow` → targets Engineer agent for all companies  
- `increase ad spend to €100` → CEO decides which company

## Importing existing projects

Bring projects like Flolio or acquired codebases under Hive management:

1. Click **Import** in the dashboard
2. Enter the project name, slug, and GitHub URL
3. Hive scans the repo: tech stack, CLAUDE.md presence, env files, tests, CI, Stripe integration
4. A scan report generates an approval gate with an onboarding plan
5. On approval, the Onboarding agent clones, generates missing files, links to Vercel, and registers metrics
6. Existing code is never overwritten — Hive adds alongside what's there

## Commands

```bash
# Full nightly run
npx ts-node orchestrator.ts

# Single company only
npx ts-node orchestrator.ts --company pawly

# Dry run (plan only, no execution)
npx ts-node orchestrator.ts --dry-run

# Check orchestrator logs
tail -f ~/code/hive/logs/orchestrator.stdout.log

# Check launchd status
launchctl list | grep hive
```

## Costs

| Component | Monthly cost |
|-----------|-------------|
| Claude Max 5x | €100 (your existing subscription) |
| Vercel Hobby (dashboard) | €0 |
| Vercel Pro (per live company) | €20 each |
| Neon free (20 projects) | €0 |
| GitHub free | €0 |
| Resend free (3K emails/mo) | €0 |
| Stripe Connect | 0 base, transaction fees only |
| **Total (0 live companies)** | **€100** |
| **Total (2 live companies)** | **€140** |

## Cloud migration

When ready to move the brain off your Mac:
1. Get an Anthropic API key at console.anthropic.com
2. Store it as a GitHub Actions secret
3. The orchestrator's `dispatch()` function swaps from CLI to SDK
4. Same prompts, same state, same everything — just different transport

---

Built by Carlos Miranda · Powered by Claude, Vercel, Neon
