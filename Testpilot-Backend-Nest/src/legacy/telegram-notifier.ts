import type { Logger } from "@nestjs/common";
import type { DatabaseService } from "../database/database.service";
import { decryptSecret } from "../common/crypto.util";

export interface TelegramEventsConfig {
  bugs: boolean;
  testRuns: boolean;
  comments: boolean;
  zyra: boolean;
  other: boolean;
}

export const DEFAULT_TELEGRAM_EVENTS: TelegramEventsConfig = {
  bugs: true,
  testRuns: true,
  comments: true,
  zyra: true,
  other: true,
};

export function normalizeTelegramEvents(raw: unknown): TelegramEventsConfig {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    bugs: obj.bugs !== false,
    testRuns: obj.testRuns !== false,
    comments: obj.comments !== false,
    zyra: obj.zyra !== false,
    other: obj.other !== false,
  };
}

export function shouldForwardTelegramEvent(type: string, events: TelegramEventsConfig): boolean {
  if (type.startsWith("bug_")) return events.bugs;
  if (type.startsWith("test_")) return events.testRuns;
  if (type === "comment_reply") return events.comments;
  if (type.startsWith("zyra_") || type.startsWith("kb_")) return events.zyra;
  return events.other;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function maskTelegramToken(token: string): string {
  const trimmed = token.trim();
  if (!trimmed) return "";
  const colonIdx = trimmed.indexOf(":");
  const prefix = colonIdx > 0 ? trimmed.slice(0, colonIdx + 1) : "";
  const tail = trimmed.length > 4 ? trimmed.slice(-4) : "";
  return `${prefix}••••${tail}`;
}

export async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  htmlText: string,
  threadId?: number | null
): Promise<{ ok: boolean; error?: string }> {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text: htmlText,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (typeof threadId === "number" && Number.isInteger(threadId) && threadId > 0) {
    payload.message_thread_id = threadId;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${encodeURIComponent(botToken)}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    const data = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
    if (!res.ok || !data?.ok) {
      return { ok: false, error: data?.description || `Telegram API returned HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Failed to reach Telegram API" };
  }
}

export async function dispatchProjectTelegramNotification(
  db: DatabaseService,
  projectId: string,
  opts: { type: string; title: string; body?: string | null },
  logger?: Pick<Logger, "warn">
): Promise<void> {
  try {
    const res = await db.query<{
      bot_token_encrypted: string;
      chat_id: string;
      thread_id: number | null;
      enabled: boolean;
      events: unknown;
      project_name: string;
    }>(
      `SELECT t.bot_token_encrypted, t.chat_id, t.thread_id, t.enabled, t.events, p.name AS project_name
       FROM project_telegram_integrations t
       JOIN projects p ON p.id = t.project_id
       WHERE t.project_id = $1 AND t.enabled = TRUE AND p.archived_at IS NULL`,
      [projectId]
    );
    const row = res.rows[0];
    if (!row) return;

    const events = normalizeTelegramEvents(row.events);
    if (!shouldForwardTelegramEvent(opts.type, events)) return;

    const botToken = decryptSecret(row.bot_token_encrypted);
    if (!botToken || !row.chat_id) return;

    const lines = [
      `<b>[TestPilot · ${escapeHtml(row.project_name || "Project")}]</b>`,
      `<b>${escapeHtml(opts.title)}</b>`,
    ];
    if (opts.body && opts.body.trim()) {
      lines.push(escapeHtml(opts.body.trim()));
    }

    const result = await sendTelegramMessage(botToken, row.chat_id, lines.join("\n"), row.thread_id);
    if (!result.ok) {
      logger?.warn?.(`[telegram] failed to deliver notification (${opts.type}) for project ${projectId}: ${result.error}`);
    }
  } catch (err) {
    logger?.warn?.(
      `[telegram] unexpected error delivering notification (${opts.type}) for project ${projectId}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}
