---
name: ui-ux-pro-max
description: Invoke when building, reviewing, or improving UI/UX for any Hive portfolio company. Provides design intelligence: WCAG-verified color palettes, font pairings, UX guidelines, shadcn/ui patterns, and Next.js App Router best practices. Also use when the user mentions "design system," "pick colors," "choose fonts," "UI review," "component design," "landing page," "dashboard UI," "accessibility," "improve the look," "make it polished," or "UX audit."
metadata:
  version: 1.0.0
---

# UI/UX Pro Max — Design Intelligence for Hive Companies

This skill provides a design intelligence reference system for Hive portfolio companies. All companies use **Next.js 15 App Router + Tailwind CSS v4 + shadcn/ui**. Design data lives in `data/` alongside this file.

## Data Files

| File | Contents | Use For |
|------|----------|---------|
| `data/colors.csv` | 161 WCAG-verified color palettes by product type | Picking a brand palette when starting a company |
| `data/typography.csv` | 57 font pairings with CSS imports + Tailwind config | Choosing heading/body fonts |
| `data/ux-guidelines.csv` | 98 UX rules across 18 categories with severity | Auditing or designing any UI |
| `data/landing.csv` | Landing page section patterns and copywriting frameworks | Building marketing/landing pages |
| `data/products.csv` | Product UI patterns by category | Building app/dashboard UIs |
| `data/styles.csv` | Visual style references and aesthetic directions | Establishing visual identity |
| `data/google-fonts.csv` | 1,900+ Google Fonts with metadata | Finding fonts by mood/style |
| `data/stacks/nextjs.csv` | 52 Next.js App Router guidelines | Code review + architecture decisions |
| `data/stacks/shadcn.csv` | 60 shadcn/ui component guidelines | Component selection + implementation |

## How to Use Each File

### Picking Colors (`data/colors.csv`)

Columns: `No, Product Type, Primary, On Primary, Secondary, On Secondary, Accent, On Accent, Background, Foreground, Card, Card Foreground, Muted, Muted Foreground, Border, Destructive, On Destructive, Ring, Notes`

1. Filter rows by `Product Type` matching the company (e.g., SaaS, E-commerce, B2B, Healthcare, Fintech, EdTech)
2. Select a palette whose hex values match the desired tone (bold/minimal/warm/cool)
3. Map the palette to shadcn/ui CSS variables in `globals.css`:

```css
@layer base {
  :root {
    --background: /* Background hex */;
    --foreground: /* Foreground hex */;
    --primary: /* Primary hex */;
    --primary-foreground: /* On Primary hex */;
    --secondary: /* Secondary hex */;
    --secondary-foreground: /* On Secondary hex */;
    --accent: /* Accent hex */;
    --accent-foreground: /* On Accent hex */;
    --card: /* Card hex */;
    --card-foreground: /* Card Foreground hex */;
    --muted: /* Muted hex */;
    --muted-foreground: /* Muted Foreground hex */;
    --border: /* Border hex */;
    --destructive: /* Destructive hex */;
    --ring: /* Ring hex */;
    --radius: 0.5rem;
  }
}
```

All palettes in `colors.csv` are pre-verified for WCAG AA contrast. Do not use arbitrary colors — always pick from the CSV or derive from it.

### Picking Typography (`data/typography.csv`)

Columns: `No, Font Pairing Name, Category, Heading Font, Body Font, Mood/Style Keywords, Best For, Google Fonts URL, CSS Import, Tailwind Config, Notes`

1. Filter by `Category` (Serif/Sans-Serif/Mixed) or `Mood/Style Keywords` matching the brand
2. Note the `Best For` field to confirm it matches the company type
3. Copy the `CSS Import` value and add it to `src/app/layout.tsx` or `globals.css`
4. Apply the `Tailwind Config` value to `globals.css` `@theme {}` block:

```css
/* globals.css */
@import "tailwindcss";

@theme {
  --font-sans: 'Body Font Name', ui-sans-serif, system-ui, sans-serif;
  --font-display: 'Heading Font Name', ui-sans-serif, system-ui, sans-serif;
}
```

Or use Next.js font optimization in `layout.tsx`:

```typescript
// src/app/layout.tsx
import { Inter, Playfair_Display } from 'next/font/google';

const bodyFont = Inter({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });
const headingFont = Playfair_Display({ subsets: ['latin'], variable: '--font-display', display: 'swap' });

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${bodyFont.variable} ${headingFont.variable}`}>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
```

### UX Guidelines (`data/ux-guidelines.csv`)

Columns: `No, Category, Issue, Platform, Description, Do, Don't, Code Example Good, Code Example Bad, Severity`

Categories: AI Interaction, Accessibility, Animation, Content, Data Entry, Feedback, Forms, Interaction, Layout, Navigation, Onboarding, Performance, Responsive, Search, Spatial UI, Sustainability, Touch, Typography

Severity levels: **High** (must fix), **Medium** (should fix), **Low** (nice to fix)

When auditing a UI:
1. Filter by relevant categories
2. Check `High` severity items first
3. Use `Code Example Good` / `Code Example Bad` columns for concrete patterns

When building new components:
1. Read all `High` severity rules for the relevant categories before writing code
2. Accessibility category rules apply to **every** interactive component

### Next.js App Router Guidelines (`data/stacks/nextjs.csv`)

Columns: `No, Category, Guideline, Description, Do, Don't, Code Good, Code Bad, Severity, Docs URL`

Categories: Caching, Data Fetching, Error Handling, Image Optimization, Metadata, Performance, Rendering, Routing, Security, Server Components, Server vs Client, TypeScript

Apply these during code review and when making architectural decisions. All `High` severity guidelines are non-negotiable for production code.

Key rules always in effect:
- **Server Components by default** — only add `'use client'` when needed (hooks, event handlers, browser APIs)
- **Push Client Components to leaf nodes** — never mark a page or layout `'use client'` unless unavoidable
- **Use `next/image`** for all images — never `<img>` tags
- **Parameterize all data fetching** — no `fetch()` inside Client Components without SWR/React Query
- **Use `error.tsx`** at the route level, not try/catch in every component

### shadcn/ui Guidelines (`data/stacks/shadcn.csv`)

Columns: `No, Category, Guideline, Description, Do, Don't, Code Good, Code Bad, Severity, Docs URL`

Categories: Accessibility, Components, Customization, Data Display, Forms, Icons, Motion, Navigation, Setup, Theming, Utilities

Key rules always in effect:
- **Install via CLI** — `npx shadcn@latest add <component>`, never copy-paste
- **CSS variables for colors** — never hardcode colors in component files
- **`cn()` utility** for all conditional classes — `import { cn } from '@/lib/utils'`
- **`asChild` for composition** — use on `DialogTrigger`, `DropdownMenuTrigger`, etc. when composing with custom elements
- **Never override Radix accessibility behavior** — focus traps, keyboard nav, and ARIA are handled correctly by default

## Hive-Specific Rules

### Each Company Gets a Unique Design Identity

Do NOT reuse the same font pairing or color palette across different portfolio companies. Each company is a distinct brand:
- Pick a different row from `typography.csv` for each company
- Pick a different palette from `colors.csv` for each company
- Vary the aesthetic (one company minimal, another bold, another editorial)

### Design Token Location

All design tokens live in `src/app/globals.css`. Never put colors or fonts in `tailwind.config.ts` — Hive companies use Tailwind v4's CSS-first configuration:

```css
/* src/app/globals.css */
@import "tailwindcss";

@theme {
  /* Brand tokens */
  --color-primary: oklch(55% 0.22 260);
  --font-sans: 'Inter', ui-sans-serif, system-ui, sans-serif;
  --font-display: 'Cal Sans', ui-sans-serif, system-ui, sans-serif;
}

/* shadcn/ui compatibility layer */
@layer base {
  :root {
    --background: 0 0% 100%;
    --foreground: 222.2 84% 4.9%;
    /* ... rest of palette ... */
  }
  .dark {
    /* ... dark mode overrides ... */
  }
}
```

### Component Library Priority

1. **shadcn/ui first** — check if a shadcn component exists before writing custom UI
2. **Radix UI primitives** if shadcn doesn't have it
3. **Custom component** only when neither covers the use case

### Landing Page vs Dashboard

- **Landing/marketing pages**: Full creative freedom — apply `frontend-design` skill alongside this one for distinctive aesthetics
- **Dashboards/admin UIs**: Constrain animations to micro-interactions only; prioritize density and scanability over visual flair
- **Blog layouts**: Use editorial/magazine aesthetic direction; typography is the hero

### Typography Rules (always apply)

```tsx
{/* Headings: always text-balance */}
<h1 className="text-balance text-4xl font-display font-bold">Heading</h1>

{/* Body: always text-pretty */}
<p className="text-pretty text-base">Paragraph text.</p>

{/* Numbers/prices: always tabular-nums */}
<span className="tabular-nums">€1,234.00</span>
```

### No Arbitrary Values

Never use `w-[347px]`, `text-[13px]`, `mt-[22px]` etc. Use Tailwind's scale or add tokens to `@theme {}` in `globals.css`. The only acceptable arbitrary value is for complex gradients or one-off background patterns.

## Quick Reference: Starting a New Company UI

1. **Pick palette** → read `colors.csv`, filter by company's product type, select a row
2. **Pick fonts** → read `typography.csv`, filter by mood/style matching the brand, select a row
3. **Configure `globals.css`** → add `@theme {}` tokens + `@layer base { :root {} }` variables
4. **Update `layout.tsx`** → add Next.js font optimization with the chosen fonts
5. **Install shadcn** → `npx shadcn@latest init` (style: Default, base color: Neutral, CSS vars: Yes)
6. **Check UX guidelines** → before implementing any section, filter `ux-guidelines.csv` by relevant categories and read all `High` severity items

## Severity Legend

| Level | Meaning |
|-------|---------|
| **High** | Non-negotiable. Must be applied. Breaking this creates accessibility violations, performance regressions, or security issues. |
| **Medium** | Strong recommendation. Should be applied unless there's a documented reason not to. |
| **Low** | Nice to have. Apply when not adding complexity. |
