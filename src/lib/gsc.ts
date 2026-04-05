import { getSettingValue } from "./settings";

// GSC API client — pulls keyword performance data
// Auth: Service account JSON key stored as google_search_console_key setting
// Free: 25,000 rows/day

interface GSCRow {
  keys: string[];    // [query, page] when dimensions are query+page
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

interface GSCResponse {
  rows?: GSCRow[];
}

export async function getGSCPerformance(siteUrl: string, days: number = 7): Promise<GSCRow[]> {
  const keyJson = await getSettingValue("google_search_console_key");
  if (!keyJson) return [];

  try {
    const key = JSON.parse(keyJson);
    const token = await getGSCAccessToken(key);
    if (!token) return [];

    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(endDate.getDate() - days);

    const res = await fetch(
      `https://searchconsole.googleapis.com/v1/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          startDate: startDate.toISOString().split("T")[0],
          endDate: endDate.toISOString().split("T")[0],
          dimensions: ["query", "page"],
          rowLimit: 1000,
          startRow: 0,
        }),
      }
    );

    if (!res.ok) {
      console.error(`GSC API error: ${res.status} ${await res.text()}`);
      return [];
    }

    const data: GSCResponse = await res.json();
    return data.rows || [];
  } catch (e: any) {
    console.error(`GSC client error: ${e.message}`);
    return [];
  }
}

// Generic JWT helper — issues access token for any set of Google OAuth2 scopes
async function getAccessTokenWithScopes(
  serviceAccount: { client_email: string; private_key: string; token_uri: string },
  scopes: string[]
): Promise<string | null> {
  try {
    const { createSign } = await import("crypto");

    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      iss: serviceAccount.client_email,
      scope: scopes.join(" "),
      aud: serviceAccount.token_uri || "https://oauth2.googleapis.com/token",
      exp: now + 3600,
      iat: now,
    })).toString("base64url");

    const sign = createSign("RSA-SHA256");
    sign.update(`${header}.${payload}`);
    const signature = sign.sign(serviceAccount.private_key, "base64url");

    const jwt = `${header}.${payload}.${signature}`;

    const tokenRes = await fetch(serviceAccount.token_uri || "https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
    });

    if (!tokenRes.ok) return null;
    const tokenData = await tokenRes.json();
    return tokenData.access_token || null;
  } catch {
    return null;
  }
}

// JWT-based auth for service account (readonly GSC scope — preserved for backwards compat)
async function getGSCAccessToken(serviceAccount: {
  client_email: string;
  private_key: string;
  token_uri: string;
}): Promise<string | null> {
  return getAccessTokenWithScopes(serviceAccount, [
    "https://www.googleapis.com/auth/webmasters.readonly",
  ]);
}

// Helper: load the GSC service account key from settings
async function loadServiceAccount(): Promise<{ client_email: string; private_key: string; token_uri: string } | null> {
  const keyJson = await getSettingValue("google_search_console_key");
  if (!keyJson) return null;
  try {
    return JSON.parse(keyJson);
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------
// Site Verification API helpers
// -------------------------------------------------------------------

/**
 * Get the META tag token needed to verify a site with Google.
 * Returns the full verification token string (e.g. "google-site-verification=ABC123") or null.
 */
export async function getSiteVerificationToken(siteUrl: string): Promise<string | null> {
  const sa = await loadServiceAccount();
  if (!sa) return null;

  const token = await getAccessTokenWithScopes(sa, [
    "https://www.googleapis.com/auth/siteverification",
  ]);
  if (!token) return null;

  try {
    const res = await fetch(
      `https://www.googleapis.com/siteVerification/v1/token?verificationMethod=META&identifier=${encodeURIComponent(siteUrl)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!res.ok) {
      console.error(`[gsc] getSiteVerificationToken error: ${res.status} ${await res.text()}`);
      return null;
    }
    const data = await res.json();
    return (data.token as string) || null;
  } catch (e: any) {
    console.error(`[gsc] getSiteVerificationToken exception: ${e.message}`);
    return null;
  }
}

/**
 * Submit verification to Google after the META tag has been deployed.
 * Returns true on 2xx (site verified), false otherwise.
 */
export async function verifySiteWithGoogle(siteUrl: string): Promise<boolean> {
  const sa = await loadServiceAccount();
  if (!sa) return false;

  const token = await getAccessTokenWithScopes(sa, [
    "https://www.googleapis.com/auth/siteverification",
  ]);
  if (!token) return false;

  try {
    const res = await fetch(
      `https://www.googleapis.com/siteVerification/v1/webResource?verificationMethod=META`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          site: { type: "SITE", identifier: siteUrl },
          owners: [],
        }),
      }
    );
    if (!res.ok) {
      console.error(`[gsc] verifySiteWithGoogle error: ${res.status} ${await res.text()}`);
      return false;
    }
    return true;
  } catch (e: any) {
    console.error(`[gsc] verifySiteWithGoogle exception: ${e.message}`);
    return false;
  }
}

/**
 * Add a verified site to Search Console as a property.
 * Must call verifySiteWithGoogle first — a 403 means the service account is not yet an owner.
 * Returns true on 2xx, false otherwise.
 */
export async function addPropertyToSearchConsole(siteUrl: string): Promise<boolean> {
  const sa = await loadServiceAccount();
  if (!sa) return false;

  const token = await getAccessTokenWithScopes(sa, [
    "https://www.googleapis.com/auth/webmasters",
  ]);
  if (!token) return false;

  try {
    const res = await fetch(
      `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    if (!res.ok) {
      console.error(`[gsc] addPropertyToSearchConsole error: ${res.status} ${await res.text()}`);
      return false;
    }
    return true;
  } catch (e: any) {
    console.error(`[gsc] addPropertyToSearchConsole exception: ${e.message}`);
    return false;
  }
}

/**
 * List all GSC properties the service account can access.
 * Returns an array of siteUrl strings.
 */
export async function getGSCPropertyList(): Promise<string[]> {
  const sa = await loadServiceAccount();
  if (!sa) return [];

  const token = await getAccessTokenWithScopes(sa, [
    "https://www.googleapis.com/auth/webmasters.readonly",
  ]);
  if (!token) return [];

  try {
    const res = await fetch("https://www.googleapis.com/webmasters/v3/sites", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      console.error(`[gsc] getGSCPropertyList error: ${res.status} ${await res.text()}`);
      return [];
    }
    const data = await res.json();
    const entries: Array<{ siteUrl: string }> = data.siteEntry || [];
    return entries.map((e) => e.siteUrl);
  } catch (e: any) {
    console.error(`[gsc] getGSCPropertyList exception: ${e.message}`);
    return [];
  }
}

// Helper: get top keywords by impressions (for LLM citation checks)
export function getTopKeywords(rows: GSCRow[], limit: number = 10): string[] {
  return rows
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, limit)
    .map(r => r.keys[0]);
}

// Helper: find "striking distance" keywords (position 4-10, high impressions)
export function getStrikingDistanceKeywords(rows: GSCRow[]): GSCRow[] {
  return rows
    .filter(r => r.position >= 4 && r.position <= 10 && r.impressions >= 10)
    .sort((a, b) => b.impressions - a.impressions);
}

// Helper: find pages with high impressions but low CTR
export function getLowCTRPages(rows: GSCRow[], minImpressions: number = 50): GSCRow[] {
  return rows
    .filter(r => r.impressions >= minImpressions && r.ctr < 0.03)
    .sort((a, b) => b.impressions - a.impressions);
}
