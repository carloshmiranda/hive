# Hive — Review & Self-Improvement Context

Anti-patterns and session hygiene. Load this when reviewing code, wrapping up a session, or doing any self-improvement work.

---

## Red Flags — Interactive Session Anti-Patterns

These are the rationalizations that appear most often in sessions that produce regressions or lose context. They are named here so they can be recognized and refused at decision time, not discovered in MISTAKES.md afterward.

| Rationalization | Why it's wrong |
|----------------|----------------|
| "The build passes, so it's done." | `npm run build` passes on incorrect logic all the time. Acceptance criteria must be verified explicitly — not inferred from CI. |
| "It worked locally, should be fine on Vercel." | Edge runtime ≠ Node.js. Next.js App Router has different import restrictions. `crypto`, `fs`, and some npm packages break silently at deploy time. |
| "The PR is small — no need for careful review." | Most entries in MISTAKES.md came from "small" PRs. Size is not a proxy for risk. |
| "I'll handle that edge case in the next session." | The next session starts from a summary, not full context. Edge cases deferred across compaction boundaries reliably disappear. |
| "The test covers the happy path — that's the main flow." | Hive's production failures are almost always in error paths: missing env vars, Neon timeouts, QStash auth failures, null returns from Sentry. |
| "I'll update BRIEFING.md / run `/context` at the end." | Sessions end abruptly. If `/context` isn't run before closing, the next session inherits stale state and makes wrong recommendations. |
| "This is a Hive infra change, not a company change — no need to check MISTAKES.md." | MISTAKES.md covers both. Many infra patterns (auth middleware, route exports, env var naming) have been broken and re-broken. |
| "I already know what this file does — no need to read it first." | Skipping a Read before Edit is how stale assumptions ship. Always read before modifying. |

---

## Self-Improvement Rules

### After every Claude Code session (mandatory — run `/context` or do manually):
1. Something broke → MISTAKES.md
2. Better approach discovered → MISTAKES.md or backlog DB (`mcp__hive__hive_backlog_create`)
3. Architectural decision made → DECISIONS.md
4. Project state changed → update memory files
5. Architecture/flows/structure changed → update CLAUDE.md + ARCHITECTURE.md
6. Append `[code]` entry to BRIEFING.md "Recent Context"
7. Update backlog DB — use `mcp__hive__hive_backlog_update` (done items) and `mcp__hive__hive_backlog_create` (new gaps)
8. **Do NOT skip this.** Context drift causes wrong recommendations in future sessions.

### Self-assigned improvement flow:
Orchestrator picks P2 items → branch `hive/improvement/{slug}` → implement → build verify → PR → approval gate → Carlos reviews.
