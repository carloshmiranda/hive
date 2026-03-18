# {{COMPANY_NAME}}

> {{DESCRIPTION}}

## Identity
- **Slug**: {{SLUG}}
- **Target audience**: {{TARGET_AUDIENCE}}
- **Status**: {{STATUS}}
- **Hive company ID**: {{COMPANY_ID}}

## Tech Stack
- Next.js 15 (App Router)
- Tailwind CSS 4
- Neon serverless Postgres
- Stripe Checkout + Customer Portal
- Resend for transactional email
- Deployed on Vercel

## Current Priorities
<!-- Updated by CEO agent each nightly cycle -->
1. (awaiting first cycle)

## Coding Standards
- TypeScript strict mode
- No ORMs — raw SQL with @neondatabase/serverless
- All API routes return `{ ok: boolean, data?: any, error?: string }`
- Use parameterized queries, never string interpolation for SQL
- Tailwind for all styling, no CSS modules
- Components in src/components/, pages in src/app/
- Keep bundle small — no heavy dependencies without justification

## Playbook Insights
<!-- Injected from Hive's shared playbook, filtered by relevance -->
{{PLAYBOOK_ENTRIES}}

## Constraints
- Budget: minimal — free tier infrastructure until revenue justifies upgrades
- No external dependencies unless absolutely necessary
- Mobile-responsive from day one
- Core user flow must work in under 3 clicks
- SEO: every page needs proper meta tags, OG images, structured data

## Infrastructure
- **Vercel project**: {{VERCEL_PROJECT_ID}}
- **Neon project**: {{NEON_PROJECT_ID}}
- **GitHub repo**: {{GITHUB_REPO}}
- **Stripe account**: {{STRIPE_ACCOUNT_ID}}
- **URL**: {{VERCEL_URL}}

## Do NOT
- Install packages without justification
- Store secrets in code — use Vercel env vars
- Make breaking API changes without updating the frontend
- Deploy without running `npm run build` successfully
- Ignore TypeScript errors
