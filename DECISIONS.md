# Architectural Decisions

Settled choices — don't re-debate these.

## 2026-03-18: Initial deployment

### Vercel team
Using Eidolon's projects (team_Z4AsGtjfy6pAjCOtvJqzMT8d). All Hive companies will deploy under this team.

### Neon via Vercel Marketplace
Database provisioned through Vercel Storage tab, not a standalone Neon account. This auto-injects DATABASE_URL and related vars into all environments.

### Single Neon database for Hive core
Sub-companies get their own Neon projects (provisioned via Neon API). The Hive orchestrator DB is separate.

### Auth: NextAuth v5 + GitHub OAuth App
Single-user auth. GitHub OAuth App (not GitHub App). `ALLOWED_GITHUB_ID` gates access at sign-in. JWT strategy (no database sessions).

### Env var pattern
Secrets set per-environment in Vercel. Local dev uses `vercel env pull .env.local`. Never commit `.env.local`.

### Cron via Vercel + launchd
Vercel cron handles metrics scraping (8am + 6pm). macOS launchd handles nightly orchestrator (midnight). Cloud migration path: swap launchd for Claude Agent SDK `query()`.
