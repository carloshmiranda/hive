// Unit economics: LTV, CAC, and LTV/CAC ratio computation
// Used by CEO agent for kill decisions and by the dashboard for visibility

export interface UnitEconomicsInput {
  metrics: Array<{
    date: string;
    revenue: number;
    mrr: number;
    customers: number;
    churn_rate: number;
    cac: number;
    ad_spend: number;
    signups: number;
  }>;
  companyCreatedAt: string;
}

export interface CohortData {
  month: string; // YYYY-MM
  customers_acquired: number;
  cumulative_revenue: number;
  avg_revenue_per_customer: number;
  months_active: number;
}

export interface UnitEconomicsResult {
  // Core metrics
  ltv: number | null; // Lifetime value estimate (€)
  cac: number | null; // Customer acquisition cost (€)
  ltv_cac_ratio: number | null; // LTV / CAC
  arpu: number | null; // Average revenue per user per month (€)
  monthly_churn: number | null; // Average monthly churn rate (0-1)
  avg_customer_lifespan_months: number | null; // 1 / churn

  // Totals
  total_ad_spend: number;
  total_revenue: number;
  total_customers: number;

  // Cohort data (monthly)
  cohorts: CohortData[];

  // Health assessment
  health: 'excellent' | 'good' | 'warning' | 'critical' | 'insufficient_data';
  health_reason: string;

  // Kill signal
  kill_signal: boolean;
  kill_reason: string | null;
}

/**
 * Compute unit economics from metrics history.
 *
 * LTV = ARPU / monthly_churn_rate
 * CAC = total_ad_spend / total_new_customers (over the period)
 * LTV/CAC > 3 = healthy, < 1 = burning cash
 */
export function computeUnitEconomics(input: UnitEconomicsInput): UnitEconomicsResult {
  const { metrics, companyCreatedAt } = input;

  if (metrics.length === 0) {
    return emptyResult('insufficient_data', 'No metrics data available');
  }

  const sorted = [...metrics].sort((a, b) => a.date.localeCompare(b.date));

  // Total aggregates
  const totalRevenue = sorted.reduce((s, m) => s + (m.revenue || 0), 0);
  const totalAdSpend = sorted.reduce((s, m) => s + (m.ad_spend || 0), 0);
  const latestCustomers = sorted[sorted.length - 1]?.customers || 0;

  // Count new customers acquired (delta between consecutive days, only positive)
  let totalNewCustomers = 0;
  for (let i = 1; i < sorted.length; i++) {
    const delta = (sorted[i].customers || 0) - (sorted[i - 1].customers || 0);
    if (delta > 0) totalNewCustomers += delta;
  }
  // If first data point has customers, count those too
  if (sorted.length > 0 && (sorted[0].customers || 0) > 0) {
    totalNewCustomers = Math.max(totalNewCustomers, sorted[0].customers || 0);
  }

  // ARPU: average monthly revenue per customer
  // Group by month, compute avg revenue per customer
  const monthlyRevenue = groupByMonth(sorted, m => m.revenue || 0);
  const monthlyCustomers = groupByMonth(sorted, m => m.customers || 0);
  let arpu: number | null = null;
  const monthsWithCustomers = Object.keys(monthlyRevenue).filter(
    m => (monthlyCustomers[m] || 0) > 0
  );
  if (monthsWithCustomers.length > 0) {
    const totalMonthlyArpu = monthsWithCustomers.reduce((s, m) => {
      return s + monthlyRevenue[m] / monthlyCustomers[m];
    }, 0);
    arpu = totalMonthlyArpu / monthsWithCustomers.length;
  }

  // Monthly churn rate: average of non-zero churn entries
  const churnEntries = sorted.filter(m => (m.churn_rate || 0) > 0);
  const monthlyChurn = churnEntries.length > 0
    ? churnEntries.reduce((s, m) => s + m.churn_rate, 0) / churnEntries.length
    : null;

  // LTV = ARPU / churn_rate
  const ltv = arpu !== null && monthlyChurn !== null && monthlyChurn > 0
    ? arpu / monthlyChurn
    : null;

  // CAC: from ad_spend / new customers, or from recorded cac values
  let cac: number | null = null;
  const cacEntries = sorted.filter(m => (m.cac || 0) > 0);
  if (cacEntries.length > 0) {
    // Use recorded CAC values (average)
    cac = cacEntries.reduce((s, m) => s + m.cac, 0) / cacEntries.length;
  } else if (totalAdSpend > 0 && totalNewCustomers > 0) {
    // Derive from ad spend / new customers
    cac = totalAdSpend / totalNewCustomers;
  }

  // LTV/CAC ratio
  const ltvCacRatio = ltv !== null && cac !== null && cac > 0
    ? ltv / cac
    : null;

  // Average customer lifespan
  const avgLifespan = monthlyChurn !== null && monthlyChurn > 0
    ? 1 / monthlyChurn
    : null;

  // Build cohort data (monthly)
  const cohorts = buildCohorts(sorted);

  // Health assessment
  const { health, health_reason } = assessHealth(ltvCacRatio, ltv, cac, totalRevenue, latestCustomers, companyCreatedAt);

  // Kill signal: LTV/CAC < 1 for 3+ months with meaningful data
  const { kill_signal, kill_reason } = checkLtvCacKill(ltvCacRatio, totalAdSpend, totalRevenue, latestCustomers, companyCreatedAt);

  return {
    ltv: ltv !== null ? Math.round(ltv * 100) / 100 : null,
    cac: cac !== null ? Math.round(cac * 100) / 100 : null,
    ltv_cac_ratio: ltvCacRatio !== null ? Math.round(ltvCacRatio * 100) / 100 : null,
    arpu: arpu !== null ? Math.round(arpu * 100) / 100 : null,
    monthly_churn: monthlyChurn,
    avg_customer_lifespan_months: avgLifespan !== null ? Math.round(avgLifespan * 10) / 10 : null,
    total_ad_spend: totalAdSpend,
    total_revenue: totalRevenue,
    total_customers: latestCustomers,
    cohorts,
    health,
    health_reason,
    kill_signal,
    kill_reason,
  };
}

function groupByMonth(
  sorted: UnitEconomicsInput['metrics'],
  extract: (m: UnitEconomicsInput['metrics'][0]) => number
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const m of sorted) {
    const month = m.date.slice(0, 7); // YYYY-MM
    result[month] = (result[month] || 0) + extract(m);
  }
  return result;
}

function buildCohorts(sorted: UnitEconomicsInput['metrics']): CohortData[] {
  const months = new Map<string, { revenue: number; maxCustomers: number; minCustomers: number }>();

  for (const m of sorted) {
    const month = m.date.slice(0, 7);
    const existing = months.get(month);
    if (existing) {
      existing.revenue += m.revenue || 0;
      existing.maxCustomers = Math.max(existing.maxCustomers, m.customers || 0);
      existing.minCustomers = Math.min(existing.minCustomers, m.customers || 0);
    } else {
      months.set(month, {
        revenue: m.revenue || 0,
        maxCustomers: m.customers || 0,
        minCustomers: m.customers || 0,
      });
    }
  }

  const monthKeys = [...months.keys()].sort();
  let cumulativeRevenue = 0;

  return monthKeys.map((month, index) => {
    const data = months.get(month)!;
    // New customers = max customers this month - max customers previous month (approx)
    const prevMonth = index > 0 ? months.get(monthKeys[index - 1]) : null;
    const newCustomers = prevMonth
      ? Math.max(0, data.maxCustomers - prevMonth.maxCustomers)
      : data.maxCustomers;
    cumulativeRevenue += data.revenue;
    const avgRevPerCustomer = data.maxCustomers > 0
      ? data.revenue / data.maxCustomers
      : 0;

    return {
      month,
      customers_acquired: newCustomers,
      cumulative_revenue: Math.round(cumulativeRevenue * 100) / 100,
      avg_revenue_per_customer: Math.round(avgRevPerCustomer * 100) / 100,
      months_active: index + 1,
    };
  });
}

function assessHealth(
  ltvCacRatio: number | null,
  ltv: number | null,
  cac: number | null,
  totalRevenue: number,
  customers: number,
  companyCreatedAt: string,
): { health: UnitEconomicsResult['health']; health_reason: string } {
  const daysSinceCreation = Math.floor((Date.now() - new Date(companyCreatedAt).getTime()) / 86400000);

  // No revenue yet
  if (totalRevenue === 0 && customers === 0) {
    if (daysSinceCreation < 90) {
      return { health: 'insufficient_data', health_reason: 'Pre-revenue — unit economics not yet measurable' };
    }
    return { health: 'warning', health_reason: `No revenue after ${daysSinceCreation} days — need traction signals` };
  }

  // No paid acquisition yet
  if (cac === null) {
    return { health: 'insufficient_data', health_reason: 'No paid acquisition data — CAC not measurable (organic only)' };
  }

  // Have ratio
  if (ltvCacRatio !== null) {
    if (ltvCacRatio >= 3) return { health: 'excellent', health_reason: `LTV/CAC ${ltvCacRatio.toFixed(1)}x — strong unit economics` };
    if (ltvCacRatio >= 2) return { health: 'good', health_reason: `LTV/CAC ${ltvCacRatio.toFixed(1)}x — healthy but room to improve` };
    if (ltvCacRatio >= 1) return { health: 'warning', health_reason: `LTV/CAC ${ltvCacRatio.toFixed(1)}x — barely profitable per customer` };
    return { health: 'critical', health_reason: `LTV/CAC ${ltvCacRatio.toFixed(1)}x — losing money on each customer` };
  }

  // Have CAC but no LTV (no churn data)
  if (ltv === null && cac !== null) {
    return { health: 'warning', health_reason: `CAC is €${cac.toFixed(2)} but LTV unknown (need churn data)` };
  }

  return { health: 'insufficient_data', health_reason: 'Insufficient data for unit economics assessment' };
}

function checkLtvCacKill(
  ltvCacRatio: number | null,
  totalAdSpend: number,
  totalRevenue: number,
  customers: number,
  companyCreatedAt: string,
): { kill_signal: boolean; kill_reason: string | null } {
  const daysSinceCreation = Math.floor((Date.now() - new Date(companyCreatedAt).getTime()) / 86400000);

  // LTV/CAC < 1 with meaningful spend = burning cash
  if (ltvCacRatio !== null && ltvCacRatio < 1 && totalAdSpend > 50) {
    return {
      kill_signal: true,
      kill_reason: `LTV/CAC ratio ${ltvCacRatio.toFixed(2)}x with €${totalAdSpend.toFixed(0)} ad spend — losing money on each customer acquisition`,
    };
  }

  // High spend, no customers after 60 days
  if (totalAdSpend > 100 && customers === 0 && daysSinceCreation > 60) {
    return {
      kill_signal: true,
      kill_reason: `€${totalAdSpend.toFixed(0)} spent on acquisition with 0 customers after ${daysSinceCreation} days`,
    };
  }

  // High CAC relative to revenue (spending 3x what you earn)
  if (totalAdSpend > 0 && totalRevenue > 0 && totalAdSpend > totalRevenue * 3 && daysSinceCreation > 90) {
    return {
      kill_signal: true,
      kill_reason: `Ad spend (€${totalAdSpend.toFixed(0)}) is ${(totalAdSpend / totalRevenue).toFixed(1)}x total revenue (€${totalRevenue.toFixed(0)}) after ${daysSinceCreation} days`,
    };
  }

  return { kill_signal: false, kill_reason: null };
}

function emptyResult(
  health: UnitEconomicsResult['health'],
  reason: string,
): UnitEconomicsResult {
  return {
    ltv: null,
    cac: null,
    ltv_cac_ratio: null,
    arpu: null,
    monthly_churn: null,
    avg_customer_lifespan_months: null,
    total_ad_spend: 0,
    total_revenue: 0,
    total_customers: 0,
    cohorts: [],
    health,
    health_reason: reason,
    kill_signal: false,
    kill_reason: null,
  };
}
