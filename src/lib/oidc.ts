import { NextRequest } from "next/server";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { err } from "@/lib/db";

const GITHUB_JWKS_URL = "https://token.actions.githubusercontent.com/.well-known/jwks";
const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";
const EXPECTED_AUDIENCE =
  process.env.NEXT_PUBLIC_URL ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined) ||
  "https://hive-phi.vercel.app";
const EXPECTED_OWNER = "carloshmiranda";

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJWKS() {
  if (!jwks) jwks = createRemoteJWKSet(new URL(GITHUB_JWKS_URL));
  return jwks;
}

/**
 * Validate GitHub Actions OIDC token from Authorization header.
 * Returns JWT claims on success, or a Response (error) on failure.
 */
export async function validateOIDC(req: NextRequest): Promise<Record<string, unknown> | Response> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return err("Missing Authorization header", 401);
  }
  try {
    const result = await jwtVerify(authHeader.slice(7), getJWKS(), {
      issuer: GITHUB_ISSUER,
      audience: EXPECTED_AUDIENCE,
    });
    const claims = result.payload as Record<string, unknown>;
    if (claims.repository_owner !== EXPECTED_OWNER) {
      return err("Repository owner not authorized", 403);
    }
    return claims;
  } catch (e) {
    return err(`OIDC validation failed: ${e instanceof Error ? e.message : "unknown"}`, 401);
  }
}
