---
name: shadcn-ui
description: Invoke when adding UI components, installing shadcn/ui, adding buttons, dialogs, forms, tables, cards, dropdowns, or any shadcn component to a Hive portfolio company. Also use when the user mentions "add a component," "shadcn," "radix," "install button," "form component," "data table," "dialog," "sheet," "toast," or "UI component library." Hive companies use shadcn/ui with Next.js App Router and Tailwind CSS v4.
metadata:
  version: 1.0.0
---

# shadcn/ui for Hive Companies

Hive companies use **shadcn/ui** — copy-paste components built on Radix UI primitives with Tailwind CSS. Components live in the project's `src/components/ui/` directory and are fully owned/customizable.

## Architecture Rules

- Components are installed into `src/components/ui/` — never node_modules
- Each company's theme is set via CSS variables in `globals.css`
- Use `cn()` utility for conditional class merging (from `src/lib/utils.ts`)
- shadcn/ui works with Next.js App Router — components are client or server as needed
- Radix UI primitives handle accessibility (focus traps, keyboard nav, ARIA)

## Initial Setup

```bash
# Initialize shadcn/ui in a new company project
npx shadcn@latest init

# During init, choose:
# - Style: Default
# - Base color: Neutral (or brand-appropriate)
# - CSS variables: Yes
```

This creates:
- `src/components/ui/` directory
- `src/lib/utils.ts` with `cn()` helper
- CSS variable theme in `globals.css`
- Updates `tailwind.config.ts` (if Tailwind v3) or `globals.css` (if Tailwind v4)

## Installing Components

```bash
# Install individual components
npx shadcn@latest add button
npx shadcn@latest add dialog
npx shadcn@latest add form
npx shadcn@latest add table
npx shadcn@latest add card
npx shadcn@latest add dropdown-menu
npx shadcn@latest add input
npx shadcn@latest add label
npx shadcn@latest add toast
npx shadcn@latest add sheet
npx shadcn@latest add badge
npx shadcn@latest add separator
npx shadcn@latest add avatar
npx shadcn@latest add skeleton
npx shadcn@latest add alert
```

## Core Utilities

```typescript
// src/lib/utils.ts (auto-created by shadcn init)
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

## Common Component Patterns

### Button

```tsx
import { Button } from '@/components/ui/button';

// Variants
<Button>Default</Button>
<Button variant="secondary">Secondary</Button>
<Button variant="destructive">Delete</Button>
<Button variant="outline">Outline</Button>
<Button variant="ghost">Ghost</Button>
<Button variant="link">Link</Button>

// Sizes
<Button size="sm">Small</Button>
<Button size="lg">Large</Button>
<Button size="icon"><TrashIcon /></Button>

// Loading state
<Button disabled={isLoading}>
  {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
  Submit
</Button>
```

### Dialog (Modal)

```tsx
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

<Dialog>
  <DialogTrigger asChild>
    <Button>Open</Button>
  </DialogTrigger>
  <DialogContent className="sm:max-w-[425px]">
    <DialogHeader>
      <DialogTitle>Edit Profile</DialogTitle>
      <DialogDescription>
        Make changes to your profile here.
      </DialogDescription>
    </DialogHeader>
    <div className="grid gap-4 py-4">
      {/* form fields */}
    </div>
    <DialogFooter>
      <Button type="submit">Save changes</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

### Form with React Hook Form

```bash
npm install react-hook-form zod @hookform/resolvers
npx shadcn@latest add form input label
```

```tsx
'use client';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import {
  Form, FormControl, FormField, FormItem, FormLabel, FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

const formSchema = z.object({
  email: z.string().email('Please enter a valid email'),
  name: z.string().min(2, 'Name must be at least 2 characters'),
});

export function SignupForm() {
  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: { email: '', name: '' },
  });

  async function onSubmit(values: z.infer<typeof formSchema>) {
    const res = await fetch('/api/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    });
    // handle response
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Name</FormLabel>
              <FormControl>
                <Input placeholder="Your name" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <FormControl>
                <Input type="email" placeholder="you@example.com" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" className="w-full">
          Join Waitlist
        </Button>
      </form>
    </Form>
  );
}
```

### Card

```tsx
import {
  Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle,
} from '@/components/ui/card';

<Card>
  <CardHeader>
    <CardTitle>Plan Name</CardTitle>
    <CardDescription>What's included</CardDescription>
  </CardHeader>
  <CardContent>
    <p className="text-3xl font-bold">€29<span className="text-sm font-normal text-muted-foreground">/month</span></p>
  </CardContent>
  <CardFooter>
    <Button className="w-full">Get Started</Button>
  </CardFooter>
</Card>
```

### Toast Notifications

```tsx
// In layout or root: wrap with <Toaster />
import { Toaster } from '@/components/ui/toaster';

// In component:
import { useToast } from '@/components/ui/use-toast';

export function MyComponent() {
  const { toast } = useToast();

  function handleSuccess() {
    toast({
      title: 'Success!',
      description: 'Your changes have been saved.',
    });
  }

  function handleError() {
    toast({
      title: 'Error',
      description: 'Something went wrong. Please try again.',
      variant: 'destructive',
    });
  }
}
```

### Data Table

```bash
npm install @tanstack/react-table
npx shadcn@latest add table
```

```tsx
'use client';
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from '@tanstack/react-table';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
}

export function DataTable<TData, TValue>({ columns, data }: DataTableProps<TData, TValue>) {
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <Table>
      <TableHeader>
        {table.getHeaderGroups().map((headerGroup) => (
          <TableRow key={headerGroup.id}>
            {headerGroup.headers.map((header) => (
              <TableHead key={header.id}>
                {flexRender(header.column.columnDef.header, header.getContext())}
              </TableHead>
            ))}
          </TableRow>
        ))}
      </TableHeader>
      <TableBody>
        {table.getRowModel().rows.map((row) => (
          <TableRow key={row.id}>
            {row.getVisibleCells().map((cell) => (
              <TableCell key={cell.id}>
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
```

## Theming

Edit CSS variables in `globals.css` to match the company brand:

```css
@layer base {
  :root {
    --background: 0 0% 100%;
    --foreground: 222.2 84% 4.9%;
    --primary: 221.2 83.2% 53.3%;      /* Main brand color */
    --primary-foreground: 210 40% 98%;
    --secondary: 210 40% 96.1%;
    --accent: 210 40% 96.1%;
    --destructive: 0 84.2% 60.2%;
    --border: 214.3 31.8% 91.4%;
    --ring: 221.2 83.2% 53.3%;
    --radius: 0.5rem;
  }

  .dark {
    --background: 222.2 84% 4.9%;
    --foreground: 210 40% 98%;
    /* ... dark mode overrides */
  }
}
```

## Rules

- Always add `'use client'` to components using hooks, event handlers, or browser APIs
- Server Components can import and render shadcn components (they're just HTML/CSS)
- Use `asChild` prop on `DialogTrigger`, `DropdownMenuTrigger` etc. to compose with your own elements
- Never override Radix UI's accessibility behavior (focus traps, keyboard navigation)
- Use `Skeleton` component for loading states, not spinners for large areas
