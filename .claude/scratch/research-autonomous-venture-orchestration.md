# Research: Autonomous AI-Driven Venture Orchestration

Research compiled for Hive's strategic intelligence layer. All frameworks below are designed to be implementable by an AI CEO agent operating autonomously with human gates only for spend, launches, and kills.

---

## 1. Automating the Build-Measure-Learn Loop

### The Automated BML Cycle

The Build-Measure-Learn loop can be automated when each phase has clear inputs, outputs, and decision gates:

**Build phase (automated):**
- AI Engineer executes tasks from a prioritized backlog
- Each task is an MVP experiment, not a feature — the smallest thing that tests a hypothesis
- Output: deployed code with tracking instrumented

**Measure phase (automated):**
- Metrics cron scrapes data at fixed intervals (Hive already does this)
- Cohort-based metrics, NOT vanity metrics. Track per-cohort: activation rate, retention curve, conversion rate, time-to-value
- Minimum measurement window: 7 days for engagement metrics, 14 days for retention, 30 days for revenue signals

**Learn phase (AI CEO decides):**
- Compare metrics against pre-set thresholds (see Section 3)
- Three possible outcomes: **Continue** (metrics improving), **Pivot** (metrics flat/declining after 2+ cycles), **Kill** (metrics below kill threshold after grace period)

### Actionable Metrics vs. Vanity Metrics

| USE (Actionable) | AVOID (Vanity) |
|---|---|
| Cohort retention (Day 1/7/30) | Total page views |
| Activation rate (% completing key action) | Total signups |
| Conversion rate (visitor-to-signup, signup-to-paid) | Total users |
| Revenue per visitor | Social followers |
| Time-to-value (signup to "aha moment") | Total downloads |
| Willingness to pay (pricing page clicks / fake-door CTR) | Press mentions |

### YC's Programmatic Evaluation

Y Combinator measures startups on a single metric per week, usually revenue. Their benchmarks:
- **Exceptional:** 10% week-over-week growth
- **Good:** 5-7% week-over-week growth
- **Concerning:** 1% week-over-week growth (haven't found what works)
- **Failing:** Flat or negative growth for 3+ consecutive weeks

For pre-revenue: substitute active users or engagement frequency as the primary metric.

---

## 2. Data-Driven Product Prioritization

### RICE Scoring (Recommended for AI CEO)

RICE is the most automatable framework because all four factors can be derived from data:

```
RICE Score = (Reach x Impact x Confidence) / Effort

Reach     = estimated users affected per quarter (from analytics)
Impact    = 0.25 (minimal) | 0.5 (low) | 1 (medium) | 2 (high) | 3 (massive)
Confidence = 0.5 (low) | 0.8 (medium) | 1.0 (high, backed by data)
Effort    = person-days estimated
```

**How an AI CEO uses RICE with real data:**

| Data Source | Maps To |
|---|---|
| Page views on feature/landing page | Reach |
| Conversion rate of similar features | Impact |
| Whether hypothesis is backed by user data vs. assumption | Confidence |
| Engineering complexity estimate (S/M/L = 1/3/7 days) | Effort |

### ICE Scoring (Faster, for growth experiments)

```
ICE Score = Impact (1-10) x Confidence (1-10) x Ease (1-10)
```

Best for rapid prioritization of growth experiments where detailed data is unavailable. Use ICE for marketing/growth tasks, RICE for product/engineering tasks.

### Decision Matrix for AI CEO

```
IF task has user data backing it     → Confidence = 1.0
IF task is based on competitor intel → Confidence = 0.8
IF task is a hypothesis only         → Confidence = 0.5
IF task addresses a known churn cause → Impact = 3 (massive)
IF task adds a new feature           → Impact = 1 (medium)
IF task is cosmetic/polish           → Impact = 0.5 (low)
```

---

## 3. Automated Pivot Detection

### Pivot Signal Matrix

These are quantitative signals an AI CEO should monitor. When thresholds are breached, flag for pivot evaluation:

| Signal | Threshold | Window | Action |
|---|---|---|---|
| High traffic, zero conversions | >500 visitors, <1% signup rate | 30 days | Pivot messaging/positioning |
| Signups but no activation | >50 signups, <20% complete onboarding | 14 days | Pivot onboarding or core value prop |
| Activation but no retention | Day-7 retention <15% | 30 days | Pivot product/feature set |
| Retention but no revenue | >30 retained users, 0 revenue | 60 days | Pivot pricing or monetization model |
| Flat growth | <2% WoW growth for 4+ weeks | 28 days | Pivot channel or audience |
| LTV:CAC ratio | <2.5x for 2+ cohorts | 60 days | Pivot pricing, reduce CAC, or kill |
| CAC payback | >18 months (SMB) or >30 months (mid-market) | 90 days | Pivot acquisition strategy |
| Retention curve | Keeps declining past 90 days (no flattening) | 90 days | Fundamental PMF problem — major pivot or kill |

### Sean Ellis PMF Test (Quantitative)

Survey users: "How would you feel if you could no longer use [product]?"
- **>=40% "very disappointed"** → Product-market fit achieved. Scale.
- **25-39%** → Close to PMF. Iterate on the product for the "somewhat disappointed" segment.
- **<25%** → No PMF. Pivot required.

This can be automated with an in-app survey triggered after a user's 3rd session or 7th day.

### Pivot Type Decision Tree

```
IF high_traffic AND low_signup_rate:
  → PIVOT TYPE: Value proposition / messaging
  → ACTION: A/B test landing page copy, rewrite headline

IF signups_ok AND low_activation:
  → PIVOT TYPE: Onboarding / core feature
  → ACTION: Simplify first-run experience, change "aha moment"

IF activation_ok AND low_retention:
  → PIVOT TYPE: Product / feature set
  → ACTION: Interview churned users, identify missing feature or wrong audience

IF retention_ok AND zero_revenue:
  → PIVOT TYPE: Monetization / pricing
  → ACTION: Test pricing page, add payment gate, try freemium vs. paid

IF all_metrics_declining AND age > 90_days:
  → PIVOT TYPE: Fundamental (new market or kill)
  → ACTION: Evaluate kill criteria (Section 4)
```

---

## 4. Portfolio Theory for Venture Building

### Resource Allocation Framework

Venture studios like Idealab (150+ companies launched), Antler (30 global locations), and Founders Factory use stage-gated resource allocation:

**Stage-Based Resource Budget:**

| Stage | Max Eng Tasks/Cycle | Growth Budget | Duration Cap | Kill Review |
|---|---|---|---|---|
| Validate (landing page) | 2 | SEO only, $0 spend | 60 days | At 60 days |
| Test Intent (fake door) | 2 | Content + SEO, $0 spend | 45 days | At 45 days |
| Build MVP | 3 | Content + social, $0 spend | 90 days | At 90 days |
| Launch | 4 | All channels, <EUR20/experiment | 60 days | At 60 days |
| Growth | 5 | All channels, budget approved | Ongoing | Every 90 days |

### Kill/Continue Decision Framework

Inspired by Alloy Innovation's "$100K in 6 months" threshold and Founders Factory's RAYG system:

```
KILL if ANY of:
  - 0 signups after 60 days with landing page live
  - 0 activation after 90 days with product live
  - <5% WoW growth for 8+ consecutive weeks AND no revenue
  - LTV:CAC < 1.0 after 120 days
  - Sean Ellis PMF score < 15% after 60+ active users surveyed
  - 3 failed pivots (each given 30+ day runway)

CONTINUE if ANY of:
  - Any revenue (even $1) → extends patience to 180 days
  - WoW growth >= 5% sustained for 4+ weeks
  - Retention curve flattening above 20% at Day 30
  - Sean Ellis PMF score >= 25%

DOUBLE DOWN if ALL of:
  - WoW growth >= 7% sustained for 4+ weeks
  - Sean Ellis PMF score >= 40%
  - LTV:CAC >= 3.0
  - Revenue growing MoM
```

### Portfolio Scoring (for Sentinel priority dispatch)

Enhance the existing priority score with outcome-weighted factors:

```
Priority Score =
  + pending_tasks * 2
  + days_since_last_cycle * 3 (cap 14)
  + (lifecycle == 'new' AND cycles < 3) ? 18 : 0
  + (ceo_score < 5) ? 5 : 0
  + (has_directive) ? 15 : 0
  + (has_revenue) ? 10 : 0          # NEW: revenue = signal of PMF
  + (wow_growth > 5%) ? 8 : 0       # NEW: growing companies get more cycles
  - completed_cycles * 0.5
  - (consecutive_flat_weeks > 4) ? 10 : 0  # NEW: deprioritize stalled companies
```

---

## 5. OKR/KPI Automation by Business Type

### North Star Metrics

| Business Type | North Star Metric | Why |
|---|---|---|
| SaaS | Weekly Active Users paying (or MRR) | Combines retention + revenue |
| Blog / Content | Monthly organic sessions | SEO-driven traffic = monetizable audience |
| Affiliate Site | Monthly affiliate click revenue | Direct revenue proxy |
| Newsletter | Weekly subscriber growth rate | Audience = monetizable asset |
| Faceless YouTube | Monthly ad revenue (RPM x views) | Direct revenue |

### Automated OKR Templates by Stage

**SaaS - Validate Stage:**
```
Objective: Prove demand exists
  KR1: 500+ unique visitors from organic/content (not paid)
  KR2: 5%+ visitor-to-signup conversion rate
  KR3: 3+ pricing page click-throughs (fake door)
```

**SaaS - Build MVP Stage:**
```
Objective: Achieve first activation
  KR1: 25+ users complete core action (activation)
  KR2: Day-7 retention >= 30%
  KR3: 1+ user completes payment flow
```

**SaaS - Growth Stage:**
```
Objective: Reach sustainable unit economics
  KR1: MRR >= EUR500
  KR2: Monthly churn < 8%
  KR3: LTV:CAC >= 3.0
  KR4: NRR >= 100%
```

**Blog - Seed Content Stage:**
```
Objective: Establish organic traffic
  KR1: 20+ articles published (SEO-optimized)
  KR2: 1,000+ monthly organic sessions
  KR3: Average time on page > 2 minutes
  KR4: Bounce rate < 70%
```

**Blog - Monetize Stage:**
```
Objective: Generate first revenue
  KR1: RPM >= $5 (ad revenue per 1,000 views)
  KR2: 10,000+ monthly page views
  KR3: 1+ affiliate or sponsorship deal closed
```

**Affiliate Site - Build Stage:**
```
Objective: Drive affiliate clicks
  KR1: 50+ comparison/listing pages live
  KR2: 5,000+ monthly organic sessions
  KR3: 2%+ click-through rate on affiliate links
  KR4: EPC (earnings per click) >= $0.50
```

### Benchmark Thresholds for Automated Monitoring

| Metric | Bad | Acceptable | Good | Great |
|---|---|---|---|---|
| SaaS monthly churn | >8% | 5-8% | 3-5% | <3% |
| SaaS activation rate | <10% | 10-25% | 25-40% | >40% |
| SaaS Day-30 retention | <10% | 10-20% | 20-35% | >35% |
| SaaS NRR | <90% | 90-100% | 100-110% | >110% |
| Blog bounce rate | >80% | 65-80% | 50-65% | <50% |
| Blog avg time on page | <1 min | 1-2 min | 2-4 min | >4 min |
| Affiliate conversion rate | <0.5% | 0.5-1% | 1-3% | >3% |
| Affiliate CTR | <0.5% | 0.5-1% | 1-2% | >2% |
| WoW growth (any type) | <1% | 1-3% | 3-7% | >7% |

---

## 6. Competitive Intelligence Automation

### Data Sources to Monitor

| Source | What to Track | Frequency | Tool/Method |
|---|---|---|---|
| Competitor websites | Pricing changes, new features, copy changes | Weekly | Web scraping / Visualping |
| G2/Trustpilot/Capterra | Customer sentiment, feature complaints | Bi-weekly | API or scraping |
| Job postings | Hiring patterns reveal strategic pivots | Monthly | LinkedIn/Indeed scraping |
| SEO rankings | Keyword movements, new content | Weekly | Ahrefs/SEMrush API or free alternatives |
| Social media | Engagement rates, content strategy | Weekly | Social listening |
| Product Hunt / HN | New launches in same space | Daily | RSS/API monitoring |
| GitHub (if open source) | Commit activity, star growth, contributor count | Weekly | GitHub API |

### Competitive Intelligence Decision Rules

```
IF competitor_drops_price > 20%:
  → FLAG: Price war risk. CEO should evaluate pricing strategy.

IF competitor_launches_feature IN our_roadmap:
  → ACTION: Deprioritize that feature, differentiate elsewhere.

IF competitor_hiring_pattern INCLUDES our_target_role:
  → SIGNAL: They're expanding into adjacent space.

IF our_seo_ranking_drops > 5_positions FOR target_keyword:
  → ACTION: Prioritize content refresh for that keyword.

IF new_competitor_launches IN our_niche:
  → ACTION: Research Analyst produces competitive analysis within 48h.
```

### Implementation for Hive

The Research Analyst agent (already in Hive's cycle) should produce structured output:

```json
{
  "competitors_tracked": ["name1", "name2"],
  "pricing_changes": [],
  "new_features": [],
  "seo_movements": [{"keyword": "...", "our_rank": 12, "prev_rank": 8, "top_competitor": "..."}],
  "threats": ["..."],
  "opportunities": ["..."],
  "recommended_actions": [{"action": "...", "priority": "P1", "rationale": "..."}]
}
```

---

## 7. Growth Experimentation Frameworks

### Minimum Viable Experiment (MVE)

An MVE is the smallest test that validates or invalidates a growth hypothesis. Rules:

1. **State the hypothesis:** "If we [do X], then [metric Y] will [change by Z%]"
2. **Define success criteria BEFORE running:** e.g., "Success = 5%+ CTR on new CTA"
3. **Set a time box:** 7-14 days for most digital experiments
4. **Measure one thing:** Don't change multiple variables

### Channel Selection Decision Tree

```
IF company_age < 30_days:
  → CHANNELS: SEO (long-term), Content marketing (medium-term)
  → AVOID: Paid (no data to optimize), Social (no audience)

IF company_age 30-90_days AND has_content:
  → CHANNELS: SEO, Content, Social (organic)
  → TEST: One paid experiment ($0-20) if landing page converts > 3%

IF company_age > 90_days AND has_traffic:
  → CHANNELS: All organic + email outreach
  → TEST: Paid if organic CAC is known (use as benchmark)

IF company_has_revenue:
  → CHANNELS: All. Prioritize by CAC per channel.
  → RULE: Never spend more than 30% of MRR on acquisition
```

### Growth Experiment Prioritization (ICE)

Rate each experiment 1-10 on:
- **Impact:** How much will this move the North Star metric?
- **Confidence:** How sure are we this will work? (data-backed = 8-10, gut = 3-5)
- **Ease:** How fast/cheap to implement? (1 day = 10, 1 week = 5, 1 month = 2)

Run top 3 experiments per cycle. Kill experiments that don't show signal within their time box.

### Channel Benchmarks (When to Double Down vs. Abandon)

| Channel | Minimum Test | Success Signal | Abandon Signal |
|---|---|---|---|
| SEO / Content | 10 articles, 60 days | Any keyword ranking page 1-3 | Zero impressions after 60 days |
| Social (organic) | 20 posts, 30 days | >2% engagement rate | <0.5% engagement after 30 posts |
| Email outreach | 50 cold emails, 14 days | >2% reply rate | <0.5% reply rate |
| Paid (search) | $50, 7 days | CPC < $2 AND CTR > 2% | CPC > $5 OR CTR < 0.5% |
| Paid (social) | $50, 7 days | CPM < $15 AND CTR > 1% | CPM > $30 OR zero conversions |
| Product Hunt launch | 1 launch | Top 5 of the day | <50 upvotes |

---

## 8. Revenue Optimization for Pre-Revenue Companies

### Leading Indicators That Predict Revenue

Ranked by predictive power (strongest first):

| Indicator | Why It Predicts Revenue | How to Measure |
|---|---|---|
| Pricing page visits / fake-door CTA clicks | Direct willingness-to-pay signal | Track clicks on "Buy" / "Start trial" |
| Email collection + open rate | Engaged audience = future customers | Signup rate + email engagement |
| Return visits (Day 7/14/30) | Habit formation = retention = revenue | Cohort retention analysis |
| Time-to-value < 5 minutes | Fast value = high activation = conversion | Measure time from signup to key action |
| Feature usage depth | Power users convert first | Track # of features used per session |
| Organic referrals | Word-of-mouth = PMF signal | Track referral source in signups |
| Support/feedback requests | Users who ask questions are invested | Count support interactions |

### Revenue Readiness Score

An AI CEO can compute a "revenue readiness" score to decide when to add payment:

```
Revenue Readiness Score (0-100):
  + pricing_page_views > 10       → +20
  + fake_door_ctr > 3%            → +20
  + day_7_retention > 25%         → +15
  + activation_rate > 30%         → +15
  + organic_referrals > 5         → +10
  + avg_session_duration > 3_min  → +10
  + support_requests > 3          → +10

Score >= 60 → Add payment flow
Score 40-59 → Continue building, focus on activation
Score < 40  → Not ready, focus on value proposition
```

### Revenue-Generating Activity Priority Stack

For a company at $0 revenue, prioritize in this order:

1. **Validate demand** (Week 1-4): Landing page + fake-door pricing → measures willingness to pay
2. **Build activation loop** (Week 4-8): Ensure users reach "aha moment" in <5 minutes
3. **Add payment** (When Revenue Readiness >= 60): Stripe checkout, start at lowest viable price
4. **Optimize conversion** (Post first payment): A/B test pricing, upsells, annual vs. monthly
5. **Scale acquisition** (Post 10 customers): Double down on best-performing channel

### Pre-Revenue to Revenue Timeline Expectations

| Business Type | Expected Time to First Revenue | Red Flag If No Revenue By |
|---|---|---|
| SaaS (B2B) | 60-120 days from MVP | 180 days |
| SaaS (B2C) | 30-90 days from MVP | 120 days |
| Blog (ads) | 90-180 days from first content | 365 days |
| Affiliate site | 60-120 days from content launch | 180 days |
| Newsletter | 90-180 days from launch | 365 days |

---

## 9. Data Collection Requirements

For all frameworks above to work, Hive needs to collect and store:

### Must-Have Data (collect from Day 1)

| Data Point | Source | Storage | Used By |
|---|---|---|---|
| Page views (per page, per day) | Middleware / Vercel Analytics | `page_views` table | All agents |
| Unique visitors (daily) | Vercel Analytics | `metrics` table | CEO, Growth |
| Signup count + timestamp | App DB | `customers` / `waitlist` | CEO, Growth |
| Activation events (key action completed) | App tracking | `metrics` table | CEO |
| Pricing page / CTA clicks | `/api/pricing-intent` | `pricing_clicks` table | CEO (revenue readiness) |
| Affiliate link clicks | `/api/affiliate-click` | `affiliate_clicks` table | CEO (affiliate sites) |
| Retention cohorts (Day 1/7/30) | Computed from visits | `metrics` table | CEO (pivot detection) |
| Bounce rate | Vercel Analytics | `metrics` table | Growth |
| Avg session duration | Vercel Analytics | `metrics` table | Growth |
| Referral source | UTM params / referrer header | `page_views` table | Growth |
| Revenue / MRR | Stripe webhooks | `metrics` table | CEO, Venture Brain |
| Churn events | Stripe webhooks | `metrics` table | CEO |

### Nice-to-Have Data (add when capacity allows)

| Data Point | Source | Used By |
|---|---|---|
| Sean Ellis PMF survey responses | In-app survey | CEO (PMF scoring) |
| NPS scores | In-app survey | CEO |
| Feature usage heatmap | Custom tracking | CEO (prioritization) |
| Support ticket count/topics | Email parsing | CEO |
| Competitor pricing snapshots | Web scraping | Research Analyst |
| SEO keyword rankings | Ahrefs/SEMrush API | Research Analyst, Growth |
| Social engagement metrics | Platform APIs | Growth |

---

## 10. Summary: Decision Trees for AI CEO

### Weekly Decision Tree

```
1. READ metrics for all companies
2. FOR EACH company:
   a. COMPUTE: WoW growth rate, activation rate, retention (Day 7/30)
   b. CHECK pivot signals (Section 3 matrix)
   c. IF any pivot signal triggered:
      → LOG pivot recommendation
      → IF 2+ signals triggered → escalate to Carlos
   d. COMPUTE Revenue Readiness Score (Section 8)
   e. IF score >= 60 AND no payment flow:
      → PLAN: Add Stripe checkout as P0 engineering task
   f. PRIORITIZE tasks using RICE (Section 2)
   g. SELECT top 2-3 eng tasks + top 2-3 growth experiments
   h. ASSIGN to Engineer and Growth agents
```

### Monthly Portfolio Review

```
1. RANK all companies by composite score:
   Score = (MRR * 10) + (WoW_growth * 20) + (retention_d30 * 5) + (PMF_score * 2)
2. TOP quartile → DOUBLE DOWN (more cycles, more tasks)
3. MIDDLE two quartiles → STANDARD treatment
4. BOTTOM quartile → EVALUATE kill criteria
5. IF any company meets KILL criteria → create kill_company approval
6. IF portfolio < 3 active → trigger Scout for new ideas
```

### Per-Cycle CEO Planning Template

```
CONTEXT:
  Company: {name}
  Stage: {validate|test_intent|build_mvp|growth}
  Validation Score: {0-100}
  WoW Growth: {x%} (trend: up/flat/down)
  Key Metrics: {activation: x%, retention_d7: x%, revenue: $x}

ASSESSMENT:
  PMF Status: {no_signal|early_signal|approaching|achieved}
  Revenue Readiness: {score}/100
  Pivot Signals: {none|[list]}
  Kill Criteria Met: {yes/no}

PLAN:
  Engineering Tasks (max {N} per stage rules):
    1. {task} — RICE: {score} — hypothesis: {if X then Y}
  Growth Experiments (max 3):
    1. {experiment} — ICE: {score} — success: {criteria}

  This Cycle's Hypothesis: "{if we do X, we expect Y by Z date}"
  Kill Review: {next review date}
```

---

Sources:
- [The Lean Startup Principles](https://theleanstartup.com/principles)
- [Build-Measure-Learn Loop — UserPilot](https://userpilot.com/blog/build-measure-learn/)
- [Build-Measure-Learn — LeanPivot.ai](https://leanpivot.ai/lean-startup-guide/build-measure-learn/)
- [RICE Scoring Model — ProductPlan](https://www.productplan.com/glossary/rice-scoring-model/)
- [RICE Framework — Intercom](https://www.intercom.com/blog/rice-simple-prioritization-for-product-managers/)
- [Feature Prioritization Using RICE and ICE — Agile Seekers](https://agileseekers.com/blog/feature-prioritization-using-rice-and-ice-models-in-product-roadmaps)
- [Strategic Pivots in Startups — Visible.vc](https://visible.vc/blog/startup-pivot/)
- [Pivot or Persevere — ThinSlices](https://www.thinslices.com/insights/pivot-or-persevere-make-startup-decisions-that-drive-success)
- [Systematic Derisking Framework — MAccelerator](https://maccelerator.la/en/blog/enterprise/systematic-derisking-framework-venture-studios-validation/)
- [Venture Studio Model — YeStack](https://www.yestack.io/blog/venture-studio-model-challenges-and-opportunities-for-success)
- [Kill/Pivot/Build Framework — Bundl](https://www.bundl.com/articles/faqs-when-to-build-pivot-or-kill-a-corporate-venture)
- [Venture Studio Quality-First — VSF](https://newsletter.venturestudioforum.org/p/the-quality-first-revolution)
- [North Star Metric — Dashly](https://www.dashly.io/blog/north-star-metric/)
- [OKRs for SaaS — UserPilot](https://userpilot.com/blog/saas-okrs-examples-best-practices/)
- [AI and Competitive Intelligence — CIA](https://www.competitiveintelligencealliance.io/how-ai-and-automation-are-transforming-competitive-intelligence/)
- [Competitive Intelligence 7-Step Framework — ITONICS](https://www.itonics-innovation.com/blog/competitive-intelligence)
- [Growth Experimentation Framework — Strategic AI Leader](https://www.strategicaileader.com/the-ultimate-growth-experimentation-framework/)
- [Minimum Viable Experiment — GrowthMethod](https://growthmethod.com/minimum-viable-experiment/)
- [AARRR Pirate Metrics — PostHog](https://posthog.com/product-engineers/aarrr-pirate-funnel)
- [AARRR Framework — Amplitude](https://amplitude.com/blog/pirate-metrics-framework)
- [Sean Ellis PMF Survey](https://pmfsurvey.com/)
- [Sean Ellis 40% Test — Pisano](https://www.pisano.com/en/academy/sean-ellis-test-figure-out-product-market-fit)
- [Superhuman PMF Framework — First Round Review](https://review.firstround.com/how-superhuman-built-an-engine-to-find-product-market-fit/)
- [Startup = Growth — Paul Graham](https://paulgraham.com/growth.html)
- [WoW Growth Rule — GitLab](https://about.gitlab.com/blog/wow-rule/)
- [SaaS Churn Benchmarks — Vitally](https://www.vitally.io/post/saas-churn-benchmarks)
- [SaaS Benchmarks Report — ChartMogul](https://chartmogul.com/reports/saas-benchmarks-report/)
- [B2B SaaS Retention Benchmarks — SaaS Capital](https://www.saas-capital.com/wp-content/uploads/2023/05/RB28WS1-2023-B2B-SaaS-Retention-Benchmarks.pdf)
- [Affiliate Marketing Conversion Benchmarks — OptiMonk](https://www.optimonk.com/affiliate-marketing-conversion-rate)
- [Affiliate Conversion Statistics — WeCanTrack](https://wecantrack.com/insights/affiliate-conversion-statistics/)
- [Startup KPIs by Stage — WaveUp](https://waveup.com/blog/key-performance-indicators-for-startups/)
- [YC Product-Market Fit — Y Combinator](https://www.ycombinator.com/library/5z-the-real-product-market-fit)
- [How to Measure Your Product — Y Combinator](https://www.ycombinator.com/library/8C-how-to-measure-your-product-sus-2018)
- [Growth for Startups — Y Combinator](https://www.ycombinator.com/library/6k-growth-for-startups)
