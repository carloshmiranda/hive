import { getSettingValue } from "./settings";
import { getDb } from "./db";

// === X (TWITTER) API v2 ===
// Free tier: 1,500 posts/month, read-only for tweets
// Requires: X API Bearer Token (for app-level) or OAuth 1.0a (for user-level posting)

interface PostResult {
  success: boolean;
  post_id?: string;
  platform: string;
  error?: string;
}

async function postToX(text: string, companyId: string): Promise<PostResult> {
  const sql = getDb();

  // Get the company's X account credentials
  const [account] = await sql`
    SELECT * FROM social_accounts 
    WHERE company_id = ${companyId} AND platform = 'x' AND status = 'active'
    LIMIT 1
  `;

  if (!account) {
    return { success: false, platform: "x", error: "No active X account for this company" };
  }

  // X API v2 requires OAuth 1.0a for posting on behalf of a user
  // The auth_token stores a JSON blob: { api_key, api_secret, access_token, access_token_secret }
  let creds: { api_key: string; api_secret: string; access_token: string; access_token_secret: string };
  try {
    creds = JSON.parse(account.auth_token);
  } catch {
    return { success: false, platform: "x", error: "Invalid credentials format in social_accounts" };
  }

  // Build OAuth 1.0a signature
  const url = "https://api.twitter.com/2/tweets";
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = Math.random().toString(36).substring(2, 15);

  const params: Record<string, string> = {
    oauth_consumer_key: creds.api_key,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_token: creds.access_token,
    oauth_version: "1.0",
  };

  // Create signature base string
  const sortedParams = Object.entries(params).sort(([a], [b]) => a.localeCompare(b));
  const paramString = sortedParams.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  const baseString = `POST&${encodeURIComponent(url)}&${encodeURIComponent(paramString)}`;
  const signingKey = `${encodeURIComponent(creds.api_secret)}&${encodeURIComponent(creds.access_token_secret)}`;

  const crypto = require("crypto");
  const signature = crypto.createHmac("sha1", signingKey).update(baseString).digest("base64");
  params.oauth_signature = signature;

  const authHeader = "OAuth " + Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}="${encodeURIComponent(v)}"`)
    .join(", ");

  try {
    // Truncate to X's character limit (280 chars)
    const truncated = text.length > 280 ? text.slice(0, 277) + "..." : text;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text: truncated }),
    });

    const data = await res.json();

    if (!res.ok) {
      return { success: false, platform: "x", error: data.detail || data.title || `HTTP ${res.status}` };
    }

    return { success: true, platform: "x", post_id: data.data?.id };
  } catch (e: any) {
    return { success: false, platform: "x", error: e.message };
  }
}

// === UNIFIED POSTING INTERFACE ===

export async function postToSocial(
  platform: string,
  text: string,
  companyId: string,
): Promise<PostResult> {
  switch (platform) {
    case "x":
      return postToX(text, companyId);
    // Future: linkedin, instagram, etc.
    default:
      return { success: false, platform, error: `Platform "${platform}" not yet supported` };
  }
}

export async function getCompanySocialAccounts(companyId: string) {
  const sql = getDb();
  return sql`
    SELECT id, platform, account_handle, status, created_at
    FROM social_accounts 
    WHERE company_id = ${companyId}
    ORDER BY platform ASC
  `;
}

export async function proposeSocialAccount(companyId: string, platform: string): Promise<void> {
  const sql = getDb();

  // Check if an account already exists or is pending
  const [existing] = await sql`
    SELECT id FROM social_accounts 
    WHERE company_id = ${companyId} AND platform = ${platform}
    LIMIT 1
  `;
  if (existing) return; // Already exists

  // Create a pending account and an approval gate
  const [company] = await sql`SELECT name, slug FROM companies WHERE id = ${companyId}`;

  await sql`
    INSERT INTO social_accounts (company_id, platform, status)
    VALUES (${companyId}, ${platform}, 'pending')
  `;

  await sql`
    INSERT INTO approvals (company_id, gate_type, title, description, context)
    VALUES (
      ${companyId},
      'social_account',
      ${`Create ${platform} account for ${company?.name || companyId}`},
      ${`The Growth agent wants to start posting on ${platform} for ${company?.name}.\n\n` +
        `Manual steps required:\n` +
        `1. Go to ${platform === "x" ? "developer.twitter.com" : platform + ".com"} and create the account\n` +
        `2. Set up API credentials (OAuth tokens)\n` +
        `3. Update the social_accounts table with the handle and encrypted auth_token\n` +
        `4. Set status to 'active'\n\n` +
        `The auth_token format for X: {"api_key":"...","api_secret":"...","access_token":"...","access_token_secret":"..."}`},
      ${JSON.stringify({ platform, company_slug: company?.slug })}
    )
  `;
}
