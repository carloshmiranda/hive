# Hive: Event-Driven Cloud Architecture
## Zero Crons. Agents Trigger Agents. Data Drives Everything.

**Date:** March 19, 2026  
**Owner:** Carlos Miranda  
**Constraint:** Claude Max 5x ($100/mo), no API key

---

## 1. Agent Roster: 7 Agents, Zero Overlap

### Consolidation (10 → 7)

| Merged | Into | Reason |
|---|---|---|
| Venture Brain | **CEO** | Both do strategic analysis on same Neon data. Brain's output was only consumed by CEO. One call, one decision. |
| Research Analyst | **Scout** | Both do web research. Same capability, different targets. One agent, two modes. |
| Healer | **Ops** | Ops monitors, Healer fixes. Merge removes handoff delay. One agent: check → fix. |

**Dropped ghost names** (in schema but never executed): `kill_switch`, `retro_analyst`, `health_monitor`, `auto_healer`, `provisioner`

### Final roster

| Agent | Runtime | Scope (one verb) | Never does |
|---|---|---|---|
| **CEO** | Claude (GH runner) | **Decides**: plan cycles, review scores, portfolio analysis, kill recs | No coding, no research, no content |
| **Scout** | Claude (GH runner) | **Researches**: new ideas + market/SEO/competitive intel | No strategy, no content creation |
| **Engineer** | Claude (GH runner) | **Builds**: features, scaffolds, PRs, merges | No monitoring, no strategy |
| **Ops** | Groq (Vercel) | **Monitors**: health, metrics, errors. Fixes or escalates. | No features, no content |
| **Growth** | Gemini (Vercel) | **Creates**: blog posts, SEO, social using Scout's research | No publishing, no experiments |
| **Outreach** | Gemini (Vercel) | **Drafts**: prospects, emails, follow-ups | No sending (action endpoint) |
| **Evolver** | Claude (GH runner) | **Evolves**: analyse performance, propose prompt changes | Only proposes, never executes |

---

## 2. Trigger Model: Events, Data, Chains

### Why every cron was wrong

| Agent | Old cron | The real trigger |
|---|---|---|
| CEO | daily 6am | When a cycle completes, payment arrives, gate is pending, or agent requests direction |
| Scout | Mon/Thu | When pipeline < 3 companies, CEO requests research, or a company is killed |
| Growth | 3x/day | When Scout delivers fresh research, or content queue is empty |
| Outreach | daily 10am | When Scout delivers leads, or uncontacted leads go stale |
| Ops | every 6h | When something deploys, an agent fails, or error rate spikes |
| Evolver | weekly | When enough cycles complete to learn from (10+), or failure rate > 20% |

### Three trigger types

| Type | Mechanism | Example |
|---|---|---|
| **Event** | Something happened → GitHub event or `repository_dispatch` | Payment → CEO. Deploy → Ops. Issue → Engineer. |
| **Chain** | Agent A finishes → dispatches Agent B as last step | Scout → Growth + Outreach. CEO → Scout + Engineer. |
| **Data** | Neon condition becomes true → sentinel dispatches agent | Pipeline < 3 → Scout. No content 7d → Growth. |

### Agent chain map

```
Carlos (issue/PR/approval)
  ↓
CEO ←──── Stripe payment, cycle complete, gate approved
  ├──→ Scout (needs research)
  ├──→ Engineer (needs feature)
  ├──→ Growth (plan has content tasks)
  └──→ Outreach (plan has outreach tasks)

Scout ←── CEO request, pipeline low, company killed
  ├──→ Growth (research delivered → create content)
  ├──→ Outreach (leads found → draft emails)
  └──→ CEO (ideas found → approval gates)

Engineer ←── issue:feature, issue:bug, CEO, Ops escalation
  └──→ CEO (PR opened → strategy review)

Ops ←── deploy, agent error, sentinel
  └──→ Engineer (can't self-fix → creates issue:bug)

Growth ←── Scout chain, CEO plan, sentinel
Outreach ←── Scout chain, CEO plan, sentinel
Evolver ←── sentinel (cycle count or failure rate threshold)
```

### The sentinel

One GitHub Actions workflow, every 4 hours. Queries Neon. Dispatches agents with work. Most runs: zero dispatches.

| Condition | Agent | Why |
|---|---|---|
| `pipeline_count < 3` | Scout (ideas) | Pipeline low |
| `no content for company in 7 days` | Growth | Chain broken |
| `uncontacted leads > 5, stale > 5 days` | Outreach | Leads rotting |
| `no CEO review in 48h for active company` | CEO | Cycle stuck |
| `deploy with no health check in 24h` | Ops | Unverified deploy |
| `completed_cycles since last evolve > 10` | Evolver | Enough data |
| `agent failure rate > 20% in 48h` | Evolver | Systematic issue |

---

## 3. Architecture: Fully Cloud, Mac-Free

### `claude setup-token` = 1-year OAuth token from Max 5x

- Natively supported by `anthropics/claude-code-base-action`
- Runs on GitHub-hosted runners (`ubuntu-latest`)
- No Mac, no Docker, no self-hosted runner

### Platform roles

| Platform | Role | Cost |
|---|---|---|
| **GitHub Actions** | Events, chains, brain agents, sentinel | Free (private, 2,000 min/mo) |
| **Vercel** | Webhooks, worker compute, dashboard | Free (Hobby) |
| **Neon** | All state + sentinel data conditions | Free |
| **Mac** | Not needed | — |

### What Vercel does NOT do
- No crons (all scheduling via GitHub Actions or agent chains)
- No brain agent compute (that's GitHub runners + Claude)
- No polling (purely reactive to HTTP calls)

---

## 4. Usage Budget (5 companies)

| Service | Resource | Limit | Used | Status |
|---|---|---|---|---|
| GitHub Actions | Minutes | 2,000 (private free) | ~915/mo | 46% — room to ~10 companies |
| Vercel Hobby | Invocations | 150,000 | ~2,500 | 2% |
| Vercel Hobby | Crons | 1/day | **0** | Not used |
| Neon Free | CU-hours | 100 | ~15 | 15% |
| Neon Free | Storage | 0.5 GB | ~100 MB | 20% |
| Max 5x | 5h window | ~50 msgs | ~13/day | Monitor |

**Total monthly cost: $100 (existing Max 5x). Everything else free.**

---

## 5. Migration SQL (003)

```sql
ALTER TABLE agent_actions DROP CONSTRAINT IF EXISTS agent_actions_agent_check;
ALTER TABLE agent_actions ADD CONSTRAINT agent_actions_agent_check
  CHECK (agent IN ('ceo', 'scout', 'engineer', 'ops', 'growth', 'outreach', 'evolver'));

ALTER TABLE agent_actions ALTER COLUMN cycle_id DROP NOT NULL;
ALTER TABLE agent_actions ALTER COLUMN company_id DROP NOT NULL;

ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_gate_type_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_gate_type_check
  CHECK (gate_type IN (
    'new_company', 'growth_strategy', 'spend_approval', 'kill_company',
    'prompt_upgrade', 'escalation', 'outreach_batch', 'first_revenue'
  ));

UPDATE agent_actions SET agent = 'scout' WHERE agent IN ('idea_scout', 'research_analyst');
UPDATE agent_actions SET agent = 'ops' WHERE agent IN ('health_monitor', 'auto_healer', 'healer');
UPDATE agent_actions SET agent = 'ceo' WHERE agent IN ('venture_brain', 'kill_switch', 'retro_analyst');
UPDATE agent_actions SET agent = 'engineer' WHERE agent = 'provisioner';
UPDATE agent_actions SET agent = 'evolver' WHERE agent = 'prompt_evolver';

UPDATE agent_prompts SET agent = 'scout' WHERE agent IN ('idea_scout', 'research_analyst');
UPDATE agent_prompts SET agent = 'ops' WHERE agent IN ('health_monitor', 'auto_healer', 'healer');
UPDATE agent_prompts SET agent = 'ceo' WHERE agent = 'venture_brain';
UPDATE agent_prompts SET agent = 'evolver' WHERE agent = 'prompt_evolver';
```

---

## 6. Implementation Phases

### Phase 1: Foundation
1. Carlos: `claude setup-token` on Mac → gives 1-year OAuth token
2. Carlos: Create `GITHUB_PAT` fine-grained token (contents:write on hive repo)
3. Automated by Claude Code: `gh secret set` for all GitHub Secrets
4. Automated by Claude Code: Run migration 003 via node script

### Phase 2: Brain agent workflows (4 files)
5. `hive-ceo.yml` — events + chain dispatch
6. `hive-scout.yml` — events + chain to Growth/Outreach
7. `hive-engineer.yml` — issues + PRs + escalations
8. `hive-evolver.yml` — data-driven triggers

### Phase 3: Sentinel + chains + webhooks
9. `hive-sentinel.yml` — queries Neon, dispatches agents
10. Chain dispatch steps in all workflows
11. `/api/webhooks/stripe/route.ts`
12. Update dispatch endpoint for Ops → Engineer chain

### Phase 4: Cleanup + docs
13. Remove Vercel crons
14. Remove Mac launchd plists
15. README.md with architecture diagram
16. DECISIONS.md (ADR-011 event-driven, ADR-012 consolidation)
17. MEMORY.md, BRIEFING.md updates
