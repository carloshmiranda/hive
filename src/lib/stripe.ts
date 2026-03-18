import Stripe from "stripe";
import { getSettingValue } from "@/lib/settings";

let _stripe: Stripe | null = null;

async function getStripe(): Promise<Stripe> {
  if (_stripe) return _stripe;
  const key = await getSettingValue("stripe_secret_key");
  if (!key) throw new Error("Stripe secret key not configured. Add it in Hive Settings.");
  _stripe = new Stripe(key);
  return _stripe;
}

// Create product + price tagged to a company (single Stripe account)
export async function createProduct(companySlug: string, name: string, priceEur: number, interval: "month" | "year" | "once" = "month") {
  const stripe = await getStripe();
  const product = await stripe.products.create({ name, metadata: { hive_company: companySlug } });

  const params: Stripe.PriceCreateParams = {
    product: product.id,
    unit_amount: Math.round(priceEur * 100),
    currency: "eur",
    metadata: { hive_company: companySlug },
  };
  if (interval !== "once") params.recurring = { interval };

  const price = await stripe.prices.create(params);
  return { productId: product.id, priceId: price.id };
}

// Revenue for one company (filter charges by metadata)
export async function getCompanyRevenue(companySlug: string, days = 30) {
  const stripe = await getStripe();
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const charges = await stripe.charges.list({ created: { gte: since }, limit: 100 });
  const matched = charges.data.filter(c => c.status === "succeeded" && c.metadata?.hive_company === companySlug);
  return { revenue: matched.reduce((s, c) => s + c.amount, 0) / 100, transactions: matched.length };
}

// Portfolio revenue grouped by company
export async function getPortfolioRevenue(days = 30) {
  const stripe = await getStripe();
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const charges = await stripe.charges.list({ created: { gte: since }, limit: 100 });
  const ok = charges.data.filter(c => c.status === "succeeded");
  const byCompany: Record<string, number> = {};
  for (const c of ok) {
    const slug = c.metadata?.hive_company || "untagged";
    byCompany[slug] = (byCompany[slug] || 0) + c.amount / 100;
  }
  return { total: ok.reduce((s, c) => s + c.amount, 0) / 100, byCompany };
}

// MRR for one company
export async function getCompanyMRR(companySlug: string) {
  const stripe = await getStripe();
  const subs = await stripe.subscriptions.search({
    query: `metadata["hive_company"]:"${companySlug}" AND status:"active"`, limit: 100,
  });
  const mrr = subs.data.reduce((s, sub) => {
    const amt = sub.items.data[0]?.price?.unit_amount || 0;
    const monthly = sub.items.data[0]?.price?.recurring?.interval === "year" ? amt / 12 : amt;
    return s + monthly;
  }, 0);
  return { mrr: mrr / 100, subscriptions: subs.data.length };
}

// Deactivate all products for a killed company
export async function deactivateCompanyProducts(companySlug: string) {
  const stripe = await getStripe();
  const products = await stripe.products.search({ query: `metadata["hive_company"]:"${companySlug}"` });
  for (const p of products.data) await stripe.products.update(p.id, { active: false });
  return { deactivated: products.data.length };
}
