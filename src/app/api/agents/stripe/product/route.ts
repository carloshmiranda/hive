import { NextRequest } from "next/server";
import { validateOIDC } from "@/lib/oidc";
import { json, err } from "@/lib/db";
import { createProduct } from "@/lib/stripe";

// POST /api/agents/stripe/product — create Stripe product for a company via OIDC auth
// Body: { company_slug, name, price_eur, interval? }
export async function POST(req: NextRequest) {
  const claims = await validateOIDC(req);
  if (claims instanceof Response) return claims;

  let body;
  try {
    body = await req.json();
  } catch {
    return err("Invalid JSON body", 400);
  }

  const { company_slug, name, price_eur, interval } = body;
  if (!company_slug || !name || price_eur == null) {
    return err("Missing required fields: company_slug, name, price_eur", 400);
  }

  try {
    const result = await createProduct(
      company_slug,
      name,
      price_eur,
      interval || "month"
    );
    return json(result, 201);
  } catch (e) {
    return err(`Stripe error: ${e instanceof Error ? e.message : "unknown"}`, 500);
  }
}
