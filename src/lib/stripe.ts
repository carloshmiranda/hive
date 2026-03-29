import Stripe from "stripe";
import { StripeAgentToolkit } from "@stripe/agent-toolkit/ai-sdk";
import { getSettingValue } from "@/lib/settings";

let _stripe: Stripe | null = null;
let _stripeToolkit: StripeAgentToolkit | null = null;

async function getStripe(): Promise<Stripe> {
  if (_stripe) return _stripe;
  const key = await getSettingValue("stripe_secret_key");
  if (!key) throw new Error("Stripe secret key not configured. Add it in Hive Settings.");
  _stripe = new Stripe(key);
  return _stripe;
}

// Get Stripe Agent Toolkit with company-scoped restricted key if available
export async function getStripeToolkit(companySlug?: string): Promise<StripeAgentToolkit> {
  // Try company-specific restricted key first (for per-company security)
  let secretKey: string | null = null;
  if (companySlug) {
    secretKey = await getSettingValue(`stripe_restricted_key_${companySlug}`);
  }

  // Fallback to default restricted key, then main secret key
  if (!secretKey) {
    secretKey = await getSettingValue("stripe_restricted_key") ||
               await getSettingValue("stripe_secret_key");
  }

  if (!secretKey) {
    throw new Error("Stripe key not configured. Add stripe_secret_key or stripe_restricted_key in Hive Settings.");
  }

  // Always create a new toolkit instance to ensure fresh tool definitions
  const toolkit = new StripeAgentToolkit({
    secretKey,
    configuration: {
      context: companySlug ? { account: companySlug } : {}
    }
  });

  await toolkit.initialize();
  return toolkit;
}

// Get available Stripe agent tools as OpenAI-format tool definitions
export async function getStripeAgentTools(companySlug?: string): Promise<any[]> {
  try {
    const toolkit = await getStripeToolkit(companySlug);
    const tools = toolkit.getTools();

    // Convert from ai-sdk format to OpenAI function calling format
    return Object.entries(tools).map(([name, tool]) => ({
      type: "function",
      function: {
        name: name,
        description: tool.description || `Stripe ${name} tool`,
        parameters: tool.inputSchema || { type: "object", properties: {} }
      }
    }));
  } catch (error) {
    console.warn(`[stripe-agent] Failed to get tools: ${error}`);
    return [];
  }
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
