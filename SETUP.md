# Hive Setup Guide

> Step-by-step instructions to fork and run your own Hive autonomous venture orchestrator.

## Prerequisites

Before setting up Hive, you'll need:

- **Claude Max 5x subscription** ($100/mo) - [Subscribe here](https://claude.ai/pricing)
- **GitHub account** with private repo access
- **Vercel account** (Hobby tier is free, Pro tier $20/mo recommended)
- **Neon account** (free tier sufficient to start)
- Basic familiarity with Git, terminal commands, and GitHub Actions

## 1. Fork the Repository

1. **Fork this repository** to your GitHub account
2. **Clone your fork** locally:
   ```bash
   git clone https://github.com/yourusername/hive.git
   cd hive
   ```

## 2. Set Up Claude Max 5x OAuth Token

This is the most important step - Hive's intelligence comes from Claude.

1. **Generate a 1-year OAuth token** from your Max 5x subscription:
   ```bash
   claude setup-token
   ```

2. **Copy the token** (starts with `sk-ant-oat01-...`) - you'll need it for GitHub Actions

## 3. Create Neon Database

1. **Sign up** at [neon.tech](https://neon.tech)
2. **Create a new project** called "hive"
3. **Copy the connection string** from your project dashboard (looks like `postgresql://username:password@host/dbname`)
4. **Run the schema migration**:
   ```bash
   psql "your_neon_connection_string" < schema.sql
   ```

## 4. Configure GitHub Actions Secrets

Go to your forked repo → Settings → Secrets and variables → Actions, then add:

| Secret Name | Value | Purpose |
|-------------|--------|---------|
| `CLAUDE_CODE_OAUTH_TOKEN` | `sk-ant-oat01-...` | Claude Max 5x token from step 2 |
| `DATABASE_URL` | `postgresql://...` | Neon connection string |
| `CRON_SECRET` | Random 32-char hex | Secure Vercel cron endpoints |
| `GH_PAT` | Fine-grained token | GitHub API access for repos |

### Creating the GitHub Personal Access Token

1. Go to GitHub Settings → Developer settings → Personal access tokens → Fine-grained tokens
2. Generate new token with these permissions:
   - **Repository access**: All repositories
   - **Contents**: Write (for creating company repos)
   - **Actions**: Write (for triggering workflows)
   - **Pull requests**: Write (for creating PRs)
   - **Issues**: Write (for GitHub Issues integration)

### Generating CRON_SECRET

```bash
openssl rand -hex 32
```

## 5. Deploy to Vercel

1. **Install Vercel CLI**:
   ```bash
   npm i -g vercel
   ```

2. **Deploy to production**:
   ```bash
   vercel deploy --prod
   ```

3. **Add environment variables** in Vercel dashboard:
   ```bash
   DATABASE_URL=your_neon_connection_string
   NEXTAUTH_URL=https://your-app.vercel.app
   NEXTAUTH_SECRET=run_openssl_rand_-base64_32
   GITHUB_ID=your_github_oauth_app_id
   GITHUB_SECRET=your_github_oauth_app_secret
   ```

### Setting up GitHub OAuth App

1. Go to GitHub Settings → Developer settings → OAuth Apps → New OAuth App
2. **Application name**: "Your Hive Instance"
3. **Homepage URL**: `https://your-app.vercel.app`
4. **Authorization callback URL**: `https://your-app.vercel.app/api/auth/callback/github`
5. Copy the Client ID and Client Secret to your Vercel env vars

## 6. Configure API Keys (Optional but Recommended)

To reduce Claude API usage costs, add free-tier LLM API keys:

### Gemini API (Free: 250 requests/day)

1. Go to [Google AI Studio](https://aistudio.google.com/apikey)
2. Create API key (no credit card required)
3. Add to Vercel: `GEMINI_API_KEY=your_key`
4. Add to GitHub Actions secrets: `GEMINI_API_KEY=your_key`

### Groq API (Free: ~6,000 requests/day)

1. Go to [Groq Console](https://console.groq.com/keys)
2. Create API key (no credit card required)
3. Add to Vercel: `GROQ_API_KEY=your_key`

### Email Setup (Resend)

1. Sign up at [resend.com](https://resend.com) (free: 100 emails/day)
2. Get API key from dashboard
3. Add to Vercel: `RESEND_API_KEY=your_key`
4. For outbound emails, you'll need to verify a domain (see [Email Domain Setup](#email-domain-setup))

## 7. Test the Installation

1. **Trigger the CEO agent manually**:
   - Go to your GitHub repo → Actions
   - Find "Hive CEO" workflow → Run workflow
   - Check logs to ensure it runs without errors

2. **Access the dashboard**:
   - Visit `https://your-app.vercel.app`
   - Sign in with GitHub
   - You should see the Hive dashboard

3. **Check database connectivity**:
   - Dashboard should show "No companies yet" (empty state)
   - No error messages about database connection

## 8. Email Domain Setup (Optional)

To send outreach emails, you need a verified domain:

### Buy a Domain (€2-10/year)
- Recommended: Namecheap, Cloudflare Registrar, or Porkbun
- Example: `yourhive.com`, `gethive.email`

### Add to Vercel
1. Vercel Dashboard → Domains → Add Domain
2. Point your domain's nameservers to Vercel:
   - `ns1.vercel-dns.com`
   - `ns2.vercel-dns.com`

### Set up Resend
1. Resend Dashboard → Domains → Add Domain
2. Enter `mail.yourdomain.com`
3. Add the 3 DNS records Resend shows to your domain in Vercel
4. Wait for verification (green status)
5. Add to Vercel env: `SENDING_DOMAIN=mail.yourdomain.com`

## 9. First Company Test

Once everything is set up:

1. **Create a directive** via dashboard command bar:
   ```
   Scout: research 3 SaaS ideas for productivity tools
   ```

2. **The system should**:
   - Create a GitHub issue with your directive
   - Trigger the Scout agent via webhook
   - Scout researches and creates 3 company proposals
   - CEO evaluates each proposal
   - Creates approval gates in the dashboard

3. **Approve a company** to see the full cycle:
   - Provisioning (GitHub repo, Vercel project, Neon DB, Stripe)
   - First build cycles with Engineer and Growth agents
   - Content creation and deployment

## Troubleshooting

### "Claude API Error" in Actions
- Verify your `CLAUDE_CODE_OAUTH_TOKEN` is correct and hasn't expired
- Check your Claude Max 5x subscription is active
- Tokens expire after 1 year - generate a new one with `claude setup-token`

### "Database Connection Failed"
- Verify your `DATABASE_URL` is correct
- Check that schema.sql was applied successfully
- Ensure Neon project is not paused (free tier pauses after 7 days inactivity)

### "GitHub API Rate Limit"
- Your `GH_PAT` might have insufficient permissions
- Create a new fine-grained token with broader repository access

### Workflows Not Triggering
- Check that all required secrets are set in GitHub Actions
- Verify `CRON_SECRET` matches between GitHub and Vercel
- Check webhook endpoints are accessible (Vercel deployment succeeded)

### No Companies Being Created
- Scout proposals pile up without approval - check dashboard for pending approval gates
- CEO might not have proper database access to create companies
- Check agent_actions table for error logs

## Architecture Overview

Once running, your Hive instance will:

1. **Monitor continuously** via Sentinel (every 4 hours)
2. **Generate business ideas** when pipeline is low
3. **Build companies** autonomously with AI agents
4. **Track metrics** and performance
5. **Report daily** via email digest
6. **Learn and improve** from successes and failures

The system is designed to run completely autonomously after setup. Carlos (you) only needs to approve 4 gates:
- New company creation
- Growth strategy changes
- Spend >€20
- Company shutdown

Everything else happens automatically!

## What's Next?

- **Read [ARCHITECTURE.md](./ARCHITECTURE.md)** to understand how the system works
- **Check [BRIEFING.md](./BRIEFING.md)** for current operational status
- **Browse the dashboard** to see portfolio, tasks, and approvals
- **Monitor GitHub Actions** to watch agents working
- **Review daily digest emails** for portfolio performance

## Support

This is an open-source project. For issues:

1. Check [MISTAKES.md](./MISTAKES.md) for known issues and solutions
2. Search existing GitHub Issues
3. Create a new issue with:
   - Setup step where you're stuck
   - Error messages from logs
   - Screenshots of the problem

Happy building! 🚀