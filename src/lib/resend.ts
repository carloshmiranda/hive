import { getSettingValue } from "./settings";
import { render } from "@react-email/render";
import DigestEmail from "../emails/DigestEmail";
import WelcomeEmail from "../emails/WelcomeEmail";
import ReceiptEmail from "../emails/ReceiptEmail";
import PasswordResetEmail from "../emails/PasswordResetEmail";
import type { DigestData, WelcomeEmailData, ReceiptEmailData, PasswordResetEmailData } from "../emails/types";

interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  from?: string;
  replyTo?: string;
}

// === EMAIL SENDING MODES ===
// 1. No domain verified + no resend key → emails silently skipped (logged)
// 2. No domain verified + resend key → "onboarding@resend.dev" for digest to Carlos only
// 3. Verified domain → "CompanyName <type@mail.yourdomain.com>" for all emails
//
// The `sending_domain` setting controls this. Set it in /settings after verifying in Resend.
// Example: if you verified "mail.hivehq.io", set sending_domain = "mail.hivehq.io"

async function getSendingDomain(): Promise<string | null> {
  return getSettingValue("sending_domain");
}

/**
 * Build a from address for a given email type.
 * - If sending_domain is set: "Label <type@sending_domain>"
 * - If not: "Onboarding <onboarding@resend.dev>" (test mode, only reaches Carlos)
 */
export async function buildFromAddress(opts: {
  type: "digest" | "outreach" | "transactional";
  companyName?: string;
}): Promise<{ from: string; testMode: boolean }> {
  const domain = await getSendingDomain();

  if (!domain) {
    // Test mode — only onboarding@resend.dev works, only sends to account owner email
    return { from: "Hive <onboarding@resend.dev>", testMode: true };
  }

  // Verified domain mode — real sending
  switch (opts.type) {
    case "digest":
      return { from: `Hive <digest@${domain}>`, testMode: false };
    case "outreach":
      return { from: `${opts.companyName || "Hive"} <outreach@${domain}>`, testMode: false };
    case "transactional":
      return { from: `${opts.companyName || "Hive"} <hello@${domain}>`, testMode: false };
    default:
      return { from: `Hive <noreply@${domain}>`, testMode: false };
  }
}

export async function sendEmail(opts: EmailOptions): Promise<{ success: boolean; id?: string; error?: string; testMode?: boolean }> {
  const apiKey = await getSettingValue("resend_api_key");
  if (!apiKey) return { success: false, error: "Resend API key not configured" };

  // If no explicit "from", build one in test mode
  const fromAddress = opts.from || (await buildFromAddress({ type: "digest" })).from;

  try {
    const body: Record<string, unknown> = {
      from: fromAddress,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
    };
    if (opts.replyTo) body.replyTo = opts.replyTo;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) return { success: false, error: data.message || `HTTP ${res.status}` };
    return { success: true, id: data.id };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

/**
 * Check if outreach emails can actually be sent (verified domain required).
 * Cold outreach from onboarding@resend.dev will get rejected or spam-filtered.
 */
export async function canSendOutreach(): Promise<boolean> {
  const domain = await getSendingDomain();
  const apiKey = await getSettingValue("resend_api_key");
  return !!(domain && apiKey);
}

// === RESEND AUDIENCES & CONTACTS API ===

interface ResendAudience {
  id: string;
  name: string;
  created_at: string;
  object: "audience";
}

interface ResendContact {
  id: string;
  email: string;
  first_name?: string;
  last_name?: string;
  unsubscribed: boolean;
  audience_id: string;
  created_at: string;
  object: "contact";
}

interface CreateAudienceOptions {
  name: string;
}

interface CreateContactOptions {
  email: string;
  firstName?: string;
  lastName?: string;
  unsubscribed?: boolean;
  audienceId: string;
}

/**
 * Create a new audience in Resend for a company
 */
export async function createAudience(options: CreateAudienceOptions): Promise<{ success: boolean; audience?: ResendAudience; error?: string }> {
  const apiKey = await getSettingValue("resend_api_key");
  if (!apiKey) return { success: false, error: "Resend API key not configured" };

  try {
    const res = await fetch("https://api.resend.com/audiences", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: options.name }),
    });

    const data = await res.json();
    if (!res.ok) return { success: false, error: data.message || `HTTP ${res.status}` };

    return { success: true, audience: data };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

/**
 * List all audiences
 */
export async function listAudiences(): Promise<{ success: boolean; audiences?: ResendAudience[]; error?: string }> {
  const apiKey = await getSettingValue("resend_api_key");
  if (!apiKey) return { success: false, error: "Resend API key not configured" };

  try {
    const res = await fetch("https://api.resend.com/audiences", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    const data = await res.json();
    if (!res.ok) return { success: false, error: data.message || `HTTP ${res.status}` };

    return { success: true, audiences: data.data };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

/**
 * Add a contact to an audience
 */
export async function addContact(options: CreateContactOptions): Promise<{ success: boolean; contact?: ResendContact; error?: string }> {
  const apiKey = await getSettingValue("resend_api_key");
  if (!apiKey) return { success: false, error: "Resend API key not configured" };

  try {
    const body: Record<string, unknown> = {
      email: options.email,
      unsubscribed: options.unsubscribed || false,
    };

    if (options.firstName) body.first_name = options.firstName;
    if (options.lastName) body.last_name = options.lastName;

    const res = await fetch(`https://api.resend.com/audiences/${options.audienceId}/contacts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await res.json();
    if (!res.ok) return { success: false, error: data.message || `HTTP ${res.status}` };

    return { success: true, contact: data };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

/**
 * Update contact subscription status
 */
export async function updateContactSubscription(audienceId: string, contactId: string, unsubscribed: boolean): Promise<{ success: boolean; error?: string }> {
  const apiKey = await getSettingValue("resend_api_key");
  if (!apiKey) return { success: false, error: "Resend API key not configured" };

  try {
    const res = await fetch(`https://api.resend.com/audiences/${audienceId}/contacts/${contactId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ unsubscribed }),
    });

    const data = await res.json();
    if (!res.ok) return { success: false, error: data.message || `HTTP ${res.status}` };

    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

/**
 * List contacts in an audience
 */
export async function listContacts(audienceId: string): Promise<{ success: boolean; contacts?: ResendContact[]; error?: string }> {
  const apiKey = await getSettingValue("resend_api_key");
  if (!apiKey) return { success: false, error: "Resend API key not configured" };

  try {
    const res = await fetch(`https://api.resend.com/audiences/${audienceId}/contacts`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    const data = await res.json();
    if (!res.ok) return { success: false, error: data.message || `HTTP ${res.status}` };

    return { success: true, contacts: data.data };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

/**
 * Remove a contact from an audience
 */
export async function removeContact(audienceId: string, contactId: string): Promise<{ success: boolean; error?: string }> {
  const apiKey = await getSettingValue("resend_api_key");
  if (!apiKey) return { success: false, error: "Resend API key not configured" };

  try {
    const res = await fetch(`https://api.resend.com/audiences/${audienceId}/contacts/${contactId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!res.ok) {
      const data = await res.json();
      return { success: false, error: data.message || `HTTP ${res.status}` };
    }

    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

// === DIGEST EMAIL ===

export async function renderDigestHtml(data: DigestData): Promise<string> {
  return await render(DigestEmail(data));
}

// === TRANSACTIONAL EMAIL TEMPLATES ===
// Used by company boilerplates for customer-facing emails

export async function renderWelcomeEmail(opts: WelcomeEmailData): Promise<string> {
  return await render(WelcomeEmail(opts));
}

export async function renderReceiptEmail(opts: ReceiptEmailData): Promise<string> {
  return await render(ReceiptEmail(opts));
}

export async function renderPasswordResetEmail(opts: PasswordResetEmailData): Promise<string> {
  return await render(PasswordResetEmail(opts));
}

