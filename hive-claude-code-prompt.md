# Hive: Event-Driven Migration — Claude Code Implementation Prompt

## Context

You are implementing a fully event-driven architecture for Hive, an autonomous venture orchestrator. Read DECISIONS.md, MEMORY.md, BRIEFING.md, and schema.sql before making changes.

All architecture decisions are final — implement as specified.

## Key decisions

1. **7 agents**: CEO, Scout, Engineer, Ops, Growth, Outreach, Evolver (consolidated from 10)
2. **Zero crons on any agent**. Triggered by events, data conditions, or other agents.
3. **One sentinel** — GitHub Actions workflow every 4h, queries Neon, dispatches agents with work.
4. **Agent chains** — every workflow's final step dispatches next agent via `repository_dispatch`.
5. **Brain agents** (CEO, Scout, Engineer, Evolver): GitHub runners + `anthropics/claude-code-base-action` + `CLAUDE_CODE_OAUTH_TOKEN`
6. **Worker agents** (Ops, Growth, Outreach): Vercel serverless + Gemini/Groq via `/api/agents/dispatch`
7. **Vercel has NO crons**. Receives webhooks + serves dashboard only.
8. **Repo stays private**. ~915 min/mo (46% of 2,000 free limit).

## Existing infrastructure (DO NOT recreate)

These are already configured and working:
- `CRON_SECRET` — GitHub Secret + Vercel env var (set via `scripts/setup-cron-secret.sh`)
- `DATABASE_URL` — Vercel env var (Neon via Vercel Marketplace)
- `GITHUB_TOKEN` — built-in GitHub Actions token
- `/api/agents/dispatch` — existing worker dispatch endpoint (needs update, not recreation)
- `/api/agents/companies` — existing company list endpoint
- `.github/workflows/worker-agents.yml` — existing worker workflow (needs update)
- `gh` CLI — already authenticated on Mac

## How to run

### Step 1: Generate the Claude OAuth token (one-time, needs browser)

```bash
claude setup-token
# Browser opens → sign in → authorize
# Terminal prints: sk-ant-oat01-xxxxx...xxxxx
# Copy that token
```

### Step 2: Save the supporting files to repo root

Download these 4 files from the Claude chat session and save them to `~/code/hive/`:

```
~/code/hive/
├── hive-claude-code-prompt.md        ← this prompt
├── hive-architecture-research.md     ← research doc (→ moved to docs/ by Task 6)
├── architecture.svg                  ← diagram (→ moved to docs/ by Task 6)
└── README.md                         ← new readme (overwrites existing)
```

### Step 3: Export token and run

```bash
cd ~/code/hive

# Set the one new token
export HIVE_OAUTH_TOKEN="sk-ant-oat01-xxxxx..."

# Run the implementation (you're already authed locally via /login)
claude -p "$(cat hive-claude-code-prompt.md)"
```

---

## Task 0: Pre-flight checks + add the one new secret

First, verify the supporting files are in place:

```bash
# Check all required files exist in repo root
for f in hive-architecture-research.md architecture.svg README.md; do
  [ -f "./$f" ] && echo "✓ $f" || echo "✗ MISSING: $f — download from Claude chat session first"
done
```

Then add the two new secrets (everything else already exists):

```bash
# 1. The new Claude OAuth token (from $HIVE_OAUTH_TOKEN env var)
if [ -z "$HIVE_OAUTH_TOKEN" ]; then
  echo "ERROR: Run 'claude setup-token' first and export HIVE_OAUTH_TOKEN"
  exit 1
fi
gh secret set CLAUDE_CODE_OAUTH_TOKEN --body "$HIVE_OAUTH_TOKEN"

# 2. PAT for repository_dispatch chains (reuses existing gh CLI auth)
gh secret set GITHUB_PAT --body "$(gh auth token)"

echo "Done. CRON_SECRET and DATABASE_URL already configured."
```

Then ensure DATABASE_URL is available locally and in GitHub secrets:

```bash
# Pull DATABASE_URL from Vercel if not already in env
if [ -z "$DATABASE_URL" ]; then
  vercel env pull .env.local --yes 2>/dev/null
  export DATABASE_URL=$(grep DATABASE_URL .env.local | cut -d= -f2-)
fi

# Also set DATABASE_URL as GitHub secret (brain agents on GH runners need it)
gh secret set DATABASE_URL --body "$DATABASE_URL"
```

Then run migration 003:

```bash
node -e "
const postgres = require('postgres');
const sql = postgres(process.env.DATABASE_URL);
async function migrate() {
  await sql\`ALTER TABLE agent_actions DROP CONSTRAINT IF EXISTS agent_actions_agent_check\`;
  await sql\`ALTER TABLE agent_actions ADD CONSTRAINT agent_actions_agent_check CHECK (agent IN ('ceo','scout','engineer','ops','growth','outreach','evolver'))\`;
  await sql\`ALTER TABLE agent_actions ALTER COLUMN cycle_id DROP NOT NULL\`;
  await sql\`ALTER TABLE agent_actions ALTER COLUMN company_id DROP NOT NULL\`;
  await sql\`ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_gate_type_check\`;
  await sql\`ALTER TABLE approvals ADD CONSTRAINT approvals_gate_type_check CHECK (gate_type IN ('new_company','growth_strategy','spend_approval','kill_company','prompt_upgrade','escalation','outreach_batch','first_revenue'))\`;
  await sql\`UPDATE agent_actions SET agent = 'scout' WHERE agent IN ('idea_scout','research_analyst')\`;
  await sql\`UPDATE agent_actions SET agent = 'ops' WHERE agent IN ('health_monitor','auto_healer','healer')\`;
  await sql\`UPDATE agent_actions SET agent = 'ceo' WHERE agent IN ('venture_brain','kill_switch','retro_analyst')\`;
  await sql\`UPDATE agent_actions SET agent = 'engineer' WHERE agent = 'provisioner'\`;
  await sql\`UPDATE agent_actions SET agent = 'evolver' WHERE agent = 'prompt_evolver'\`;
  await sql\`UPDATE agent_prompts SET agent = 'scout' WHERE agent IN ('idea_scout','research_analyst')\`;
  await sql\`UPDATE agent_prompts SET agent = 'ops' WHERE agent IN ('health_monitor','auto_healer','healer')\`;
  await sql\`UPDATE agent_prompts SET agent = 'ceo' WHERE agent = 'venture_brain'\`;
  await sql\`UPDATE agent_prompts SET agent = 'evolver' WHERE agent = 'prompt_evolver'\`;
  console.log('Migration 003 complete');
  await sql.end();
}
migrate().catch(e => { console.error(e); process.exit(1); });
"
```

Save migration as `migrations/003_agent_consolidation.sql`. Update `schema.sql` to match.

---

## Task 1: Brain agent workflows (4 new files)

Create in `.github/workflows/`. Each must:
- Trigger on relevant events (**NO `schedule` triggers**)
- Support `workflow_dispatch` for testing
- Use `anthropics/claude-code-base-action@v1` with `claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}`
- Pass `DATABASE_URL: ${{ secrets.DATABASE_URL }}` as env (add DATABASE_URL to GitHub secrets by reading from Vercel: `vercel env pull .env.local && gh secret set DATABASE_URL --body "$(grep DATABASE_URL .env.local | cut -d= -f2-)"`)
- Have a **chain dispatch step** at the end using `${{ secrets.GITHUB_PAT }}`

### `.github/workflows/hive-ceo.yml`
**Triggers:** `repository_dispatch` (stripe_payment, cycle_complete, gate_approved, ceo_review), `issues` (label: directive), `pull_request` (opened), `workflow_dispatch`
**Chain:** → Scout (needs_research), Engineer (needs_feature), Growth/Outreach (plan tasks)

### `.github/workflows/hive-scout.yml`
**Triggers:** `repository_dispatch` (pipeline_low, company_killed, new_company, research_request), `issues` (label: research), `workflow_dispatch`
**Chain:** → Growth (research_delivered), Outreach (leads_found), creates approval gates (ideas)

### `.github/workflows/hive-engineer.yml`
**Triggers:** `repository_dispatch` (new_company, feature_request, ops_escalation), `issues` (label: feature/bug), `pull_request_review` (approved), `workflow_dispatch`
**Chain:** → CEO (PR opened for strategy review)

### `.github/workflows/hive-evolver.yml`
**Triggers:** `repository_dispatch` (evolve_trigger), `workflow_dispatch`
**Chain:** Creates approval gates (no downstream dispatch)

### Chain dispatch pattern (last step in every brain workflow)

```yaml
- name: Chain dispatch
  if: steps.agent.outputs.conclusion == 'success'
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_PAT }}
  run: |
    RESULT=$(cat ${{ steps.agent.outputs.execution_file }} | jq -r 'map(select(.role == "assistant")) | last | .content' 2>/dev/null || echo "{}")
    REPO="${{ github.repository }}"

    dispatch() {
      curl -s -X POST "https://api.github.com/repos/$REPO/dispatches" \
        -H "Authorization: token $GITHUB_TOKEN" \
        -H "Accept: application/vnd.github.v3+json" \
        -d "{\"event_type\":\"$1\",\"client_payload\":$2}"
      echo "  Dispatched: $1"
    }

    # Customize per agent
    echo "$RESULT" | grep -q "needs_research" && dispatch "research_request" "{\"company\":\"$(echo $RESULT | jq -r '.company // \"all\"')\"}"
    echo "$RESULT" | grep -q "needs_feature" && dispatch "feature_request" "{\"company\":\"$(echo $RESULT | jq -r '.company // \"\"')\"}"
```

---

## Task 2: Sentinel workflow (the ONLY scheduled thing)

Create `.github/workflows/hive-sentinel.yml`. Runs every 4h, queries Neon for 7 conditions, dispatches agents with work. Most runs dispatch nothing.

Conditions:
1. Pipeline < 3 companies → Scout (ideas)
2. No content for company in 7 days → Growth
3. Stale leads > 5 days → Outreach
4. No CEO review in 48h → CEO
5. Unverified deploy in 24h → Ops
6. Completed cycles since last evolve > 10 → Evolver
7. Agent failure rate > 20% in 48h → Evolver

Use `npm install postgres` to query Neon, `curl` for `repository_dispatch`.

---

## Task 3: Update existing worker-agents.yml

**Remove ALL `schedule` triggers.** Workers are now dispatched only by agent chains or sentinel.
- Keep `repository_dispatch` types: `growth_trigger`, `outreach_trigger`, `health_check`, `agent_dispatch`
- Keep `workflow_dispatch` for testing
- Remove any reference to `healer`

---

## Task 4: Update existing dispatch endpoint

`src/app/api/agents/dispatch/route.ts`:
- Agent list: `['ops', 'growth', 'outreach']` (remove healer)
- After Ops runs: if output contains `needs_engineer: true`, call `repository_dispatch` via `GITHUB_PAT` env var
- Tighten default prompts (one verb per agent)

---

## Task 5: Stripe webhook

Create `src/app/api/webhooks/stripe/route.ts`:
- Receives Stripe events → calls `repository_dispatch` (event_type: `stripe_payment`)
- Uses `GITHUB_PAT` env var (add to Vercel: `vercel env add GITHUB_PAT production`)

---

## Task 6: Documentation — full content for each file

The following files are already saved in the repo root by Carlos before running this prompt.

### 6a. `docs/architecture-research.md`
```bash
mkdir -p docs
mv ./hive-architecture-research.md ./docs/architecture-research.md
```

### 6b. `docs/architecture.svg`
```bash
mv ./architecture.svg ./docs/architecture.svg
```

### 6c. `README.md`
Already in place (Carlos saved it to repo root, overwriting the old one). Verify it references `./docs/architecture.svg` and says "private repo".

### 6d. `DECISIONS.md` — append ADR-011 and ADR-012:

**ADR-011: Event-Driven Execution with Zero Crons**
Status: Accepted. Date: 2026-03-19.
Context: Mac launchd crons. 18+ hour delay. Mac had to be on.
Decision: Events + chains + sentinel. GitHub runners + Max 5x OAuth. Vercel zero crons.
Consequences: Mac not needed. ~915 min/mo (46% free tier). Self-regulating.

**ADR-012: Agent Consolidation from 10 to 7**
Status: Accepted. Date: 2026-03-19.
Context: Overlapping agents. Ghost names. Wasted Claude calls.
Decision: Merge Brain→CEO, Research→Scout, Healer→Ops. Drop 5 ghosts. One verb per agent.
Consequences: Fewer calls. Simpler chains. Migration renames records.

### 6e. `MEMORY.md` — append "Event-Driven Architecture Migration (March 2026)" section:
What changed (10→7 agents, zero crons, Mac-free), agent chains, sentinel conditions, cost ($100/mo).

### 6f. `BRIEFING.md` — replace agents/architecture section:
Updated 7-agent table with runtime, trigger, scope. Architecture summary (events/chains/data).

### 6g. `MISTAKES.md` — append entry #14:
Agent proliferation without scope boundaries. Rule: "Is this a new capability or a new trigger for an existing agent?"

---

## Task 7: Orchestrator cleanup

Update `orchestrator.ts`:
- Rename: venture_brain→ceo, idea_scout→scout, healer→ops, research_analyst→scout, prompt_evolver→evolver
- Remove Venture Brain, Healer, Research Analyst separate calls
- This file is now fallback only

---

## Verification checklist

- [ ] `CLAUDE_CODE_OAUTH_TOKEN` set in GitHub Secrets (from `$HIVE_OAUTH_TOKEN`)
- [ ] `GITHUB_PAT` set in GitHub Secrets (from `gh auth token`)
- [ ] Existing `CRON_SECRET` and `DATABASE_URL` untouched
- [ ] Migration 003 applied, schema.sql updated
- [ ] 4 brain workflows + 1 updated worker workflow + 1 sentinel = 6 .yml files
- [ ] **NO `schedule` on any workflow EXCEPT sentinel**
- [ ] Every brain workflow has chain dispatch step
- [ ] Sentinel queries 7 Neon conditions
- [ ] Worker workflow: no schedule triggers, only `repository_dispatch` + `workflow_dispatch`
- [ ] `docs/architecture.svg` + `docs/architecture-research.md` committed
- [ ] `README.md` with architecture diagram reference
- [ ] `DECISIONS.md` has ADR-011 + ADR-012
- [ ] `MEMORY.md` has migration section
- [ ] `BRIEFING.md` has updated agents/architecture
- [ ] `MISTAKES.md` has #14
- [ ] `orchestrator.ts` uses 7-agent names
- [ ] Manual test: `workflow_dispatch` CEO → GH runner → Neon
