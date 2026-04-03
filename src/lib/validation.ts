// Validation-gated build system
// Computes a validation score (0-100) and current phase per business type
// Used by CEO agent to decide what work is appropriate each cycle

import { normalizeType, getTypeDefinition } from "./business-types";
import { computeUnitEconomics } from "./unit-economics";

// Re-export for backwards compatibility
export type BusinessType = string;
export const normalizeBusinessType = normalizeType;

export interface MetricsRow {
  date: string;
  page_views: number;
  signups?: number;
  waitlist_signups?: number;
  waitlist_total?: number;
  revenue?: number;
  mrr?: number;
  customers?: number;
  pricing_cta_clicks?: number;
  pricing_page_views?: number;
  affiliate_clicks?: number;
  affiliate_revenue?: number;
  churn_rate?: number;
  cac?: number;
  ad_spend?: number;
}

export interface ValidationResult {
  score: number;
  phase: string;
  phase_index: number;
  next_phase: string | null;
  phases: string[];
  score_breakdown: Record<string, number>;
  gating_rules: string[];
  forbidden: string[];
  kill_signal: boolean;
  kill_reason: string | null;
  kill_evaluation_triggers: string[];
  // Venture-studio recommendation: CEO uses this as primary disposition signal
  recommendation: "double_down" | "continue" | "pivot_evaluate" | "kill_evaluate" | "kill";
  recommendation_reason: string;
  revenue_readiness_score: number;
  revenue_readiness_message: string | null;
  unit_economics: {
    ltv: number | null;
    cac: number | null;
    ltv_cac_ratio: number | null;
    health: string;
    health_reason: string;
  } | null;
}

// ─── Phase-specific rules ───

const PHASE_RULES: Record<string, { gating: string[]; forbidden: string[] }> = {
  // SaaS
  validate: {
    gating: [
      'Only plan: landing page improvements, waitlist mechanics, SEO content, free tools',
      'Growth: content to drive waitlist signups, organic discovery',
      'Max 1 engineering task (landing page or tool), rest is growth',
    ],
    forbidden: [
      'Product features (auth, dashboards, user management, CRUD)',
      'Database schema for product data',
      'Login/register pages or links on landing page',
      'Stripe checkout integration',
    ],
  },
  test_intent: {
    gating: [
      'Add fake-door pricing page that tracks clicks (pricing_intent)',
      'A/B test pricing copy and tiers',
      'Continue SEO content and waitlist growth',
    ],
    forbidden: [
      'Building the actual product behind the paywall',
      'Auth system or user accounts',
      'Complex backend features',
    ],
  },
  build_mvp: {
    gating: [
      'Build core value flow only (the ONE thing users pay for)',
      'Max 2 engineering tasks per cycle',
      'Set up Stripe checkout for the core offering',
    ],
    forbidden: [
      'Nice-to-have features (settings, profiles, export)',
      'More than 2 engineering tasks per cycle',
    ],
  },
  build_aggressively: {
    gating: [
      'Full feature set, onboarding, retention hooks',
      'Growth: conversion optimization, email sequences',
    ],
    forbidden: [],
  },
  // Blog / Newsletter / Faceless channel
  seed_content: {
    gating: [
      'Publish articles/content — this IS the product',
      'SEO scaffolding (sitemap, meta tags, structured data)',
      'Engineering: only blog infrastructure and content templates',
    ],
    forbidden: [
      'Monetization setup (ads, affiliate links, sponsorship pages)',
      'Paid traffic or outreach',
    ],
  },
  seo_growth: {
    gating: [
      'More content targeting validated keywords',
      'Internal linking, schema markup, performance optimization',
      'Social distribution and backlink outreach',
    ],
    forbidden: [
      'Adding ads until 1,000+ monthly page views',
    ],
  },
  grow_subscribers: {
    gating: [
      'Email capture optimization, lead magnets',
      'Content quality and consistency',
      'Social media presence for subscriber growth',
    ],
    forbidden: [
      'Paid newsletter or sponsorship deals until 500+ subscribers',
    ],
  },
  grow_audience: {
    gating: [
      'Content publishing schedule',
      'Platform algorithm optimization',
      'Cross-platform distribution',
    ],
    forbidden: [
      'Monetization until 1,000+ followers/subscribers',
    ],
  },
  // Affiliate
  build_directory: {
    gating: [
      'Listing pages with comparison tables',
      'Affiliate link tracking infrastructure',
      'SEO-optimized category pages',
    ],
    forbidden: [
      'Paid traffic (no point until directory has content)',
      'Outreach to partners',
    ],
  },
  drive_traffic: {
    gating: [
      'SEO content for each listing category',
      'Review articles and comparison guides',
      'Organic distribution',
    ],
    forbidden: [],
  },
  optimize_conversions: {
    gating: [
      'Improve affiliate CTR with better CTAs',
      'A/B test listing layouts',
      'Add reviews and trust signals',
    ],
    forbidden: [],
  },
  // Marketplace
  build_supply: {
    gating: [
      'Onboard supply side (sellers, providers)',
      'Build listing/inventory management',
    ],
    forbidden: [
      'Demand-side marketing before supply exists',
    ],
  },
  build_demand: {
    gating: [
      'Drive buyers/consumers to marketplace',
      'Search and discovery features',
    ],
    forbidden: [],
  },
  build_product: {
    gating: [
      'Core product features based on validated demand',
      'Distribution and delivery mechanism',
    ],
    forbidden: [],
  },
  // Shared
  monetize: {
    gating: [
      'Add revenue streams appropriate to the business type',
      'Track revenue metrics closely',
    ],
    forbidden: [],
  },
  scale: {
    gating: [
      'Growth optimization, expand what works',
      'Revenue optimization (RPM, LTV, expansion revenue)',
    ],
    forbidden: [],
  },
};

// ─── Scoring functions per business type ───

function computeWoWGrowth(metrics: MetricsRow[]): number {
  if (metrics.length < 7) return 0;
  const sorted = [...metrics].sort((a, b) => b.date.localeCompare(a.date));
  const thisWeek = sorted.slice(0, 7).reduce((s, m) => s + m.page_views, 0);
  const lastWeek = sorted.slice(7, 14).reduce((s, m) => s + m.page_views, 0);
  if (lastWeek === 0) return thisWeek > 0 ? 0.5 : 0;
  return (thisWeek - lastWeek) / lastWeek;
}

// Revenue Readiness Score (0-100) - signals when to add payment flows
function computeRevenueReadinessScore(metrics: MetricsRow[]): { score: number; message: string | null } {
  const latest = metrics[0] || {} as MetricsRow;

  // Pricing page visits (weight 30, >50 visits = full score)
  const totalPricingViews = metrics.reduce((s, m) => s + (m.pricing_page_views || 0), 0);
  const pricingScore = Math.min(30, (totalPricingViews / 50) * 30);

  // Return visitor rate (weight 25, >30% = full) - placeholder (data not available)
  // TODO: Add return_visitor_rate to metrics schema
  const returnVisitorScore = 0;

  // Waitlist size (weight 20, >100 = full)
  const waitlistSize = latest.waitlist_total || 0;
  const waitlistScore = Math.min(20, (waitlistSize / 100) * 20);

  // Time on site average (weight 15, >2min = full) - placeholder (data not available)
  // TODO: Add time_on_site_avg to metrics schema
  const timeOnSiteScore = 0;

  // Organic traffic growth (weight 10, >5% WoW = full)
  const wowGrowth = computeWoWGrowth(metrics);
  const organicGrowthScore = Math.min(10, Math.max(0, (wowGrowth / 0.05) * 10));

  const score = Math.round(pricingScore + returnVisitorScore + waitlistScore + timeOnSiteScore + organicGrowthScore);

  let message: string | null = null;
  if (score >= 60) {
    message = "Revenue ready — prioritize Stripe integration and pricing optimization.";
  } else if (score < 30) {
    message = "Too early for monetization — focus on traffic and validation.";
  }

  return { score, message };
}

function scoreSaas(metrics: MetricsRow[]): Record<string, number> {
  const latest = metrics[0] || {} as MetricsRow;
  const totalViews = metrics.reduce((s, m) => s + m.page_views, 0);
  const totalSignups = latest.waitlist_total || 0;
  const conversionRate = totalViews > 0 ? totalSignups / totalViews : 0;
  const wowGrowth = computeWoWGrowth(metrics);
  const pricingClicks = metrics.reduce((s, m) => s + (m.pricing_cta_clicks || 0), 0);
  const pricingViews = metrics.reduce((s, m) => s + (m.pricing_page_views || 0), 0);
  const pricingCTR = pricingViews > 0 ? pricingClicks / pricingViews : 0;
  const hasRevenue = (latest.revenue || 0) > 0 || (latest.mrr || 0) > 0;
  const hasCustomers = (latest.customers || 0) > 0;

  return {
    // Waitlist volume (0-25): 25 signups for PT niche = full marks
    waitlist: Math.min(25, totalSignups),
    // Conversion rate (0-25): 10%+ = full marks
    conversion: Math.min(25, conversionRate * 250),
    // WoW growth (0-20): 10%+ weekly growth = full marks
    wow_growth: Math.min(20, Math.max(0, wowGrowth * 200)),
    // Payment intent (0-15): pricing page CTR > 2% = full marks
    payment_intent: Math.min(15, pricingCTR * 750),
    // Revenue override (0-15): any revenue = instant 15 points
    revenue: hasRevenue ? 15 : (hasCustomers ? 10 : 0),
  };
}

function scoreBlog(metrics: MetricsRow[]): Record<string, number> {
  const totalViews = metrics.reduce((s, m) => s + m.page_views, 0);
  const avgDailyViews = metrics.length > 0 ? totalViews / metrics.length : 0;
  const monthlyEstimate = avgDailyViews * 30;
  const wowGrowth = computeWoWGrowth(metrics);
  const hasRevenue = metrics.some(m => (m.revenue || 0) > 0);

  return {
    // Traffic volume (0-35): 5K monthly views = full marks
    traffic: Math.min(35, (monthlyEstimate / 5000) * 35),
    // Traffic growth (0-25): 10% WoW = full marks
    traffic_growth: Math.min(25, Math.max(0, wowGrowth * 250)),
    // Content velocity — proxy via views consistency (0-20)
    consistency: Math.min(20, (metrics.filter(m => m.page_views > 0).length / Math.max(metrics.length, 1)) * 20),
    // Revenue (0-20): any revenue = 20 points
    revenue: hasRevenue ? 20 : 0,
  };
}

function scoreAffiliate(metrics: MetricsRow[]): Record<string, number> {
  const totalViews = metrics.reduce((s, m) => s + m.page_views, 0);
  const avgDailyViews = metrics.length > 0 ? totalViews / metrics.length : 0;
  const monthlyEstimate = avgDailyViews * 30;
  const totalClicks = metrics.reduce((s, m) => s + (m.affiliate_clicks || 0), 0);
  const affiliateCTR = totalViews > 0 ? totalClicks / totalViews : 0;
  const totalAffRevenue = metrics.reduce((s, m) => s + (m.affiliate_revenue || 0), 0);
  const wowGrowth = computeWoWGrowth(metrics);

  return {
    // Traffic (0-30): 3K monthly = full marks
    traffic: Math.min(30, (monthlyEstimate / 3000) * 30),
    // Traffic growth (0-20)
    traffic_growth: Math.min(20, Math.max(0, wowGrowth * 200)),
    // Affiliate CTR (0-25): 5% = full marks
    affiliate_ctr: Math.min(25, affiliateCTR * 500),
    // Revenue (0-25): any affiliate revenue = 25
    revenue: totalAffRevenue > 0 ? 25 : 0,
  };
}

// ─── Kill criteria (organic-patient) ───

interface KillCheck {
  signal: boolean;
  reason: string;
}

interface KillEvaluationTriggers {
  triggers: string[];
}

// Check benchmark-based kill evaluation triggers (force CEO evaluation, not automatic kill)
function checkKillEvaluationTriggers(type: BusinessType, metrics: MetricsRow[], companyCreatedAt: string, revenueReadinessScore: number): KillEvaluationTriggers {
  const triggers: string[] = [];
  const daysSinceCreation = Math.floor((Date.now() - new Date(companyCreatedAt).getTime()) / 86400000);
  const totalViews = metrics.reduce((s, m) => s + m.page_views, 0);
  const latest = metrics[0] || {} as MetricsRow;
  const hasRevenue = (latest.revenue || 0) > 0 || (latest.mrr || 0) > 0;

  // Skip all triggers if company has revenue
  if (hasRevenue) return { triggers };

  // 1. Zero organic traffic after 60 days of content = kill
  if (daysSinceCreation > 60 && totalViews === 0) {
    triggers.push(`ZERO ORGANIC TRAFFIC: ${daysSinceCreation} days with 0 page views — content not getting discovered`);
  }

  // 2. <10 waitlist signups after 90 days = kill (SaaS only)
  if (type === 'saas' && daysSinceCreation > 90) {
    const signups = latest.waitlist_total || 0;
    if (signups < 10) {
      triggers.push(`LOW WAITLIST CONVERSION: Only ${signups} signups after ${daysSinceCreation} days — insufficient market interest`);
    }
  }

  // 4. WoW growth negative for 6+ consecutive weeks = kill evaluation
  const negativeGrowthWeeks = countConsecutiveNegativeGrowthWeeks(metrics);
  if (negativeGrowthWeeks >= 6) {
    triggers.push(`SUSTAINED DECLINE: ${negativeGrowthWeeks} consecutive weeks of negative growth — systematic issue`);
  }

  // 4b. <5% WoW for 8+ consecutive weeks = stall signal (venture studio benchmark)
  const flatGrowthWeeks = countConsecutiveFlatGrowthWeeks(metrics, 0.05);
  if (flatGrowthWeeks >= 8) {
    triggers.push(`STALLED: ${flatGrowthWeeks} consecutive weeks below 5% WoW growth — channel or positioning not working`);
  }

  // 5. Revenue readiness score <20 after 120 days = kill evaluation
  if (daysSinceCreation > 120 && revenueReadinessScore < 20) {
    triggers.push(`LOW MONETIZATION READINESS: Score ${revenueReadinessScore}/100 after ${daysSinceCreation} days — poor fundamentals`);
  }

  // 6. LTV/CAC ratio kill signal — losing money on acquisition
  const hasAdSpend = metrics.some(m => (m.ad_spend || 0) > 0 || (m.cac || 0) > 0);
  if (hasAdSpend) {
    const econ = computeUnitEconomics({
      metrics: metrics.map(m => ({
        date: m.date,
        revenue: m.revenue || 0,
        mrr: m.mrr || 0,
        customers: m.customers || 0,
        churn_rate: m.churn_rate || 0,
        cac: m.cac || 0,
        ad_spend: m.ad_spend || 0,
        signups: m.signups || 0,
      })),
      companyCreatedAt,
    });
    if (econ.kill_signal && econ.kill_reason) {
      triggers.push(`UNIT ECONOMICS: ${econ.kill_reason}`);
    }
  }

  return { triggers };
}

// Count consecutive weeks of negative WoW growth
function countConsecutiveNegativeGrowthWeeks(metrics: MetricsRow[]): number {
  if (metrics.length < 14) return 0;

  const sorted = [...metrics].sort((a, b) => b.date.localeCompare(a.date));
  let consecutiveWeeks = 0;

  for (let i = 0; i < sorted.length - 7; i += 7) {
    const thisWeek = sorted.slice(i, i + 7).reduce((s, m) => s + m.page_views, 0);
    const lastWeek = sorted.slice(i + 7, i + 14).reduce((s, m) => s + m.page_views, 0);
    if (lastWeek > 0 && thisWeek < lastWeek) {
      consecutiveWeeks++;
    } else {
      break;
    }
  }

  return consecutiveWeeks;
}

// Count consecutive weeks of flat/low WoW growth (< threshold)
// Venture studio benchmark: <5% for 8+ weeks = stalled, pivot evaluate
function countConsecutiveFlatGrowthWeeks(metrics: MetricsRow[], threshold = 0.05): number {
  if (metrics.length < 14) return 0;

  const sorted = [...metrics].sort((a, b) => b.date.localeCompare(a.date));
  let flatWeeks = 0;

  for (let i = 0; i < sorted.length - 7; i += 7) {
    const thisWeek = sorted.slice(i, i + 7).reduce((s, m) => s + m.page_views, 0);
    const lastWeek = sorted.slice(i + 7, i + 14).reduce((s, m) => s + m.page_views, 0);
    if (lastWeek === 0) break; // No baseline to compare
    const wowRate = (thisWeek - lastWeek) / lastWeek;
    if (wowRate < threshold) {
      flatWeeks++;
    } else {
      break;
    }
  }

  return flatWeeks;
}

// Compute venture-studio disposition recommendation
// Based on Alloy Innovation / Founders Factory RAYG system + YC benchmarks
function computeRecommendation(
  type: BusinessType,
  metrics: MetricsRow[],
  companyCreatedAt: string,
  killSignal: boolean,
  killEvaluationTriggers: string[],
  revenueReadinessScore: number,
): { recommendation: ValidationResult["recommendation"]; reason: string } {
  const latest = metrics[0] || {} as MetricsRow;
  const hasRevenue = (latest.revenue || 0) > 0 || (latest.mrr || 0) > 0;
  const wowGrowth = computeWoWGrowth(metrics);
  const flatWeeks = countConsecutiveFlatGrowthWeeks(metrics, 0.05);
  const daysSinceCreation = Math.floor((Date.now() - new Date(companyCreatedAt).getTime()) / 86400000);

  // Hard kill — automatic, no CEO deliberation needed
  if (killSignal) {
    return { recommendation: "kill", reason: "Hard kill criteria met — validation thresholds exhausted" };
  }

  // Double down: all signals strongly positive (YC 7%+ WoW + revenue growing)
  const revenueGrowing = metrics.length >= 2 &&
    (metrics[0]?.revenue || 0) > (metrics[1]?.revenue || 0);
  if (hasRevenue && wowGrowth >= 0.07 && revenueGrowing && revenueReadinessScore >= 60) {
    return { recommendation: "double_down", reason: `WoW growth ${(wowGrowth * 100).toFixed(1)}%, revenue growing — strong PMF signal, double resources` };
  }

  // Kill evaluate: multiple triggers or sustained flat growth
  if (killEvaluationTriggers.length >= 2) {
    return { recommendation: "kill_evaluate", reason: `${killEvaluationTriggers.length} kill evaluation triggers active — CEO should evaluate kill` };
  }

  // Pivot evaluate: <5% WoW for 8+ weeks without revenue (venture studio stall benchmark)
  if (flatWeeks >= 8 && !hasRevenue) {
    return { recommendation: "pivot_evaluate", reason: `${flatWeeks} consecutive weeks <5% WoW growth with no revenue — channel or positioning pivot required` };
  }

  // Kill evaluate: single strong trigger
  if (killEvaluationTriggers.length === 1) {
    return { recommendation: "kill_evaluate", reason: killEvaluationTriggers[0] };
  }

  // Continue: moderate growth or early stage
  if (wowGrowth >= 0.03 || daysSinceCreation < 30 || hasRevenue) {
    const reason = hasRevenue
      ? "Revenue present — continue and optimize"
      : wowGrowth >= 0.03
        ? `WoW growth ${(wowGrowth * 100).toFixed(1)}% — on track, maintain pace`
        : "Early stage — insufficient data for kill evaluation";
    return { recommendation: "continue", reason };
  }

  // Default: continue unless signals say otherwise
  return { recommendation: "continue", reason: "No kill signals — continue current approach" };
}

function checkKillSignals(type: BusinessType, metrics: MetricsRow[], companyCreatedAt: string): KillCheck {
  const daysSinceCreation = Math.floor((Date.now() - new Date(companyCreatedAt).getTime()) / 86400000);
  const totalViews = metrics.reduce((s, m) => s + m.page_views, 0);
  const latest = metrics[0] || {} as MetricsRow;
  const hasRevenue = (latest.revenue || 0) > 0 || (latest.mrr || 0) > 0;
  const wowGrowth = computeWoWGrowth(metrics);

  // Revenue = infinite patience
  if (hasRevenue) return { signal: false, reason: '' };

  if (type === 'saas') {
    const signups = latest.waitlist_total || 0;
    if (daysSinceCreation > 60 && signups < 5 && totalViews < 500)
      return { signal: true, reason: `60+ days, only ${signups} signups and ${totalViews} views — no traction` };
    if (daysSinceCreation > 120 && signups < 25 && wowGrowth <= 0)
      return { signal: true, reason: `120+ days, ${signups} signups, zero WoW growth — stalled` };
    if (daysSinceCreation > 180 && signups < 50)
      return { signal: true, reason: `180+ days, only ${signups} signups, no payment intent — strong kill candidate` };
  }

  if (type === 'blog' || type === 'newsletter' || type === 'faceless_channel') {
    const monthlyViews = (totalViews / Math.max(metrics.length, 1)) * 30;
    if (daysSinceCreation > 60 && totalViews < 500)
      return { signal: true, reason: `60+ days, only ${totalViews} total views — content not getting discovered` };
    if (daysSinceCreation > 120 && monthlyViews < 2000 && wowGrowth <= 0)
      return { signal: true, reason: `120+ days, ~${Math.round(monthlyViews)} monthly views, no growth — stalled` };
    if (daysSinceCreation > 180 && monthlyViews < 5000)
      return { signal: true, reason: `180+ days, ~${Math.round(monthlyViews)} monthly views — insufficient for monetization` };
  }

  if (type === 'affiliate_site') {
    const affRevenue = metrics.reduce((s, m) => s + (m.affiliate_revenue || 0), 0);
    if (daysSinceCreation > 60 && totalViews < 200)
      return { signal: true, reason: `60+ days, only ${totalViews} views — directory not getting discovered` };
    if (daysSinceCreation > 120 && totalViews < 1000)
      return { signal: true, reason: `120+ days, only ${totalViews} views — insufficient traffic` };
    if (daysSinceCreation > 180 && affRevenue === 0)
      return { signal: true, reason: '180+ days, zero affiliate revenue — strong kill candidate' };
  }

  return { signal: false, reason: '' };
}

// ─── CEO Score Kill Evaluation (requires cycles data) ───

export function checkCEOScoreKillTrigger(recentCycles: Array<{ cycle_number: number; score: string }>): string | null {
  if (recentCycles.length < 3) return null;

  // Check for 3 consecutive CEO scores <4/10
  const lowScores = recentCycles
    .sort((a, b) => b.cycle_number - a.cycle_number) // Most recent first
    .slice(0, 3) // Get last 3 cycles
    .map(c => {
      const score = parseFloat(c.score);
      return isNaN(score) ? 10 : score; // Default to 10 if parse fails
    });

  if (lowScores.length === 3 && lowScores.every(score => score < 4)) {
    return `CEO PERFORMANCE CRISIS: 3 consecutive scores <4/10 (${lowScores.join(', ')}) — fundamental execution failure`;
  }

  return null;
}

export function checkLearningRateKillTrigger(
  recentCycles: Array<{ cycle_number: number; score: string }>
): string | null {
  if (recentCycles.length < 4) return null;

  const sorted = [...recentCycles]
    .sort((a, b) => b.cycle_number - a.cycle_number)
    .slice(0, 6);

  const scores = sorted
    .map(c => { const s = parseFloat(c.score); return isNaN(s) ? null : s; })
    .filter((s): s is number => s !== null);

  if (scores.length < 4) return null;

  const avg = scores.reduce((sum, v) => sum + v, 0) / scores.length;
  const range = Math.max(...scores) - Math.min(...scores);

  if (avg < 6 && range < 1.5) {
    return `LEARNING RATE STAGNANT: ${scores.length} cycles with CEO scores ${scores.map(s => s.toFixed(1)).join('→')} (avg ${avg.toFixed(1)}/10, no improvement detected)`;
  }

  return null;
}

// ─── Main function ───

export function computeValidationScore(
  rawType: string | null,
  metrics: MetricsRow[],
  companyCreatedAt: string = new Date().toISOString(),
): ValidationResult {
  const type = normalizeType(rawType);
  const typeDef = getTypeDefinition(type);
  const phases = typeDef.phases;

  // Score by business type's scoring model
  let breakdown: Record<string, number>;
  switch (typeDef.scoringModel) {
    case 'content':
      breakdown = scoreBlog(metrics);
      break;
    case 'affiliate':
      breakdown = scoreAffiliate(metrics);
      break;
    default:
      breakdown = scoreSaas(metrics);
  }

  const score = Math.min(100, Math.round(Object.values(breakdown).reduce((s, v) => s + v, 0)));

  // Determine phase
  let phaseIndex = 0;
  for (let i = phases.length - 1; i >= 0; i--) {
    if (score >= phases[i].threshold) {
      phaseIndex = i;
      break;
    }
  }

  const phase = phases[phaseIndex].name;
  const nextPhase = phaseIndex < phases.length - 1 ? phases[phaseIndex + 1].name : null;
  const rules = PHASE_RULES[phase] || { gating: [], forbidden: [] };

  // Kill signals
  const kill = checkKillSignals(type, metrics, companyCreatedAt);

  // Revenue readiness score
  const revenueReadiness = computeRevenueReadinessScore(metrics);

  // Kill evaluation triggers (benchmark-based)
  const killEvaluationTriggers = checkKillEvaluationTriggers(type, metrics, companyCreatedAt, revenueReadiness.score);

  // Venture-studio recommendation
  const { recommendation, reason: recommendationReason } = computeRecommendation(
    type, metrics, companyCreatedAt, kill.signal, killEvaluationTriggers.triggers, revenueReadiness.score,
  );

  // Unit economics (only compute when ad spend or CAC data exists)
  const hasAcquisitionData = metrics.some(m => (m.ad_spend || 0) > 0 || (m.cac || 0) > 0);
  const unitEcon = hasAcquisitionData ? computeUnitEconomics({
    metrics: metrics.map(m => ({
      date: m.date,
      revenue: m.revenue || 0,
      mrr: m.mrr || 0,
      customers: m.customers || 0,
      churn_rate: m.churn_rate || 0,
      cac: m.cac || 0,
      ad_spend: m.ad_spend || 0,
      signups: m.signups || 0,
    })),
    companyCreatedAt,
  }) : null;

  return {
    score,
    phase,
    phase_index: phaseIndex,
    next_phase: nextPhase,
    phases: phases.map(p => p.name),
    score_breakdown: breakdown,
    gating_rules: rules.gating,
    forbidden: rules.forbidden,
    kill_signal: kill.signal,
    kill_reason: kill.reason,
    kill_evaluation_triggers: killEvaluationTriggers.triggers,
    recommendation,
    recommendation_reason: recommendationReason,
    revenue_readiness_score: revenueReadiness.score,
    revenue_readiness_message: revenueReadiness.message,
    unit_economics: unitEcon ? {
      ltv: unitEcon.ltv,
      cac: unitEcon.cac,
      ltv_cac_ratio: unitEcon.ltv_cac_ratio,
      health: unitEcon.health,
      health_reason: unitEcon.health_reason,
    } : null,
  };
}
