// Telegram Bot API helper for Hive notifications
// Sends real-time push notifications to Carlos when agents do work.
//
// Setup:
//   1. Message @BotFather on Telegram, send /newbot, name it "Hive Bot"
//   2. Copy the bot token → add as `telegram_bot_token` in Hive settings (/settings)
//   3. Start a chat with the bot, send /start
//   4. Get your chat ID: fetch https://api.telegram.org/bot<TOKEN>/getUpdates
//      → look for result[0].message.chat.id
//   5. Add chat ID as `telegram_chat_id` in Hive settings (/settings)

import { getSettingValue } from "@/lib/settings";
import { getAgentDisplay, getActionDisplay } from "@/lib/agent-display";

const TELEGRAM_API = "https://api.telegram.org";

// Clean up task titles that have been corrupted by mechanical decomposition
// Strips cascading "Sub-task of:" prefixes, deduplicates repeated text, and truncates
export function sanitizeTaskTitle(title: string, maxLen = 120): string {
  let t = title;
  // Strip "Sub-task of:" prefixes (can be nested from repeated decomposition)
  t = t.replace(/^(?:Sub-task of:\s*)+/i, "");
  // Strip leading acceptance criteria fragments that leaked into titles
  t = t.replace(/^(?:npx next build passes\s*[-–—]?\s*)+/i, "");
  t = t.replace(/^(?:Change is implemented correctly\s*[-–—]?\s*)+/i, "");
  // Strip leading/trailing whitespace and dashes
  t = t.replace(/^[\s\-–—:]+|[\s\-–—:]+$/g, "");
  // If title is empty after cleanup, return a placeholder
  if (!t || t.length < 5) return "(untitled task)";
  // Truncate with ellipsis
  if (t.length > maxLen) t = t.slice(0, maxLen - 1) + "…";
  return t;
}

// Clean up notification summaries that may contain corrupted task titles
function sanitizeNotificationSummary(summary: string): string {
  // Clean up quoted titles within the summary (e.g., '"Sub-task of: foo" dispatched')
  return summary.replace(/"([^"]{5,})"/g, (_match, title) => {
    return `"${sanitizeTaskTitle(title, 80)}"`;
  });
}

export async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string,
  parseMode: "HTML" | "Markdown" = "HTML"
): Promise<boolean> {
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[telegram] sendMessage failed: HTTP ${res.status} — ${body.slice(0, 200)}`);
    }
    return res.ok;
  } catch (e) {
    console.error("[telegram] sendMessage error:", e instanceof Error ? e.message : String(e));
    return false;
  }
}

export type NotificationEvent = {
  agent: string;
  action: string;
  company?: string;
  status: "started" | "success" | "failed";
  summary: string;
  details?: string;
  pr_number?: number;
  pr_url?: string;
  pr_title?: string;
  duration_s?: number;
  task_title?: string;
  error?: string;
  run_url?: string;
};


// Format agent activity as a Telegram notification
export function formatAgentNotification(event: NotificationEvent): string {
  const statusIcons: Record<string, string> = {
    started: "\u25B6\uFE0F",
    success: "\u2705",
    failed: "\u274C",
  };

  const agentInfo = getAgentDisplay(event.agent);
  const actionLabel = getActionDisplay(event.action);
  const statusIcon = statusIcons[event.status] || "\u2753";

  let msg = `${statusIcon} ${agentInfo.icon} <b>${agentInfo.name}</b>`;
  if (event.company) msg += ` \u2192 <b>${event.company}</b>`;

  // Action line — human-readable
  msg += `\n${actionLabel}`;
  if (event.task_title) msg += `: ${sanitizeTaskTitle(event.task_title, 100)}`;

  // Duration if available
  if (event.duration_s && event.duration_s > 0) {
    const mins = Math.floor(event.duration_s / 60);
    const secs = event.duration_s % 60;
    msg += `\n\u23F1 ${mins > 0 ? `${mins}m ` : ""}${secs}s`;
  }

  // Summary — sanitize embedded titles
  msg += `\n${sanitizeNotificationSummary(event.summary)}`;

  // PR info with clickable link
  if (event.pr_number && event.pr_url) {
    msg += `\n\u{1F517} <a href="${event.pr_url}">PR #${event.pr_number}</a>`;
    if (event.pr_title) msg += ` — ${event.pr_title.slice(0, 80)}`;
  }

  // Error info for failures
  if (event.status === "failed" && event.error) {
    msg += `\n\n\u26A0\uFE0F <code>${event.error.slice(0, 300)}</code>`;
  }

  // Run URL for debugging
  if (event.run_url) {
    msg += `\n<a href="${event.run_url}">View run</a>`;
  }

  // Additional details
  if (event.details) msg += `\n\n<i>${event.details.slice(0, 300)}</i>`;
  return msg;
}

// Send a message with inline keyboard buttons
export async function sendTelegramMessageWithButtons(
  botToken: string,
  chatId: string,
  text: string,
  buttons: Array<Array<{ text: string; callback_data: string }>>,
  parseMode: "HTML" | "Markdown" = "HTML"
): Promise<boolean> {
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: buttons },
      }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Edit an existing message (for updating after button press)
export async function editTelegramMessage(
  botToken: string,
  chatId: string,
  messageId: number,
  text: string,
  parseMode: "HTML" | "Markdown" = "HTML"
): Promise<boolean> {
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${botToken}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Send a Hive notification (reads settings, sends if configured)
export async function notifyHive(event: NotificationEvent): Promise<boolean> {
  try {
    const botToken = await getSettingValue("telegram_bot_token");
    const chatId = await getSettingValue("telegram_chat_id");
    if (!botToken || !chatId) {
      console.warn(`[telegram] notifyHive: missing settings — bot_token=${!!botToken}, chat_id=${!!chatId}`);
      return false;
    }
    const message = formatAgentNotification(event);
    const sent = await sendTelegramMessage(botToken, chatId, message);
    if (!sent) console.warn("[telegram] notifyHive: sendTelegramMessage returned false");
    return sent;
  } catch (e) {
    console.error("[telegram] notifyHive error:", e instanceof Error ? e.message : String(e));
    return false;
  }
}

// Send an approval request with approve/reject buttons
export async function notifyApproval(approval: {
  id: string;
  gate_type: string;
  title: string;
  company?: string;
  details?: string;
}): Promise<boolean> {
  try {
    const botToken = await getSettingValue("telegram_bot_token");
    const chatId = await getSettingValue("telegram_chat_id");
    if (!botToken || !chatId) return false;

    const msg = `\u{1F6A8} <b>Approval Required</b>\n`
      + `<b>${approval.gate_type}</b>${approval.company ? ` \u2192 ${approval.company}` : ""}\n`
      + `${approval.title}\n`
      + (approval.details ? `\n<i>${approval.details.slice(0, 300)}</i>` : "");

    return sendTelegramMessageWithButtons(botToken, chatId, msg, [[
      { text: "\u2705 Approve", callback_data: `approve:${approval.id}` },
      { text: "\u274C Reject", callback_data: `reject:${approval.id}` },
    ]]);
  } catch {
    return false;
  }
}

// Send a PR review request with merge/close buttons
export async function notifyPR(pr: {
  number: number;
  title: string;
  repo: string;
  url: string;
  body?: string;
  safe: boolean;  // if true, auto-merged — notification is informational
}): Promise<boolean> {
  try {
    const botToken = await getSettingValue("telegram_bot_token");
    const chatId = await getSettingValue("telegram_chat_id");
    if (!botToken || !chatId) return false;

    if (pr.safe) {
      // Auto-merged — informational only
      const msg = `\u2705 <b>PR Auto-Merged</b>\n`
        + `<a href="${pr.url}">#${pr.number}</a> ${pr.title}\n`
        + `<i>${pr.repo}</i>`;
      return sendTelegramMessage(botToken, chatId, msg);
    }

    // Needs review — add buttons
    const msg = `\u{1F4CB} <b>PR Review</b>\n`
      + `<a href="${pr.url}">#${pr.number}</a> ${pr.title}\n`
      + `<i>${pr.repo}</i>`
      + (pr.body ? `\n\n${pr.body.slice(0, 300)}` : "");

    return sendTelegramMessageWithButtons(botToken, chatId, msg, [[
      { text: "\u2705 Merge", callback_data: `merge:${pr.repo}:${pr.number}` },
      { text: "\u274C Close", callback_data: `close:${pr.repo}:${pr.number}` },
    ]]);
  } catch {
    return false;
  }
}
