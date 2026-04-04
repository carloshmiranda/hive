# Hive — Developer Context

Focused reference for coding sessions. Load this when implementing features, fixing bugs, or writing any code.

---

## Code Standards

- TypeScript everywhere, Next.js App Router, Tailwind CSS
- Neon serverless driver (`@neondatabase/serverless`), Stripe SDK, Resend SDK
- No ORMs — raw SQL with parameterized queries
- API routes return: `{ ok: boolean, data?: any, error?: string }`

### Accessibility Standards (EAA Compliance)

- **Form validation**: Every error must name the specific field and describe how to fix it. Use `aria-describedby` to link error messages to form fields.
- **Interactive elements**: Every icon-only button needs `aria-label`. Every image needs descriptive `alt` text.
- **Focus management**: All interactive elements must have visible focus indicators (`:focus-visible` ring).
- **Color contrast**: Text must meet 7:1 contrast ratio. Use `text-secondary` (gray-600) for secondary text.
- **Semantic HTML**: Use `<main>`, skip-to-content links, and proper heading hierarchy.

---

## Model Selection

Choose the right model for the task. Over-indexing on Opus burns budget; under-indexing on Haiku loses quality.

| Task | Model | Rationale |
|------|-------|-----------|
| Codebase exploration, file reading, grep | Haiku | Fast, cheap — no reasoning needed |
| Routine coding, bug fixes, refactoring | Sonnet | Best quality/cost for daily work |
| Architecture, security design, complex trade-offs | Opus | Reasoning-intensive decisions justify the cost |
| Agent dispatches (Ops, Growth, Outreach) | Haiku or Sonnet via OpenRouter | Keep Claude budget for Engineer + CEO |

---

## Docs-Lookup Rule

**Never rely on training data for external SDK or API method signatures.** APIs change. Training data is stale.

Before writing code that calls any external SDK, library, or API (Stripe, Neon, Resend, QStash, Sentry, Next.js App Router internals, etc.):
1. Check if the method signature is already used correctly in the codebase (Grep first)
2. If uncertain: use the `make-plan` skill or `WebFetch` to verify against current official docs
3. If a method raises a type error or behaves unexpectedly: fetch the docs before guessing a fix

This rule applies to **every** external dependency — including ones you're confident about.

---

## Build Error Minimal Intervention

When fixing a TypeScript or build error, the fix must be **minimal and surgical**:
- Fix only the breaking change — do not refactor surrounding code
- Touch less than 5% of the modified file
- Do not add error handling, comments, or type annotations to code you didn't break
- Do not rename variables or restructure unrelated logic
- If the error is in a file you don't fully understand, read the full file before touching it

**The goal is a passing build with zero unintended changes.** If the minimal fix seems risky, escalate — don't expand scope.

---

## Naming Standards

### Git branches
- Agent work: `hive/<agent>-<company>-<short-desc>`
- Company builds: `hive/cycle-<N>-<task-id>`
- Hive improvements: `hive/improvement/<slug>`

### Commit messages
Conventional commits: `feat:`, `fix:`, `refactor:`, `content:`, `chore:`, `docs:`

### Workflow run names
Format: `"Agent: trigger — context"` (e.g., `CEO: cycle_start — senhorio`)

### Dispatch event types
snake_case: `cycle_start`, `cycle_complete`, `gate_approved`, `feature_request`, `research_request`, `evolve_trigger`, `healer_trigger`, `pipeline_low`, `company_killed`, `stripe_payment`

### Database naming
Tables: snake_case plural. Columns: snake_case. Timestamps: `_at` suffix. Enums: lowercase snake_case.

### Log messages
Format: `[agent] action: result (context)` — consistent for Sentinel parsing.

### Workflow YAML
- NEVER put literal `${{ }}` in prompt text — GitHub evaluates ALL expressions, even in multi-line strings
- Files: `hive-<agent>.yml` (Hive), `hive-<function>.yml` (company repos)

---

## Skills Reference

Always invoke relevant skills before starting work. Do not rely on keyword auto-triggering alone — check this list at the start of any task that touches these domains.

| Skill | Invoke when... |
|-------|----------------|
| `ui-ux-pro-max` | Any UI work: colors, fonts, components, layouts, accessibility audits. **READ the CSV data files** — the skill provides instructions but not the data itself. |
| `frontend-design` | Building landing pages, marketing sites, or any distinctive visual UI |
| `baseline-ui` | Starting any UI work — enforces stack, animation, typography, and layout constraints |
| `fixing-accessibility` | Adding or changing any interactive element (buttons, forms, dialogs, links) |
| `shadcn-ui` | Adding or modifying shadcn/ui components in a company app |
| `tailwind-company` | Styling a company app, configuring design tokens in globals.css |
| `neon-company-db` | Setting up or querying a company's Neon Postgres database |
| `stripe-integration` | Adding payments, subscriptions, webhooks, or Stripe Checkout to a company |
| `resend-email` | Adding transactional email or onboarding sequences to a company |
| `sentry-company` | Adding error monitoring to a portfolio company |
| `sentry-nextjs-sdk` | Full Sentry setup for any Next.js app |
| `sentry-fix-issues` | Diagnosing and fixing production errors reported in Sentry |
| `vercel-react-best-practices` | Writing or reviewing any React/Next.js code — performance, data fetching, bundle size |
| `neon-postgres-egress-optimizer` | High DB bills, slow queries, excessive egress, or N+1 patterns |
| `hive-agent-authoring` | Writing or editing any agent prompt, wiring a new dispatch event, checking turn budgets |
| `hive-debugging` | Any agent failure, circuit breaker trip, zombie action, QStash DLQ issue, or dispatch problem |
| `make-plan` | Any complex implementation touching multiple systems, APIs, or files. Run BEFORE writing code. Deploys subagents for doc discovery, codebase context, and constraint analysis. |
| `do` | Executing a plan after `/make-plan` or when Carlos says "implement this". Deploys subagents for each phase and enforces verification → ts-review → security-scan → anti-pattern → quality → commit gates. |
| `define-task` | Defining acceptance criteria before starting any new feature or task |
| `ts-guard` | On-demand TypeScript + edge runtime audit for interactive sessions |
| `ts-review` | Automated TS + App Router gate in the `/do` pipeline (Phase 3a — runs automatically) |
| `security-scan` | Automated security review in the `/do` pipeline (Phase 3b — runs automatically) |
| `seo` | Any SEO work on a portfolio company: audit, technical SEO, content quality, schema, local SEO, GEO/AI-search, backlinks, hreflang, sitemaps, programmatic SEO, competitor pages |
| `ads` | Any paid advertising work: Google Ads, Meta, YouTube, LinkedIn, TikTok, Microsoft, Apple Search Ads — audits, campaign planning, brand DNA extraction, creative briefs |
| `blog` | Full blog lifecycle: write, rewrite, outline, brief, SEO check, schema, cannibalization, taxonomy, strategy, analyze, audit, factcheck, GEO/AI citations, image gen, audio, charts, Google APIs, NotebookLM, persona, repurpose, editorial calendar |
