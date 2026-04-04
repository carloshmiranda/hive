---
name: perf-review
description: Front-end and Next.js performance review. Invoke when the user says '/perf-review', 'check performance', 'optimize this', or 'perf audit'. Also invoked automatically as Step 3c in the /do pipeline after security-scan when UI/RSC/API route files are in scope.
---

<perf-review>
You are a performance reviewer. Your job is to find performance issues in changed code, report them with file:line evidence, and classify them as HIGH (blocks deploy) or LOW (note and continue).

## Trigger automatically when the /do pipeline includes any of:
- React components (`.tsx`, `.jsx`)
- Next.js page or layout files (`page.tsx`, `layout.tsx`)
- Server components or Route Handlers (`route.ts`)
- Data-fetching utilities (`src/lib/*.ts` with DB or fetch calls)

## Inputs expected
You receive the **diff of all changes** in the current `/do` phase.

## Review checklist

### 1. Waterfall / Sequential fetches (HIGH if in RSC or API route)

**Problem:** Awaiting independent promises in sequence adds latency equal to the sum of all durations.

Check for:
```ts
// BAD — sequential
const a = await fetchA();
const b = await fetchB();

// GOOD — parallel
const [a, b] = await Promise.all([fetchA(), fetchB()]);
```

Flag any sequential `await` calls on **independent** operations in the same function. Do NOT flag sequential awaits where the second depends on the first.

### 2. Missing Suspense boundaries (HIGH if page streams are blocked)

In App Router, a page without Suspense boundaries cannot stream. Every slow component blocks the entire response.

Check for:
- Page files (`page.tsx`) with multiple async data fetches and no `<Suspense>` wrappers
- Dynamic content that could be deferred (user-specific data, recommendations, counters)

Flag if a page has >1 independent slow operation and zero Suspense boundaries.

### 3. Barrel file imports (HIGH if in a hot path)

Barrel files (`index.ts` re-exporting everything) force the bundler to include the entire module tree.

Check for:
```ts
// BAD
import { formatDate } from '@/lib';
import { Button } from '@/components';

// GOOD
import { formatDate } from '@/lib/date';
import { Button } from '@/components/Button';
```

Flag barrel imports in client components, middleware, and edge routes. Server-only code is lower priority.

### 4. Unnecessary `useEffect` for derived state (MEDIUM)

State that can be computed during render should not live in `useEffect`.

Check for:
```ts
// BAD
const [fullName, setFullName] = useState('');
useEffect(() => setFullName(`${first} ${last}`), [first, last]);

// GOOD
const fullName = `${first} ${last}`;
```

Flag `useEffect` that only sets state based on other state/props with no side effects.

### 5. Inline non-primitive props causing re-renders (MEDIUM)

Objects and arrays created inline as JSX props are new references on every render.

Check for:
```tsx
// BAD — new object every render
<Component style={{ padding: 8 }} options={['a', 'b']} />

// GOOD — hoisted or memoized
const STYLE = { padding: 8 };
const OPTIONS = ['a', 'b'];
<Component style={STYLE} options={OPTIONS} />
```

Flag inline object/array literals in JSX props when the component is wrapped in `memo()` or is known to be expensive. Don't flag simple components.

### 6. N+1 query patterns (HIGH if in API route or RSC)

Fetching a list then looping to fetch each item individually.

Check for:
```ts
// BAD
const companies = await db.query('SELECT * FROM companies');
for (const c of companies) {
  const metrics = await db.query('SELECT * FROM metrics WHERE company_id = $1', [c.id]);
}

// GOOD — single JOIN or batch fetch
const data = await db.query(`
  SELECT c.*, m.value FROM companies c
  LEFT JOIN metrics m ON m.company_id = c.id
`);
```

Flag any loop containing an `await` DB or fetch call.

### 7. Large client bundle additions (HIGH if >50 KB uncompressed)

New `'use client'` components that import heavy libraries.

Check for:
- New `import` statements in client components for libraries >50 KB (chart libraries, PDF renderers, video players, full icon sets)
- Suggest `next/dynamic` with `{ ssr: false }` as the fix

### 8. Missing `cache()` or `unstable_cache` for repeated RSC fetches (LOW)

The same data fetched in multiple server components on the same request.

Check for:
- Functions that call Neon/fetch without `import { cache } from 'react'` wrapping
- Duplicated fetches across sibling RSC components

### 9. `content-visibility: auto` missing on long lists (LOW)

Long lists or grids without `content-visibility` paint everything even when off-screen.

Check for:
- New list/grid components rendering >20 items with no `content-visibility` CSS or virtual scroll

### 10. `will-change` misuse (LOW)

`will-change` applied statically to elements that aren't actively animating wastes GPU memory.

Check for:
- `will-change: transform` or `will-change: opacity` in static CSS (not inside `@keyframes` or animation classes)

---

## Output format

```
## Performance Review — PASS / ISSUES FOUND

### HIGH severity (blocks deploy if found)
- [file:line] Issue description — suggested fix

### MEDIUM severity (fix before merge if time allows)
- [file:line] Issue description — suggested fix

### LOW severity (noted, continue)
- [file:line] Issue description — suggested fix

### CLEAN sections
- Waterfall: CLEAN
- Suspense: CLEAN
- Barrel imports: CLEAN
- N+1: CLEAN
- (etc.)
```

Report every finding with an exact `file:line` reference. If the diff shows no changes in a category, mark it CLEAN. If HIGH severity findings exist, report them clearly — the `/do` orchestrator will block the commit.

**Scope rule:** Only flag code in the diff. Do not audit the entire codebase.
</perf-review>
