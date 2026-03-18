import Stripe from "stripe";
import { headers } from "next/headers";
import { getDb } from "@/lib/db";
import { getSettingValue } from "@/lib/settings";

// This webhook runs on Vercel — no Claude, no AI, pure deterministic logic.
// It keeps Neon metrics fresh so the nightly loop has current data.

export async function POST(req: Request) {
  const body = await req.text();
  const headersList = await headers();
  const sig = headersList.get("stripe-signature");
  if (!sig) return Response.json({ error: "No signature" }, { status: 400 });

  const stripeKey = await getSettingValue("stripe_secret_key");
  if (!stripeKey) return Response.json({ error: "Stripe not configured" }, { status: 500 });

  const stripe = new Stripe(stripeKey);
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) return Response.json({ error: "Webhook secret not set" }, { status: 500 });

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret);
  } catch (err: any) {
    return Response.json({ error: `Webhook error: ${err.message}` }, { status: 400 });
  }

  const sql = getDb();
  const today = new Date().toISOString().split("T")[0];

  switch (event.type) {
    case "charge.succeeded": {
      const charge = event.data.object as Stripe.Charge;
      const companySlug = charge.metadata?.hive_company;
      if (!companySlug) break;

      // Find the company
      const [company] = await sql`SELECT id FROM companies WHERE slug = ${companySlug}`;
      if (!company) break;

      const amount = charge.amount / 100;

      // Upsert today's metrics — increment revenue
      await sql`
        INSERT INTO metrics (company_id, date, revenue)
        VALUES (${company.id}, ${today}, ${amount})
        ON CONFLICT (company_id, date) DO UPDATE SET
          revenue = metrics.revenue + ${amount}
      `;

      // Log the event for the activity feed
      await sql`
        INSERT INTO agent_actions (company_id, agent, action_type, description, status, started_at, finished_at)
        VALUES (${company.id}, 'ops', 'stripe_event', ${`Payment received: €${amount}`}, 'success', now(), now())
      `;

      // Check if this is the first-ever revenue for the company
      const [totalRevenue] = await sql`SELECT SUM(revenue) as total FROM metrics WHERE company_id = ${company.id}`;
      const [companyData] = await sql`SELECT status FROM companies WHERE id = ${company.id}`;

      if (companyData.status === "mvp" && Number(totalRevenue.total) > 0) {
        // First revenue — create approval gate for Vercel Pro upgrade
        await sql`
          INSERT INTO approvals (company_id, gate_type, title, description, context)
          VALUES (
            ${company.id}, 'spend_approval',
            ${`${companySlug}: First revenue — upgrade to Vercel Pro?`},
            ${`${companySlug} just received its first payment (€${amount}). It's generating revenue on Vercel Hobby which violates ToS. Recommend upgrading to Pro ($20/mo).`},
            ${JSON.stringify({ first_payment: amount, current_plan: "hobby", recommended: "pro" })}
          )
        `;
      }
      break;
    }

    case "customer.subscription.created": {
      const sub = event.data.object as Stripe.Subscription;
      const companySlug = sub.metadata?.hive_company;
      if (!companySlug) break;

      const [company] = await sql`SELECT id FROM companies WHERE slug = ${companySlug}`;
      if (!company) break;

      // Increment customer count
      await sql`
        INSERT INTO metrics (company_id, date, customers, signups)
        VALUES (${company.id}, ${today}, 1, 1)
        ON CONFLICT (company_id, date) DO UPDATE SET
          customers = metrics.customers + 1,
          signups = metrics.signups + 1
      `;

      // Calculate MRR from subscription amount
      const item = sub.items.data[0];
      const mrr = item?.price?.recurring?.interval === "year"
        ? (item.price.unit_amount || 0) / 1200
        : (item.price.unit_amount || 0) / 100;

      await sql`
        INSERT INTO metrics (company_id, date, mrr)
        VALUES (${company.id}, ${today}, ${mrr})
        ON CONFLICT (company_id, date) DO UPDATE SET
          mrr = metrics.mrr + ${mrr}
      `;

      await sql`
        INSERT INTO agent_actions (company_id, agent, action_type, description, status, started_at, finished_at)
        VALUES (${company.id}, 'ops', 'stripe_event', ${`New subscriber: +€${mrr.toFixed(2)}/mo MRR`}, 'success', now(), now())
      `;
      break;
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const companySlug = sub.metadata?.hive_company;
      if (!companySlug) break;

      const [company] = await sql`SELECT id FROM companies WHERE slug = ${companySlug}`;
      if (!company) break;

      const item = sub.items.data[0];
      const lostMrr = item?.price?.recurring?.interval === "year"
        ? (item.price.unit_amount || 0) / 1200
        : (item.price.unit_amount || 0) / 100;

      await sql`
        INSERT INTO metrics (company_id, date, mrr, customers)
        VALUES (${company.id}, ${today}, ${-lostMrr}, -1)
        ON CONFLICT (company_id, date) DO UPDATE SET
          mrr = metrics.mrr - ${lostMrr},
          customers = GREATEST(metrics.customers - 1, 0)
      `;

      await sql`
        INSERT INTO agent_actions (company_id, agent, action_type, description, status, started_at, finished_at)
        VALUES (${company.id}, 'ops', 'stripe_event', ${`Subscription cancelled: -€${lostMrr.toFixed(2)}/mo MRR`}, 'success', now(), now())
      `;
      break;
    }
  }

  return Response.json({ received: true });
}
