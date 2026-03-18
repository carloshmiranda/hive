import Stripe from "stripe";
import { headers } from "next/headers";
import { getDb } from "@/lib/db";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export async function POST(req: Request) {
  const body = await req.text();
  const headersList = await headers();
  const sig = headersList.get("stripe-signature");

  if (!sig) return Response.json({ error: "No signature" }, { status: 400 });

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch (err: any) {
    return Response.json({ error: `Webhook error: ${err.message}` }, { status: 400 });
  }

  const sql = getDb();

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.customer_email) {
        await sql`
          INSERT INTO customers (email, stripe_customer_id, status, created_at)
          VALUES (${session.customer_email}, ${session.customer as string}, 'active', now())
          ON CONFLICT (email) DO UPDATE SET stripe_customer_id = EXCLUDED.stripe_customer_id, status = 'active'
        `;
      }
      break;
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      await sql`
        UPDATE customers SET status = 'churned' WHERE stripe_customer_id = ${sub.customer as string}
      `;
      break;
    }
  }

  return Response.json({ received: true });
}
