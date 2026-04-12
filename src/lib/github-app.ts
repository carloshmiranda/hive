/**
 * GitHub App authentication (RS256 JWT → installation token).
 *
 * Generates JWTs signed with the app's private key, exchanges them for
 * short-lived installation tokens, and caches them for 50 minutes
 * (tokens expire after 60 min).
 *
 * Falls back to getSettingValue("github_token") when app env vars
 * are not configured, allowing gradual migration.
 *
 * Env vars: GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_INSTALLATION_ID
 */

import { createSign } from "crypto";

// ---------------------------------------------------------------------------
// Token cache
// ---------------------------------------------------------------------------

let cachedToken: string | null = null;
let cachedTokenExpiresAt = 0;

const CACHE_DURATION_MS = 50 * 60 * 1000; // 50 minutes (tokens last 60)

// ---------------------------------------------------------------------------
// JWT generation (RS256, no external deps)
// ---------------------------------------------------------------------------

function base64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf.toString("base64url");
}

function createAppJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iat: now - 60, // 60s clock skew allowance
      exp: now + 10 * 60, // 10 min max for GitHub App JWTs
      iss: appId,
    })
  );

  const signable = `${header}.${payload}`;
  const sign = createSign("RSA-SHA256");
  sign.update(signable);
  sign.end();
  const signature = base64url(sign.sign(privateKey));

  return `${signable}.${signature}`;
}

// ---------------------------------------------------------------------------
// Installation token exchange
// ---------------------------------------------------------------------------

async function fetchInstallationToken(
  appId: string,
  privateKey: string,
  installationId: string
): Promise<string> {
  const jwt = createAppJwt(appId, privateKey);

  const endpoint = `https://api.github.com/app/installations/${installationId}/access_tokens`;
  const headers = {
    Authorization: `Bearer ${jwt}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };

  // Request issues:write explicitly so CEO can post escalation comments.
  // If the App installation doesn't have issues:write granted, GitHub returns
  // 422 — catch that and retry without explicit permissions (uses default scopes).
  let res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ permissions: { issues: "write", contents: "read" } }),
    signal: AbortSignal.timeout(10000),
  });

  if (res.status === 422) {
    console.warn(
      "[github-app] 422 requesting issues:write — App installation may lack the scope. Retrying without explicit permissions."
    );
    res = await fetch(endpoint, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(10000),
    });
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `GitHub App token exchange failed: ${res.status} — ${body}`
    );
  }

  const data = await res.json();
  if (!data.token) {
    throw new Error("GitHub App token exchange returned no token");
  }

  return data.token as string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns a GitHub token — either a cached/fresh GitHub App installation
 * token, or falls back to the PAT stored in settings.
 */
export async function getGitHubToken(): Promise<string | null> {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID;

  // If app env vars are configured, use GitHub App auth
  if (appId && privateKey && installationId) {
    // Return cached token if still valid
    if (cachedToken && Date.now() < cachedTokenExpiresAt) {
      return cachedToken;
    }

    try {
      // Private key may have literal \n from env vars — normalize
      const normalizedKey = privateKey.replace(/\\n/g, "\n");
      const token = await fetchInstallationToken(
        appId,
        normalizedKey,
        installationId
      );
      cachedToken = token;
      cachedTokenExpiresAt = Date.now() + CACHE_DURATION_MS;
      return token;
    } catch (err) {
      console.error(
        `[github-app] Token fetch failed, falling back to PAT: ${(err as Error).message}`
      );
      // Fall through to PAT fallback
    }
  }

  // Fallback: read PAT from settings DB (old path)
  try {
    const { getSettingValue } = await import("@/lib/settings");
    return await getSettingValue("github_token");
  } catch {
    return null;
  }
}
