// Validation-gated build system
// Computes a validation score (0-100) and current phase per business type
// Used by CEO agent to decide what work is appropriate each cycle

export type BusinessType = 'saas' | 'blog' | 'affiliate_site' | 'newsletter' | 'marketplace' | 'digital_product' | 'faceless_channel' | 'api_service';

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
}

// Legacy company_type → business type mapping
const TYPE_MAP: Record<string, BusinessType> = {
  b2c_saas: 'saas',
  b2b_saas: 'saas',
  api_service: 'api_service',
  blog: 'blog',
  affiliate_site: 'affiliate_site',
  newsletter: 'newsletter',
  marketplace: 'marketplace',
  digital_product: 'digital_product',
  faceless_channel: 'faceless_channel',
};

export function normalizeBusinessType(raw: string | null): BusinessType {
  if (!raw) return 'saas';
  return TYPE_MAP[raw] || (raw as BusinessType) || 'saas';
}

// ─── Phase definitions per business type ───

const PHASES: Record<BusinessType, { name: string; threshold: number }[]> = {
  saas: [
    { name: 'validate', threshold: 0 },
    { name: 'test_intent', threshold: 25 },
    { name: 'build_mvp', threshold: 50 },
    { name: 'build_aggressively', threshold: 75 },
    { name: 'scale', threshold: 90 },
  ],
  blog: [
    { name: 'seed_content', threshold: 0 },
    { name: 'seo_growth', threshold: 25 },
    { name: 'monetize', threshold: 50 },
    { name: 'scale', threshold: 75 },
  ],
  affiliate_site: [
    { name: 'build_directory', threshold: 0 },
    { name: 'drive_traffic', threshold: 25 },
    { name: 'optimize_conversions', threshold: 50 },
    { name: 'scale', threshold: 75 },
  ],
  newsletter: [
    { name: 'seed_content', threshold: 0 },
    { name: 'grow_subscribers', threshold: 25 },
    { name: 'monetize', threshold: 50 },
    { name: 'scale', threshold: 75 },
  ],
  marketplace: [
    { name: 'validate', threshold: 0 },
    { name: 'build_supply', threshold: 25 },
    { name: 'build_demand', threshold: 50 },
    { name: 'scale', threshold: 75 },
  ],
  digital_product: [
    { name: 'validate', threshold: 0 },
    { name: 'test_intent', threshold: 25 },
    { name: 'build_product', threshold: 50 },
    { name: 'scale', threshold: 75 },
  ],
  faceless_channel: [
    { name: 'seed_content', threshold: 0 },
    { name: 'grow_audience', threshold: 25 },
    { name: 'monetize', threshold: 50 },
    { name: 'scale', threshold: 75 },
  ],
  api_service: [
    { name: 'validate', threshold: 0 },
    { name: 'test_intent', threshold: 25 },
    { name: 'build_mvp', threshold: 50 },
    { name: 'scale', threshold: 75 },
  ],
};

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

// ─── Main function ───

export function computeValidationScore(
  rawType: string | null,
  metrics: MetricsRow[],
  companyCreatedAt: string = new Date().toISOString(),
): ValidationResult {
  const type = normalizeBusinessType(rawType);
  const phases = PHASES[type] || PHASES.saas;

  // Score by business type
  let breakdown: Record<string, number>;
  switch (type) {
    case 'blog':
    case 'newsletter':
    case 'faceless_channel':
      breakdown = scoreBlog(metrics);
      break;
    case 'affiliate_site':
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
  };
}
