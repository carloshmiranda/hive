# Growth Agent Intelligence Layer — Research & Design

> Context: This document captures research and architectural decisions from a Claude Chat session on 2026-03-19. Pass this to Claude Code when ready to implement.
> Prerequisites: Model routing PR should be merged first. Dashboard redesign should be deployed.

## Problem statement

Growth currently creates content blind — no ranking data, no visibility tracking, no feedback loop. It writes a blog post, publishes it, and never checks if it ranked. The cycle cadence was designed around human work-week patterns (weekly GSC pulls, Wednesday evolver runs) instead of data-freshness triggers appropriate for an agentic system.

Additionally, organic visibility in 2026 spans three layers, not just Google:
1. **Traditional search engines** — Google (65-70%), Bing (10-15%, feeds Copilot), DuckDuckGo, Yandex
2. **AI answer engines** — ChatGPT, Perplexity, Google AI Overviews, Claude, Gemini, Copilot
3. **Social/community discovery** — Reddit, HN, Stack Overflow, niche forums, YouTube

Key finding from research: brands ranking on Google's first page appear in ChatGPT answers 62% of the time. Strong SEO is the foundation for LLM visibility, but not sufficient alone.

## Architectural decisions

### Cadence: event-driven and data-freshness-driven, not calendar-based

An agent checks when data is stale or when a threshold is crossed, not because it's a specific day. "Every 7 cycles" means "after 7 company cycles complete," not "every Wednesday." This removes human-time constraints from an autonomous system.

### Data sources — all free tier

| Service | Cost | Rate limit | Purpose |
|---|---|---|---|
| Google Search Console API | Free | 25,000 rows/day | Keyword positions, impressions, CTR per page |
| Bing Webmaster Tools API | Free | Per-URL calls | Bing performance + AI citation preview data |
| IndexNow protocol | Free | 10,000 URLs/day | Instant re-indexing on content publish (Bing, Yandex) |
| Gemini 2.5 Flash (already configured) | Free | 250 RPD | DIY LLM citation checks |
| Vercel Analytics (already collecting) | Free | N/A | Traffic, referrers, Web Vitals |

No paid GEO tools needed. DIY approach gives 80% of €500/mo Profound subscription.

### No paid tools at this stage

Researched: Profound (€500/mo), LLMrefs (€40/mo), Scrunch AI, Peec AI, Cairrot, SE Ranking. All overkill for early-stage. Hive can build its own LLM visibility tracker using Gemini free tier for citation checks.

## Data collection — what and when

### Every cycle (every time the company processes):

1. **GSC pull** — impressions, clicks, positions, CTR for all indexed keywords
   - API: `https://searchconsole.googleapis.com/v1/sites/{site}/searchAnalytics/query`
   - Auth: Service account JSON key (stored encrypted in settings as `google_search_console_key`)
   - Query: last 7 days, group by page + query, filter by company domain
   
2. **Bing Webmaster Tools pull** — keyword performance
   - API: `https://ssl.bing.com/webmaster/api.svc/json/GetQueryStats`
   - Auth: API key from BWT dashboard
   - Note: AI Performance report (citations in Copilot) launched Feb 2026 but API access is still limited/beta. Monitor for API availability.

3. **Vercel Analytics** — already collected via `/api/cron/metrics`

4. **IndexNow submission** — fire on every deploy that includes content changes
   - Protocol: POST to `https://api.indexnow.org/IndexNow`
   - Supports: Bing, Yandex, Naver, Seznam, Yep
   - Google does NOT support IndexNow as of March 2026

### Every 3 cycles:

5. **DIY LLM citation check** using Gemini free tier:
   ```
   For each company's top 10 target keywords:
     1. Construct buyer-intent prompt: "What's the best {keyword} tool?"
     2. Send to Gemini 2.5 Flash
     3. Parse response for:
        - Is our company mentioned? (brand mention)
        - Is our URL cited? (direct citation)
        - Which competitors ARE mentioned?
        - What sources are cited?
     4. Store in research_reports as type 'llm_visibility'
     5. Track share of voice over time
   ```

### Every 7 cycles:

6. **Competitor content scan** — Scout web search for competitor publishing activity
7. **Backlink profile scan** — who links to competitors that doesn't link to us?

### On every content publish (immediate):

8. **IndexNow ping** — POST new/updated URL
9. **Internal link update** — Engineer adds links from existing high-traffic pages to new content
10. **Social distribution** — Growth posts to relevant communities from research_reports
11. **LLM-friendliness check** — verify structured data, FAQ schema, clear H1, `llms.txt` exists

## New `llms.txt` standard

Similar to `robots.txt`, `llms.txt` at site root tells AI crawlers what the site is about. Boilerplate should auto-generate on provisioning:

```
# {CompanyName}
> {One-line description}

## Key pages
- /: Landing page — what {CompanyName} does and who it's for
- /pricing: Plans and pricing
- /blog: Articles about {topic}
- /docs: Product documentation

## About
{2-3 sentence description of the company, target audience, and value proposition}
```

Free, takes seconds, signals to GPTBot/ClaudeBot which content to prioritize.

## Schema changes needed

### New table: `visibility_metrics`

Parallels the existing `metrics` table but for SEO/visibility data. One row per keyword per date per company.

```sql
CREATE TABLE visibility_metrics (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  company_id    TEXT NOT NULL REFERENCES companies(id),
  date          DATE NOT NULL,
  source        TEXT NOT NULL CHECK (source IN (
                  'gsc',           -- Google Search Console
                  'bwt',           -- Bing Webmaster Tools
                  'llm_gemini',    -- Gemini citation check
                  'llm_chatgpt',   -- ChatGPT citation check (future)
                  'vercel'         -- Vercel Analytics referrer data
                )),
  keyword       TEXT,              -- the search query or LLM prompt
  url           TEXT,              -- the page that ranked/was cited
  impressions   INTEGER DEFAULT 0, -- GSC/BWT: how many times shown
  clicks        INTEGER DEFAULT 0, -- GSC/BWT: how many clicks received
  position      NUMERIC(6,2),      -- GSC/BWT: average position
  ctr           NUMERIC(5,4),      -- click-through rate
  cited         BOOLEAN,           -- LLM: was the company cited?
  mentioned     BOOLEAN,           -- LLM: was the brand mentioned (without link)?
  competitors   JSONB,             -- LLM: which competitors were mentioned
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(company_id, date, source, keyword, url)
);

CREATE INDEX idx_visibility_company_date ON visibility_metrics(company_id, date DESC);
CREATE INDEX idx_visibility_keyword ON visibility_metrics(company_id, keyword);
```

### New research_reports types

Add to the CHECK constraint:
- `visibility_snapshot` — aggregated point-in-time visibility summary
- `llm_visibility` — per-keyword LLM citation results
- `content_performance` — per-URL metrics (impressions, clicks, CTR, position, age)
- `content_gaps` — derived: keywords competitors rank for that we don't

### Settings to add

| Key | Description | Where to get it |
|---|---|---|
| `google_search_console_key` | Already exists in schema | service account JSON from GSC |
| `bing_webmaster_key` | New | BWT dashboard → API Access |
| `indexnow_key` | New | Generate random string, place at site root |

## Restructured Growth cycle

```
STEP 0: Collect visibility data (autonomous, every cycle)
  ├─ Pull GSC data: impressions, clicks, positions for all tracked keywords
  ├─ Pull Bing Webmaster data: same metrics
  ├─ Pull Vercel Analytics: traffic sources, top pages, referrers
  ├─ Run LLM citation check (every 3rd cycle): top 10 keywords across Gemini
  └─ Store everything in visibility_metrics + research_reports

STEP 1: Analyze gaps (autonomous)
  ├─ Compare current positions vs last cycle — what improved, what dropped?
  ├─ Identify "striking distance" keywords (position #4-10 → one good post could push to #1-3)
  ├─ Identify content gaps (competitor ranks, we don't)
  ├─ Identify pages with high impressions but low CTR (title/meta optimization needed)
  ├─ Check LLM visibility: are we cited? If not, what's missing?
  └─ Output: prioritized task list ranked by impact potential

STEP 2: Execute highest-impact task (autonomous)
  Priority order:
  1. Fix dropping pages (content refresh, update date, add new sections)
  2. Optimize striking-distance keywords (improve existing content, add internal links)
  3. Fill content gaps (new posts targeting uncovered keywords)
  4. Improve LLM citability (structured data, FAQ schema, clear definitions, llms.txt)
  5. Distribute existing content to new channels (communities, cross-posts)

STEP 3: Publish and notify (autonomous)
  ├─ Commit content to repo → PR → CI → auto-merge
  ├─ Fire IndexNow for all new/updated URLs
  ├─ Post to relevant communities (from research_reports lead_list)
  └─ Log action + rationale in agent_actions

STEP 4: Measure impact (next cycle, automatic)
  ├─ Did the published content get indexed? (GSC shows impressions within 2-3 days)
  ├─ Did rankings improve for target keyword?
  ├─ Did LLM citations change?
  └─ Write playbook entry if impact was significant (>20% improvement on any metric)
```

Key shift: Growth NEVER runs without fresh data. Every content decision is data-backed, every publish is measured, every measurement feeds the next decision.

## Boilerplate template changes needed

The `templates/boilerplate/` should ship with:

1. **`public/llms.txt`** — auto-generated during provisioning with company details
2. **`public/.well-known/indexnow/{key}.txt`** — IndexNow key verification file
3. **Structured data in layout.tsx** — Organization schema, WebSite schema
4. **FAQ schema component** — reusable component for blog posts with FAQ sections
5. **Sitemap.xml generator** — dynamic sitemap from Next.js pages + blog posts
6. **robots.txt** — allow GPTBot, ClaudeBot, Bingbot explicitly

## Implementation phases

### Phase 1: GSC + IndexNow integration
- Add GSC API client to `src/lib/gsc.ts`
- Add IndexNow client to `src/lib/indexnow.ts`
- Create `visibility_metrics` table (migration 004)
- Update Growth prompt to read visibility data before creating content
- Add IndexNow ping to deploy workflow
- Update boilerplate with llms.txt, structured data, sitemap

### Phase 2: LLM citation tracker
- Build DIY citation checker using Gemini API (already available)
- Add `llm_visibility` report type
- Growth prompt updated: if not cited in LLMs, prioritize structured/citable content
- Track share of voice over time

### Phase 3: Bing Webmaster Tools
- Add BWT API client
- Pull Bing-specific keyword data
- Monitor AI citation data when API becomes available (currently dashboard-only)

### Phase 4: Content performance loop
- Automated content audit: flag pages older than 60 days with declining impressions
- Auto-refresh workflow: Growth updates stale content instead of always creating new
- Internal linking automation: Engineer adds cross-links between topically related pages

## ADR to create

### ADR-014: Data-driven organic growth with multi-surface visibility tracking
**Context:** Growth agent was creating content without ranking data or feedback loops. Visibility in 2026 spans traditional search, AI answer engines, and community discovery. Calendar-based refresh cadences were designed for human constraints.
**Decision:** Event-driven visibility data collection across GSC, BWT, Vercel Analytics, and DIY LLM citation checks. Growth never executes without fresh data. New `visibility_metrics` table for time-series tracking. `llms.txt` standard adopted for AI crawler optimization. IndexNow protocol for instant Bing/Yandex re-indexing. All free-tier APIs, €0 additional cost.
**Alternatives considered:**
- Paid GEO tools (Profound €500/mo, LLMrefs €40/mo): overkill for early-stage, data doesn't flow into agent context
- GSC-only: misses Bing (10-15% of search) and AI answer engines (growing fast)
- Weekly cadence: too slow for an autonomous system, data stales between cycles
**Consequences:** Growth makes data-backed decisions every cycle. Content impact is measurable within 2-3 days. LLM visibility is trackable for free. Every piece of content becomes a ranking experiment with automatic measurement.

## Open questions

1. GSC auth: service account vs OAuth? Service account is simpler for server-to-server but requires Carlos to set up a GCP project (free). OAuth is more complex but doesn't need GCP.
2. Should the LLM citation check also query ChatGPT via web search? (No free API, but we could use web search to find "what does ChatGPT say about {keyword}" results.)
3. Bing AI Performance API — currently not available. Should we build a scraper for the BWT dashboard, or wait for the API?
4. Should visibility data be per-company or should we also track Hive-level keywords (e.g. "venture orchestrator", "autonomous business")?
