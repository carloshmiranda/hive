/**
 * Cached metrics utilities for Hive.
 *
 * Reduces Neon CU consumption by caching company metrics in Redis
 * with 6h TTL, aligned with the metrics collection schedule.
 */

import { cachedCompanyMetrics } from "./redis-cache";
import type { MetricsRow } from "./validation";

/**
 * Get cached metrics for a company (last 14 days).
 * Falls back to direct DB query if cache miss.
 */
export async function getCachedCompanyMetrics(
  sql: any,
  companyId: string,
  companySlug: string
): Promise<MetricsRow[]> {
  return cachedCompanyMetrics(companySlug, async () => {
    const metrics = await sql`
      SELECT date, page_views, signups, waitlist_signups, waitlist_total,
        revenue, mrr, customers, churn_rate, cac, ad_spend,
        pricing_page_views, pricing_cta_clicks,
        affiliate_clicks, affiliate_revenue
      FROM metrics WHERE company_id = ${companyId}
      ORDER BY date DESC LIMIT 14
    `.catch(() => []);

    // Transform null values to match validation MetricsRow interface
    return metrics.map((m: any): MetricsRow => ({
      date: m.date,
      page_views: m.page_views || 0,
      signups: m.signups || 0,
      waitlist_signups: m.waitlist_signups || 0,
      waitlist_total: m.waitlist_total || 0,
      revenue: m.revenue || 0,
      mrr: m.mrr || 0,
      customers: m.customers || 0,
      churn_rate: parseFloat(m.churn_rate) || 0,
      cac: parseFloat(m.cac) || 0,
      ad_spend: parseFloat(m.ad_spend) || 0,
      pricing_page_views: m.pricing_page_views || 0,
      pricing_cta_clicks: m.pricing_cta_clicks || 0,
      affiliate_clicks: m.affiliate_clicks || 0,
      affiliate_revenue: m.affiliate_revenue || 0,
    }));
  });
}

/**
 * Get cached growth metrics for a company (last 14 days with 7-day filter).
 * Used by Growth context which needs recent data only.
 * Uses a separate cache key since it's a different query.
 */
export async function getCachedGrowthMetrics(
  sql: any,
  companyId: string,
  companySlug: string
): Promise<MetricsRow[]> {
  return cachedCompanyMetrics(`${companySlug}:growth`, async () => {
    const metrics = await sql`
      SELECT date, mrr, customers, page_views, signups, waitlist_total, waitlist_signups,
        churn_rate, cac, ad_spend
      FROM metrics WHERE company_id = ${companyId}
        AND date >= CURRENT_DATE - INTERVAL '7 days'
      ORDER BY date DESC LIMIT 14
    `.catch(() => []);

    // Transform null values to match validation MetricsRow interface
    return metrics.map((m: any): MetricsRow => ({
      date: m.date,
      page_views: m.page_views || 0,
      signups: m.signups || 0,
      waitlist_signups: m.waitlist_signups || 0,
      waitlist_total: m.waitlist_total || 0,
      revenue: m.revenue || 0,
      mrr: m.mrr || 0,
      customers: m.customers || 0,
      churn_rate: parseFloat(m.churn_rate) || 0,
      cac: parseFloat(m.cac) || 0,
      ad_spend: parseFloat(m.ad_spend) || 0,
      pricing_page_views: m.pricing_page_views || 0,
      pricing_cta_clicks: m.pricing_cta_clicks || 0,
      affiliate_clicks: m.affiliate_clicks || 0,
      affiliate_revenue: m.affiliate_revenue || 0,
    }));
  });
}