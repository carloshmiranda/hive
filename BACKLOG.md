# Backlog

## Immediate (post-deploy)
- [ ] Verify auth flow end-to-end (sign out → sign in → save settings)
- [ ] Add API keys in /settings: Stripe, Resend, Neon API, Vercel token, GitHub PAT, digest email
- [ ] Test webhook delivery (push to repo, check /api/webhooks/github receives it)
- [ ] Test orchestrator dry-run against production API URL

## Short-term
- [ ] Import first company (Flolio or new venture)
- [ ] First nightly cycle end-to-end
- [ ] Daily digest email via Resend
- [ ] Dashboard: show real metrics after first cycle
- [ ] Stripe webhook setup for revenue tracking

## Medium-term
- [ ] Prompt versioning: seed agent_prompts table with initial prompts
- [ ] Playbook: seed with learnings from existing projects
- [ ] Kill Switch evaluation logic
- [ ] Custom domain for Hive dashboard
- [ ] Cloud migration: swap `claude -p` dispatch for Claude Agent SDK

## Cleanup
- [ ] Remove deprecated `fetchConnectionCache` usage in db.ts
- [ ] Clean up duplicate env vars (AUTH_GITHUB_ID vs GITHUB_OAUTH_ID) — pick one
- [ ] Add error handling to settings page for auth failures (show "please sign in" instead of 0/0)
