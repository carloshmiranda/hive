import { getDb, json } from "@/lib/db";
import { getSettingValue } from "@/lib/settings";
import { editTelegramMessage } from "@/lib/telegram";

// POST /api/webhooks/telegram — handles Telegram Bot webhook callbacks
// Set webhook: https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://hive-phi.vercel.app/api/webhooks/telegram
export async function POST(req: Request) {
  const body = await req.json();

  // Handle callback queries (button presses)
  const callback = body.callback_query;
  if (!callback) return json({ ok: true });

  const data = callback.data as string;
  const chatId = callback.message?.chat?.id;
  const messageId = callback.message?.message_id;

  if (!data || !chatId || !messageId) return json({ ok: true });

  // Verify this is from the authorized chat
  const authorizedChatId = await getSettingValue("telegram_chat_id").catch(() => "");
  if (String(chatId) !== authorizedChatId) {
    return json({ ok: true }); // silently ignore unauthorized users
  }

  const botToken = await getSettingValue("telegram_bot_token").catch(() => "");
  if (!botToken) return json({ ok: true });

  const sql = getDb();

  try {
    if (data.startsWith("approve:") || data.startsWith("reject:")) {
      // Approval gate decision
      const [action, approvalId] = [data.split(":")[0], data.slice(data.indexOf(":") + 1)];
      const decision = action === "approve" ? "approved" : "rejected";

      // Update the approval
      const [approval] = await sql`
        UPDATE approvals
        SET status = ${decision}, decided_at = NOW(), decision_note = ${"Decided via Telegram"}
        WHERE id = ${approvalId} AND status = 'pending'
        RETURNING id, title, gate_type, company_id
      `;

      if (approval) {
        // Trigger side effects for approved gates (same as dashboard approve)
        if (decision === "approved" && approval.gate_type === "new_company") {
          // Dispatch Engineer to provision
          const ghPat = await getSettingValue("github_pat").catch(() => null);
          if (ghPat) {
            const [company] = await sql`SELECT slug FROM companies WHERE id = ${approval.company_id}`;
            if (company) {
              await fetch("https://api.github.com/repos/carloshmiranda/hive/dispatches", {
                method: "POST",
                headers: { Authorization: `token ${ghPat}`, Accept: "application/vnd.github.v3+json" },
                body: JSON.stringify({ event_type: "new_company", client_payload: { company: company.slug } }),
                signal: AbortSignal.timeout(10000),
              });
            }
          }
        }

        await editTelegramMessage(botToken, String(chatId), messageId,
          `${decision === "approved" ? "\u2705" : "\u274C"} <b>${decision.toUpperCase()}</b>: ${approval.title}`,
        );
      } else {
        await editTelegramMessage(botToken, String(chatId), messageId,
          `\u26A0\uFE0F Approval ${approvalId} not found or already decided.`);
      }
    } else if (data.startsWith("merge:") || data.startsWith("close:")) {
      // PR decision: merge:owner/repo:number or close:owner/repo:number
      const parts = data.split(":");
      const action = parts[0];
      const repo = `${parts[1]}/${parts[2]}`;
      const prNumber = parts[3];

      const ghPat = await getSettingValue("github_pat").catch(() => null);
      if (!ghPat) {
        await editTelegramMessage(botToken, String(chatId), messageId,
          "\u274C GitHub PAT not configured — cannot manage PR.");
        return json({ ok: true });
      }

      if (action === "merge") {
        const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}/merge`, {
          method: "PUT",
          headers: { Authorization: `token ${ghPat}`, Accept: "application/vnd.github.v3+json" },
          body: JSON.stringify({ merge_method: "squash" }),
          signal: AbortSignal.timeout(10000),
        });
        const merged = res.ok;
        await editTelegramMessage(botToken, String(chatId), messageId,
          merged
            ? `\u2705 <b>MERGED</b>: PR #${prNumber} on ${repo}`
            : `\u274C <b>Merge failed</b>: PR #${prNumber} — ${(await res.json().catch(() => ({}))).message || "unknown error"}`
        );
      } else {
        const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}`, {
          method: "PATCH",
          headers: { Authorization: `token ${ghPat}`, Accept: "application/vnd.github.v3+json" },
          body: JSON.stringify({ state: "closed" }),
          signal: AbortSignal.timeout(10000),
        });
        await editTelegramMessage(botToken, String(chatId), messageId,
          res.ok
            ? `\u274C <b>CLOSED</b>: PR #${prNumber} on ${repo}`
            : `\u26A0\uFE0F Failed to close PR #${prNumber}`
        );
      }
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("Telegram webhook error:", msg);
    await editTelegramMessage(botToken, String(chatId), messageId,
      `\u26A0\uFE0F Error: ${msg.slice(0, 200)}`).catch(() => {});
  }

  // Answer the callback query (removes loading spinner on Telegram)
  await fetch(`${process.env.TELEGRAM_API || "https://api.telegram.org"}/bot${botToken}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callback.id }),
  }).catch(() => {});

  return json({ ok: true });
}
