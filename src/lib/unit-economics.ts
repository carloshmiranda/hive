/**
 * Unit Economics: LTV/CAC tracking per company
 *
 * Computes lifetime value, customer acquisition cost, LTV/CAC ratio,
 * and payback period from metrics data. Used by CEO context for
 * kill decisions and growth strategy.
 */

export interface UnitEconomicsInput {
  date: string;
  revenue: number;
  mrr: number;
  customers: number;
  churn_rate: number;
  cac: number;
  ad_spend: number;
  signups: number;
}

export interface UnitEconomicsResult {
  ltv: number | null;
  cac: number | null;
  ltv_cac_ratio: number | null;
  payback_months: number | null;
  arpu: number | null;
  monthly_churn_rate: number;
  avg_customer_lifetime_months: number | null;
  total_ad_spend: number;
  total_new_customers: number;
  health: 'excellent' | 'healthy' | 'warning' | 'critical' | 'insufficient_data';
  health_reason: string;
}

/**
 * Compute unit economics from a window of daily metrics.
 * Expects metrics ordered by date DESC (newest first).
 */
export function computeUnitEconomics(metrics: UnitEconomicsInput[]): UnitEconomicsResult {
  if (metrics.length < 7) {
    return insufficientData('Need at least 7 days of data');
  }

  const totalCustomers = Math.max(...metrics.map(m => m.customers));
  const latestMRR = metrics[0]?.mrr ?? 0;

  // ARPU: monthly revenue per customer
  const arpu = totalCustomers > 0 ? latestMRR / totalCustomers : null;

  // Monthly churn rate: average of daily churn rates * 30
  const churnDays = metrics.filter(m => m.churn_rate > 0);
  const avgDailyChurn = churnDays.length > 0
    ? churnDays.reduce((s, m) => s + m.churn_rate, 0) / churnDays.length
    : 0;
  const monthlyChurnRate = Math.min(avgDailyChurn * 30, 1); // Cap at 100%

  // Average customer lifetime in months: 1 / monthly_churn_rate
  const avgLifetimeMonths = monthlyChurnRate > 0 ? 1 / monthlyChurnRate : null;

  // LTV = ARPU * avg_lifetime_months
  const ltv = arpu !== null && avgLifetimeMonths !== null
    ? arpu * avgLifetimeMonths
    : null;

  // CAC: total ad_spend / total new customers in the period
  const totalAdSpend = metrics.reduce((s, m) => s + (m.ad_spend || 0), 0);
  const totalNewCustomers = metrics.reduce((s, m) => s + (m.signups || 0), 0);

  // If explicit CAC values exist, use the average of non-zero ones
  const explicitCACs = metrics.filter(m => m.cac > 0);
  const cac = explicitCACs.length > 0
    ? explicitCACs.reduce((s, m) => s + m.cac, 0) / explicitCACs.length
    : totalNewCustomers > 0 ? totalAdSpend / totalNewCustomers : null;

  // LTV/CAC ratio
  const ltvCacRatio = ltv !== null && cac !== null && cac > 0
    ? ltv / cac
    : null;

  // Payback period in months: CAC / ARPU
  const paybackMonths = cac !== null && arpu !== null && arpu > 0
    ? cac / arpu
    : null;

  // Health classification
  const { health, reason } = classifyHealth(ltvCacRatio, paybackMonths, ltv, cac);

  return {
    ltv: ltv !== null ? round2(ltv) : null,
    cac: cac !== null ? round2(cac) : null,
    ltv_cac_ratio: ltvCacRatio !== null ? round2(ltvCacRatio) : null,
    payback_months: paybackMonths !== null ? round2(paybackMonths) : null,
    arpu: arpu !== null ? round2(arpu) : null,
    monthly_churn_rate: round4(monthlyChurnRate),
    avg_customer_lifetime_months: avgLifetimeMonths !== null ? round2(avgLifetimeMonths) : null,
    total_ad_spend: round2(totalAdSpend),
    total_new_customers: totalNewCustomers,
    health,
    health_reason: reason,
  };
}

function classifyHealth(
  ratio: number | null,
  payback: number | null,
  ltv: number | null,
  cac: number | null,
): { health: UnitEconomicsResult['health']; reason: string } {
  // No paid acquisition yet — not enough data
  if (cac === null || cac === 0) {
    if (ltv !== null && ltv > 0) {
      return { health: 'insufficient_data', reason: 'LTV computed but no paid acquisition yet — CAC unknown' };
    }
    return { health: 'insufficient_data', reason: 'No paid acquisition data — unit economics not applicable yet' };
  }

  if (ratio === null) {
    return { health: 'insufficient_data', reason: 'Cannot compute LTV/CAC ratio — insufficient revenue or churn data' };
  }

  // Standard SaaS benchmarks
  if (ratio >= 5 && payback !== null && payback <= 6) {
    return { health: 'excellent', reason: `LTV/CAC ${ratio.toFixed(1)}x with ${payback.toFixed(0)}mo payback — strong unit economics` };
  }
  if (ratio >= 3) {
    return { health: 'healthy', reason: `LTV/CAC ${ratio.toFixed(1)}x — sustainable growth` };
  }
  if (ratio >= 1) {
    return { health: 'warning', reason: `LTV/CAC ${ratio.toFixed(1)}x — marginally profitable, optimize CAC or increase retention` };
  }
  return { health: 'critical', reason: `LTV/CAC ${ratio.toFixed(1)}x — losing money on each customer, reduce CAC or increase LTV` };
}

/**
 * Generate kill signal based on unit economics.
 * Returns a trigger string if LTV/CAC ratio is critically bad, null otherwise.
 */
export function checkUnitEconomicsKillTrigger(
  economics: UnitEconomicsResult,
  daysSinceCreation: number,
): string | null {
  // Only evaluate if we have enough data (paid acquisition active)
  if (economics.health === 'insufficient_data') return null;

  // Critical: LTV/CAC < 1 after 90+ days with paid acquisition
  if (economics.ltv_cac_ratio !== null && economics.ltv_cac_ratio < 1 && daysSinceCreation > 90) {
    return `NEGATIVE UNIT ECONOMICS: LTV/CAC ratio ${economics.ltv_cac_ratio.toFixed(1)}x after ${daysSinceCreation} days — losing money per customer`;
  }

  // Warning: Payback > 18 months after 60+ days
  if (economics.payback_months !== null && economics.payback_months > 18 && daysSinceCreation > 60) {
    return `EXCESSIVE PAYBACK PERIOD: ${economics.payback_months.toFixed(0)} months to recover CAC — unsustainable acquisition`;
  }

  return null;
}

/**
 * Generate human-readable summary for agent context.
 */
export function generateUnitEconomicsSummary(economics: UnitEconomicsResult): string {
  if (economics.health === 'insufficient_data') {
    return economics.health_reason;
  }

  const parts: string[] = [];
  if (economics.ltv !== null) parts.push(`LTV €${economics.ltv.toFixed(0)}`);
  if (economics.cac !== null) parts.push(`CAC €${economics.cac.toFixed(0)}`);
  if (economics.ltv_cac_ratio !== null) parts.push(`ratio ${economics.ltv_cac_ratio.toFixed(1)}x`);
  if (economics.payback_months !== null) parts.push(`payback ${economics.payback_months.toFixed(0)}mo`);
  if (economics.arpu !== null) parts.push(`ARPU €${economics.arpu.toFixed(0)}/mo`);

  return `Unit economics: ${parts.join(', ')} — ${economics.health_reason}`;
}

function insufficientData(reason: string): UnitEconomicsResult {
  return {
    ltv: null, cac: null, ltv_cac_ratio: null, payback_months: null,
    arpu: null, monthly_churn_rate: 0, avg_customer_lifetime_months: null,
    total_ad_spend: 0, total_new_customers: 0,
    health: 'insufficient_data', health_reason: reason,
  };
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
function round4(n: number): number { return Math.round(n * 10000) / 10000; }
