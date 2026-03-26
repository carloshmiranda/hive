/**
 * Week-over-Week (WoW) Growth Rate Calculations
 *
 * Provides growth rate calculations and benchmarks for the CEO context.
 * Formula: (this_week - last_week) / last_week
 */

export interface MetricData {
  date: string;
  page_views?: number;
  waitlist_signups?: number;
  mrr?: number;
  customers?: number;
}

export interface GrowthRate {
  metric: string;
  current_week: number;
  previous_week: number;
  growth_rate: number;
  benchmark: string;
  status: 'exceptional' | 'good' | 'ok' | 'stalling' | 'declining';
}

export interface GrowthBenchmark {
  exceptional: number; // >10%
  good: [number, number]; // 5-7%
  ok: [number, number]; // 1-5%
  stalling: number; // <1%
}

/**
 * Growth rate benchmarks based on YC standards
 */
const GROWTH_BENCHMARKS: GrowthBenchmark = {
  exceptional: 0.10,
  good: [0.05, 0.07],
  ok: [0.01, 0.05],
  stalling: 0.01,
};

/**
 * Calculate WoW growth rate for a specific metric
 */
function calculateGrowthRate(current: number, previous: number): number {
  if (previous === 0) {
    return current > 0 ? 1.0 : 0.0; // 100% growth if starting from 0, 0% if both are 0
  }
  return (current - previous) / previous;
}

/**
 * Classify growth rate against benchmarks
 */
function classifyGrowthRate(rate: number): {
  status: GrowthRate['status'];
  benchmark: string;
} {
  if (rate < 0) {
    return { status: 'declining', benchmark: 'declining (negative growth)' };
  } else if (rate < GROWTH_BENCHMARKS.stalling) {
    return { status: 'stalling', benchmark: '<1% (stalling)' };
  } else if (rate >= GROWTH_BENCHMARKS.ok[0] && rate < GROWTH_BENCHMARKS.ok[1]) {
    return { status: 'ok', benchmark: '1-5% (ok)' };
  } else if (rate >= GROWTH_BENCHMARKS.good[0] && rate <= GROWTH_BENCHMARKS.good[1]) {
    return { status: 'good', benchmark: '5-7% (good - YC benchmark)' };
  } else if (rate > GROWTH_BENCHMARKS.exceptional) {
    return { status: 'exceptional', benchmark: '>10% (exceptional)' };
  } else {
    return { status: 'ok', benchmark: '1-5% (ok)' };
  }
}

/**
 * Group metrics by week (Monday to Sunday)
 */
function groupMetricsByWeek(metrics: MetricData[]): Record<string, MetricData[]> {
  const weeks: Record<string, MetricData[]> = {};

  for (const metric of metrics) {
    const date = new Date(metric.date);
    // Get the Monday of the week (ISO week)
    const monday = new Date(date);
    const day = monday.getDay();
    const diff = monday.getDate() - day + (day === 0 ? -6 : 1); // Adjust for Sunday = 0
    monday.setDate(diff);

    const weekKey = monday.toISOString().split('T')[0];
    if (!weeks[weekKey]) {
      weeks[weekKey] = [];
    }
    weeks[weekKey].push(metric);
  }

  return weeks;
}

/**
 * Sum metrics for a week
 */
function sumWeeklyMetrics(weekData: MetricData[]): {
  page_views: number;
  waitlist_signups: number;
  mrr: number;
  customers: number;
} {
  return weekData.reduce(
    (sum, day) => ({
      page_views: sum.page_views + (day.page_views || 0),
      waitlist_signups: sum.waitlist_signups + (day.waitlist_signups || 0),
      mrr: Math.max(sum.mrr, day.mrr || 0), // MRR is latest value, not sum
      customers: Math.max(sum.customers, day.customers || 0), // Customers is latest value, not sum
    }),
    { page_views: 0, waitlist_signups: 0, mrr: 0, customers: 0 }
  );
}

/**
 * Calculate WoW growth rates for all key metrics
 *
 * @param metrics Array of daily metrics, ordered by date DESC (newest first)
 * @returns Growth rates for each metric with benchmarks
 */
export function calculateWoWGrowthRates(metrics: MetricData[]): GrowthRate[] {
  if (metrics.length < 7) {
    return []; // Need at least a week of data
  }

  // Group metrics by week
  const weeks = groupMetricsByWeek(metrics);
  const weekKeys = Object.keys(weeks).sort().reverse(); // Most recent first

  if (weekKeys.length < 2) {
    return []; // Need at least 2 weeks for comparison
  }

  const currentWeek = sumWeeklyMetrics(weeks[weekKeys[0]]);
  const previousWeek = sumWeeklyMetrics(weeks[weekKeys[1]]);

  const growthRates: GrowthRate[] = [];
  const metricsToTrack = ['page_views', 'waitlist_signups', 'mrr', 'customers'] as const;

  for (const metric of metricsToTrack) {
    const current = currentWeek[metric];
    const previous = previousWeek[metric];
    const rate = calculateGrowthRate(current, previous);
    const classification = classifyGrowthRate(rate);

    growthRates.push({
      metric,
      current_week: current,
      previous_week: previous,
      growth_rate: rate,
      benchmark: classification.benchmark,
      status: classification.status,
    });
  }

  return growthRates;
}

/**
 * Generate human-readable growth summary for CEO context
 */
export function generateGrowthSummary(growthRates: GrowthRate[]): string {
  if (growthRates.length === 0) {
    return "Insufficient data for WoW growth analysis (need 2+ weeks)";
  }

  const summaries = growthRates.map(gr => {
    const percentage = (gr.growth_rate * 100).toFixed(1);
    const direction = gr.growth_rate >= 0 ? "growing" : "declining";
    return `${gr.metric}: ${direction} ${percentage}% WoW (${gr.benchmark})`;
  });

  return summaries.join("; ");
}