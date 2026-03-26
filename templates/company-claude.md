# {{COMPANY_NAME}}

> {{DESCRIPTION}}

## Identity
- **Slug**: {{SLUG}}
- **Target audience**: {{TARGET_AUDIENCE}}
- **Market**: {{MARKET}}
- **Content language**: {{CONTENT_LANGUAGE}}
- **Status**: {{STATUS}}
- **Hive company ID**: {{COMPANY_ID}}

## Language Rule
ALL user-facing content MUST be in **{{CONTENT_LANGUAGE_NAME}}**. This includes: page text, meta tags, alt text, error messages, button labels, headings, blog posts, SEO content. Do NOT mix languages.

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
- **Read `globals.css` before ANY UI work** — it contains design tokens (@theme) and 10 design rules. Follow them strictly.
- Use design token classes (`text-brand`, `bg-accent`, `text-text-secondary`, `border-border`) — NEVER raw hex values or arbitrary Tailwind colors in components.
- NO gradients. No `bg-gradient-to-*`, no gradient text. Solid colors only.
- Max 2 font weights per page: `font-normal` (400) and `font-bold` (700).
- Visual design must be allusive to the business domain — use colors, imagery, and language that evoke the industry
- ONE brand color for all interactive elements (buttons, links, highlights) — defined as `--color-accent` in globals.css
- Landing page follows conversion-optimized structure: hero → social proof (real data only) → problem → features (max 3, SVG icons) → how-it-works → FAQ → final CTA
- Headlines must be specific and pass the "so what?" test — no generic "Get started" or "Save time"
- Single conversion goal: every CTA leads to the same action (waitlist or checkout)
- One CTA per viewport. Never two solid-colored buttons adjacent.
- No duplicate components on the same page (two feature grids, two CTA blocks = violation).
- Server Components by default — only use "use client" when interactivity is needed
- Semantic HTML: `<nav>`, `<main>`, `<section>`, `<button>` — never `<div onClick>`
- Color contrast: minimum 4.5:1 for all text
- Every page: unique `<title>`, meta description, OG tags, proper heading hierarchy
- JSON-LD structured data on layout (Organization + WebSite) and FAQ sections
- No backdrop-blur, glass effects, or frosted backgrounds
- Max 2 shadow depths: shadow-sm for cards, shadow-md for modals only. No shadow-lg/xl
- Max 2 background colors per page: bg-white and bg-subtle (gray-50). No rainbow section backgrounds
- No statistics, counters, or testimonials without real data sources
- Hero must include one domain-specific visual element, not a generic dashboard mockup
- Micro-copy (button labels, empty states, error messages) must use domain vocabulary
- No Inter or Roboto as display font
- Every section must look connected to adjacent sections (consistent vertical rhythm, shared color vocabulary)

### Copy Quality Standards
- **Headlines describe outcomes/transformations, not features.** Bad: "Smart Analytics Dashboard." Good: "Stop guessing which customers will churn."
- **CTA copy uses specific action verbs describing the outcome, never generic.** Bad: "Sign up", "Get started." Good: "Start saving", "See your dashboard", "Get your report." Personalized CTAs convert 202% better.
- **Sub-headlines explain the mechanism** — how it works in one sentence. After stating the outcome, explain the how.
- **Feature descriptions follow pattern: [Benefit] + [How] + [Proof point].** Example: "Reduce churn by 40% (benefit) through AI-powered risk scoring (how) — used by 200+ SaaS companies (proof)."
- **Empty states should guide next action,** not just say "No data yet." Example: "Upload your first CSV to see insights" instead of "No files uploaded."

## Constraints
- Landing page MUST include visual product previews (CSS/SVG mockups in browser frames). Never ship a landing page with text-only feature descriptions. Customize the generic dashboard mockup to match the product domain.
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

## Search Engine Discovery (Day 1 Requirements)
- sitemap.xml must list ALL pages (landing, tools, blog posts, legal)
- robots.txt must reference sitemap URL and allow all crawlers (including AI bots)
- llms.txt must exist in public/ for AI crawler optimization
- IndexNow key must exist in public/ for instant Bing/Yandex indexing
- Google Search Console: add verification meta tag to layout (Carlos verifies ownership)
- After every deploy with new pages: ping IndexNow with new URLs
- Every page needs: unique title, meta description, canonical URL, OG image

## Do NOT
- Install packages without justification
- Store secrets in code — use Vercel env vars
- Make breaking API changes without updating the frontend
- Deploy without running `npm run build` successfully
- Ignore TypeScript errors
- Claim legal compliance, certifications, or guarantees the product cannot deliver
- State features as existing when they are not yet built — be honest about roadmap vs reality
- Mix languages on the same page — ALL copy must match the target audience language
- Show "Start Free Trial" or checkout CTAs when LAUNCH_MODE is "waitlist" — all CTAs should lead to the waitlist
