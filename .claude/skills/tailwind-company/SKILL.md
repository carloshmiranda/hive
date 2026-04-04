---
name: tailwind-company
description: Invoke when styling a Hive portfolio company app with Tailwind CSS, setting up a design system, configuring colors, fonts, or layout patterns. Also use when the user mentions "styling," "CSS," "Tailwind setup," "design system," "color palette," "typography," "dark mode," "responsive design," "landing page styles," or "make it look good." Hive companies use Tailwind CSS v4 with Next.js App Router.
metadata:
  version: 1.0.0
---

# Tailwind CSS for Hive Companies

Hive companies use **Tailwind CSS v4** with Next.js App Router. Tailwind v4 uses CSS-first configuration — no `tailwind.config.ts` needed for most setups. Configuration lives in `globals.css`.

## Architecture Rules

- Tailwind v4: CSS-first config in `globals.css` using `@theme` directive
- Import Tailwind once: `@import "tailwindcss"` in `globals.css`
- Custom tokens (colors, fonts, spacing) defined in `@theme {}` block
- No `tailwind.config.ts` unless complex plugins are needed
- Use `cn()` from `src/lib/utils.ts` for conditional classes

## Installation (New Company)

```bash
npm install tailwindcss @tailwindcss/postcss
```

```js
// postcss.config.mjs
export default {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};
```

```css
/* src/app/globals.css */
@import "tailwindcss";

@theme {
  /* Custom tokens override Tailwind defaults */
  --color-primary: oklch(55% 0.22 260);
  --color-primary-foreground: oklch(98% 0.01 260);
  --font-sans: 'Inter', ui-sans-serif, system-ui, sans-serif;
  --font-display: 'Cal Sans', ui-sans-serif, system-ui, sans-serif;
  --radius: 0.5rem;
}
```

## Design System Setup

### Google Fonts (Next.js)

```typescript
// src/app/layout.tsx
import { Inter, Poppins } from 'next/font/google';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});

const poppins = Poppins({
  weight: ['400', '600', '700'],
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
});

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${poppins.variable}`}>
      <body className="font-sans antialiased bg-background text-foreground">
        {children}
      </body>
    </html>
  );
}
```

### Color System in globals.css

```css
@import "tailwindcss";

@theme {
  /* Brand colors */
  --color-brand-50: oklch(97% 0.02 260);
  --color-brand-100: oklch(93% 0.05 260);
  --color-brand-500: oklch(55% 0.22 260);
  --color-brand-600: oklch(48% 0.22 260);
  --color-brand-900: oklch(25% 0.15 260);

  /* Semantic colors (map to brand) */
  --color-primary: var(--color-brand-500);
  --color-primary-hover: var(--color-brand-600);
}

/* Semantic CSS variables for shadcn/ui compatibility */
@layer base {
  :root {
    --background: 0 0% 100%;
    --foreground: 222.2 84% 4.9%;
    --primary: 221.2 83.2% 53.3%;
    --primary-foreground: 210 40% 98%;
    --secondary: 210 40% 96.1%;
    --secondary-foreground: 222.2 47.4% 11.2%;
    --muted: 210 40% 96.1%;
    --muted-foreground: 215.4 16.3% 46.9%;
    --accent: 210 40% 96.1%;
    --border: 214.3 31.8% 91.4%;
    --input: 214.3 31.8% 91.4%;
    --ring: 221.2 83.2% 53.3%;
    --radius: 0.5rem;
    --destructive: 0 84.2% 60.2%;
  }
}
```

## Common Layout Patterns

### Hero Section (Landing Page)

```tsx
export function Hero() {
  return (
    <section className="relative isolate overflow-hidden bg-white">
      <div className="mx-auto max-w-7xl px-6 py-24 sm:py-32 lg:px-8">
        <div className="mx-auto max-w-2xl text-center">
          <h1 className="text-balance text-5xl font-display font-bold tracking-tight text-gray-900 sm:text-6xl">
            The headline that sells your product
          </h1>
          <p className="mt-6 text-pretty text-lg text-gray-600">
            One-sentence value proposition. Clear, direct, no jargon.
          </p>
          <div className="mt-10 flex items-center justify-center gap-4">
            <a
              href="/signup"
              className="rounded-lg bg-primary px-6 py-3 text-sm font-semibold text-white shadow-sm hover:bg-primary-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary transition-colors"
            >
              Get started free
            </a>
            <a href="#features" className="text-sm font-semibold text-gray-900">
              Learn more <span aria-hidden="true">→</span>
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
```

### Feature Grid

```tsx
const features = [
  { title: 'Feature One', description: 'Brief description', icon: '🚀' },
  { title: 'Feature Two', description: 'Brief description', icon: '⚡' },
  { title: 'Feature Three', description: 'Brief description', icon: '🎯' },
];

export function Features() {
  return (
    <section className="py-24 bg-gray-50">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <div className="mx-auto max-w-2xl text-center mb-16">
          <h2 className="text-balance text-3xl font-bold text-gray-900">
            Everything you need
          </h2>
        </div>
        <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((feature) => (
            <div
              key={feature.title}
              className="relative rounded-2xl border border-gray-200 bg-white p-8 shadow-sm"
            >
              <div className="text-3xl mb-4">{feature.icon}</div>
              <h3 className="text-lg font-semibold text-gray-900">{feature.title}</h3>
              <p className="mt-2 text-sm text-gray-600">{feature.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
```

### Pricing Cards

```tsx
const plans = [
  {
    name: 'Starter',
    price: '€0',
    description: 'For individuals',
    features: ['5 projects', '1GB storage', 'Email support'],
    cta: 'Get started',
    href: '/signup',
    highlighted: false,
  },
  {
    name: 'Pro',
    price: '€29',
    period: '/month',
    description: 'For growing teams',
    features: ['Unlimited projects', '100GB storage', 'Priority support', 'Analytics'],
    cta: 'Start free trial',
    href: '/signup?plan=pro',
    highlighted: true,
  },
];

export function Pricing() {
  return (
    <section className="py-24">
      <div className="mx-auto max-w-7xl px-6 lg:px-8">
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-2 max-w-4xl mx-auto">
          {plans.map((plan) => (
            <div
              key={plan.name}
              className={cn(
                'rounded-2xl p-8 ring-1',
                plan.highlighted
                  ? 'bg-gray-900 ring-gray-900 text-white'
                  : 'bg-white ring-gray-200',
              )}
            >
              <h3 className={cn('text-lg font-semibold', plan.highlighted ? 'text-white' : 'text-gray-900')}>
                {plan.name}
              </h3>
              <p className={cn('mt-4 flex items-baseline gap-x-2', plan.highlighted ? 'text-white' : 'text-gray-900')}>
                <span className="text-4xl font-bold tracking-tight">{plan.price}</span>
                {plan.period && <span className="text-sm text-gray-400">{plan.period}</span>}
              </p>
              <ul className="mt-8 space-y-3">
                {plan.features.map((feature) => (
                  <li key={feature} className={cn('flex gap-x-3 text-sm', plan.highlighted ? 'text-gray-300' : 'text-gray-600')}>
                    <span className="text-green-400">✓</span>
                    {feature}
                  </li>
                ))}
              </ul>
              <a
                href={plan.href}
                className={cn(
                  'mt-8 block rounded-lg px-4 py-2.5 text-center text-sm font-semibold transition-colors',
                  plan.highlighted
                    ? 'bg-white text-gray-900 hover:bg-gray-100'
                    : 'bg-primary text-white hover:bg-primary-hover',
                )}
              >
                {plan.cta}
              </a>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
```

### Navigation Header

```tsx
'use client';
import { useState } from 'react';
import Link from 'next/link';

export function Header() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 bg-white/80 backdrop-blur-sm border-b border-gray-200">
      <nav className="mx-auto max-w-7xl px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between">
          <Link href="/" className="text-xl font-display font-bold text-gray-900">
            CompanyName
          </Link>
          <div className="hidden sm:flex items-center gap-6">
            <Link href="#features" className="text-sm text-gray-600 hover:text-gray-900">Features</Link>
            <Link href="#pricing" className="text-sm text-gray-600 hover:text-gray-900">Pricing</Link>
            <Link href="/login" className="text-sm text-gray-600 hover:text-gray-900">Login</Link>
            <Link
              href="/signup"
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover transition-colors"
            >
              Get started
            </Link>
          </div>
        </div>
      </nav>
    </header>
  );
}
```

## Responsive Design Patterns

```tsx
// Mobile-first, use sm/md/lg/xl breakpoints
<div className="
  flex flex-col           {/* mobile: stack */}
  sm:flex-row             {/* tablet: side-by-side */}
  gap-4
">

{/* Text size scaling */}
<h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold">

{/* Grid responsive */}
<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">

{/* Hide/show by breakpoint */}
<nav className="hidden lg:flex">  {/* Desktop only */}
<button className="lg:hidden">    {/* Mobile only */}
```

## Typography Rules

```tsx
{/* Always use text-balance for headings */}
<h1 className="text-balance ...">

{/* Always use text-pretty for body */}
<p className="text-pretty ...">

{/* Tabular numbers for prices/metrics */}
<span className="tabular-nums">€29.00</span>
<span className="tabular-nums">1,234</span>
```

## Dark Mode

```css
/* globals.css — dark mode via CSS variables */
@layer base {
  .dark {
    --background: 222.2 84% 4.9%;
    --foreground: 210 40% 98%;
    --primary: 217.2 91.2% 59.8%;
    --border: 217.2 32.6% 17.5%;
  }
}
```

```tsx
// Toggle dark mode
<html className="dark">  {/* Apply at root */}
```

## Rules

- **Never use arbitrary values** like `w-[347px]` — use Tailwind's scale or `@theme` tokens
- **Never use inline styles** for anything Tailwind can do
- Always use `text-balance` on headings and `text-pretty` on body copy
- Use `tabular-nums` for any numerical data (prices, counts, metrics)
- Mobile-first: start with mobile styles, add `sm:`, `md:`, `lg:` for larger screens
- Use `group` and `peer` for complex hover/focus interactions between elements
- When using shadcn/ui, don't override its Tailwind variables — customize via `globals.css` `@layer base`
