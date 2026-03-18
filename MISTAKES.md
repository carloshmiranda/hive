# Known Mistakes & Gotchas

Errors encountered during development. Read before making changes.

## Deployment (2026-03-18)

### 1. NextAuth v5 middleware doesn't enforce auth
`export { auth as middleware }` only attaches the session to the request — it does NOT redirect unauthenticated users. Must wrap in a function:
```ts
export default auth((req) => {
  if (!req.auth) return NextResponse.redirect(new URL("/login", req.url));
  return NextResponse.next();
});
```

### 2. NextAuth v5 JWT doesn't store GitHub ID
`token.sub` is an internal ID, not the GitHub numeric user ID. Must use the `jwt` callback to persist `profile.id` as `token.githubId`, then pass it to the session callback. Without this, `requireAuth()` rejects all sessions because `session.user.id !== ALLOWED_GITHUB_ID`.

### 3. Neon serverless driver can't run multi-statement SQL
`neon()` rejects full schema files with "cannot insert multiple commands into a prepared statement". Must split by `;` and run individually. Also: strip SQL comments (`--`) before splitting, or a `startsWith('--')` filter will remove CREATE TABLE statements that have leading comment blocks.

### 4. Vercel Hobby plan limits
- 100 deploys/day hard cap
- Cron limited to once daily (no `0 8,18 * * *`)
- Hive requires Pro plan

### 5. Env var naming mismatch
`auth.ts` reads `GITHUB_OAUTH_ID` / `GITHUB_OAUTH_SECRET` — not the NextAuth v5 convention `AUTH_GITHUB_ID`. Always check what the code actually reads before setting env vars. Both names are now set in Vercel to be safe.

### 6. GitHub webhook API format
`gh api repos/.../hooks --method POST -f url=...` fails with "url cannot be blank". Must use `--field "config[url]=..."` and `--field "name=web"` format.
