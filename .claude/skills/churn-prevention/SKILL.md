---
name: churn-prevention
description: "When the user wants to reduce churn, build cancellation flows, set up save offers, recover failed payments, or implement retention strategies. Also use when the user mentions 'churn,' 'cancel flow,' 'offboarding,' 'save offer,' 'dunning,' 'failed payment recovery,' 'win-back,' 'retention,' 'exit survey,' 'pause subscription,' 'involuntary churn,' 'people keep canceling,' 'churn rate is too high,' 'how do I keep users,' or 'customers are leaving.' Use this whenever someone is losing subscribers or wants to build systems to prevent it. For post-cancel win-back email sequences, see email-sequence. For in-app upgrade paywalls, see paywall-upgrade-cro."
metadata:
  version: 1.1.0
---

# Churn Prevention

You are an expert in SaaS retention and churn prevention. Your goal is to help reduce both voluntary churn (customers choosing to cancel) and involuntary churn (failed payments) through well-designed cancel flows, dynamic save offers, proactive retention, and dunning strategies.

## Churn Types

| Type | Cause | Solution |
|------|-------|----------|
| **Voluntary** | Customer chooses to cancel | Cancel flows, save offers, exit surveys |
| **Involuntary** | Payment fails | Dunning emails, smart retries, card updaters |

Voluntary = 50-70% of total churn. Involuntary = 30-50% but easiest to fix.

## Cancel Flow Design

### The Structure
```
Trigger → Survey → Dynamic Offer → Confirmation → Post-Cancel
```

### Exit Survey Design
Key reason categories: Too expensive, Not using it enough, Missing a feature, Switching to competitor, Technical issues, Temporary/seasonal, Business closed, Other

Best practices: 1 question, single-select with optional free text, 5-8 options max, "Help us improve" framing

### Dynamic Save Offers (Match offer to reason)

| Cancel Reason | Primary Offer | Fallback Offer |
|---------------|---------------|----------------|
| Too expensive | Discount (20-30% for 2-3 months) | Downgrade to lower plan |
| Not using it enough | Pause (1-3 months) | Free onboarding session |
| Missing feature | Roadmap preview + timeline | Workaround guide |
| Switching to competitor | Competitive comparison + discount | Feedback session |
| Technical issues | Escalate to support immediately | Credit + priority fix |
| Temporary/seasonal | Pause subscription | Downgrade temporarily |
| Business closed | Skip offer | — |

**Offer types**: Discount (20-30% sweet spot, avoid 50%+), Pause (60-80% of pausers eventually return), Plan downgrade, Feature unlock, Personal outreach for high-value accounts

### Cancel Flow UI Principles
- Keep "continue cancelling" option visible (no dark patterns)
- One primary offer + one fallback
- Show specific dollar savings
- Mobile-friendly

## Churn Prediction & Proactive Retention

### Risk Signals
- Login frequency drops 50%+ → High risk (2-4 weeks before cancel)
- Key feature usage stops → High risk (1-3 weeks before cancel)
- Billing page visits increase → High risk (days before cancel)
- Data export initiated → Critical (days before cancel)
- NPS score drops below 6 → Medium risk (1-3 months before cancel)

### Health Score Model (0-100)
```
Health Score = (
  Login frequency score × 0.30 +
  Feature usage score   × 0.25 +
  Support sentiment     × 0.15 +
  Billing health        × 0.15 +
  Engagement score      × 0.15
)
```
80-100 = Healthy (upsell). 60-79 = Needs attention (check-in). 40-59 = At risk (intervention). 0-39 = Critical (personal outreach).

## Involuntary Churn: Dunning Stack

```
Pre-dunning → Smart retry → Dunning emails → Grace period → Hard cancel
```

**Pre-Dunning**: Card expiry alerts (30/15/7 days), backup payment method prompt, card updater services (reduce hard declines 30-50%), pre-billing notification for annual plans

**Smart Retry by decline type**:
- Soft decline (temporary): Retry 3-5 times over 7-10 days
- Hard decline (permanent): Don't retry — ask for new card
- Authentication required: Send customer to update payment

**Retry timing**: Day 1, Day 3, Day 5, Day 7 (with escalating dunning emails)

**Dunning Email Sequence**:

| Email | Timing | Tone | Content |
|-------|--------|------|---------|
| 1 | Day 0 | Friendly alert | Payment didn't go through. Update card. |
| 2 | Day 3 | Helpful reminder | Quick reminder — update to keep access. |
| 3 | Day 7 | Urgency | Account paused in 3 days. Update now. |
| 4 | Day 10 | Final warning | Last chance to keep account active. |

## Key Metrics

| Metric | Target |
|--------|--------|
| Monthly churn rate | <5% B2C, <2% B2B |
| Cancel flow save rate | 25-35% |
| Offer acceptance rate | 15-25% |
| Pause reactivation rate | 60-80% |
| Dunning recovery rate | 50-60% |

## Common Mistakes
- No cancel flow at all (even simple survey + one offer saves 10-15%)
- Same offer for every reason
- Discounts too deep (50%+ trains customers to cancel-and-return)
- Ignoring involuntary churn
- Guilt-trip copy ("Are you sure you want to abandon us?")
- Not tracking save offer LTV
- No post-cancel reactivation path

## Tool Integrations

**Retention Platforms**: Churnkey (34% avg save rate), ProsperStack, Raaft, Chargebee Retention

**Billing Providers**: Stripe (Smart Retries built-in), Chargebee, Paddle, Recurly, Braintree

## Related Skills
email-sequence, paywall-upgrade-cro, pricing-strategy, onboarding-cro, analytics-tracking, ab-test-setup
