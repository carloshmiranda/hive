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

## Design & UX Requirements
- Visual design must be allusive to the business domain — use colors, imagery, and language that evoke the industry
- ONE brand color for all interactive elements (buttons, links, highlights) — consistent throughout
- Landing page follows conversion-optimized structure: hero → social proof (real data only) → problem → features (max 3, SVG icons) → how-it-works → FAQ → final CTA
- Headlines must be specific and pass the "so what?" test — no generic "Get started" or "Save time"
- Single conversion goal: every CTA leads to the same action (waitlist or checkout)
- Server Components by default — only use "use client" when interactivity is needed
- Semantic HTML: `<nav>`, `<main>`, `<section>`, `<button>` — never `<div onClick>`
- Color contrast: minimum 4.5:1 for all text
- Every page: unique `<title>`, meta description, OG tags, proper heading hierarchy
- JSON-LD structured data on layout (Organization + WebSite) and FAQ sections

## Constraints
- Budget: minimal — free tier infrastructure until revenue justifies upgrades
- No external dependencies unless absolutely necessary
- Mobile-responsive from day one — `flex-col md:flex-row` for stacking, `px-4 sm:px-6` on containers
- Core user flow must work in under 3 clicks
- SEO: every page needs proper meta tags, OG images, structured data, sitemap.ts, robots.ts
- `<html lang="...">` must match target audience language

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
