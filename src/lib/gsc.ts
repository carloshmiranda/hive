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

// JWT-based auth for service account
async function getGSCAccessToken(serviceAccount: {
  client_email: string;
  private_key: string;
  token_uri: string;
}): Promise<string | null> {
  try {
    const { createSign } = await import("crypto");

    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      iss: serviceAccount.client_email,
      scope: "https://www.googleapis.com/auth/webmasters.readonly",
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
