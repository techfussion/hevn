import crypto from "crypto";
import type { MessagingAdapter, IncomingMessage, IncomingCallbackQuery } from "../MessagingAdapter";
import type { OutboundMessage } from "../../types/domain";
import { logger } from "../../utils/logger";

/**
 * Telegram adapter.
 * Supports free-form text messages, inline interactive keyboard buttons,
 * callback queries, typing indicators, and timing-safe webhook verification.
 */
export class TelegramAdapter implements MessagingAdapter {
  readonly platformName = "telegram" as const;

  constructor(
    private botToken: string,
    private webhookSecret: string
  ) {}

  async sendMessage(message: OutboundMessage): Promise<void> {
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const maxRetries = 2;

    const payload: Record<string, unknown> = {
      chat_id: message.userId,
      text: message.text,
    };

    if (message.buttons && message.buttons.length > 0) {
      payload.reply_markup = {
        inline_keyboard: [
          message.buttons.map((btn) => ({
            text: btn.label,
            callback_data: btn.action,
          })),
        ],
      };
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const body = await res.text();
          throw new Error(`Telegram sendMessage failed (${res.status}): ${body}`);
        }
        return; // success
      } catch (err) {
        if (attempt === maxRetries) throw err;
        logger.warn({ err, attempt: attempt + 1, maxRetries }, "Telegram sendMessage network error, retrying");
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }

  async sendTemplate(
    platformUserId: string,
    templateName: string,
    params: Record<string, string>
  ): Promise<void> {
    const rendered = Object.entries(params)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    await this.sendMessage({
      userId: platformUserId,
      text: `[${templateName}] ${rendered}`,
    });
  }

  async sendTypingIndicator(platformUserId: string): Promise<void> {
    try {
      await fetch(`https://api.telegram.org/bot${this.botToken}/sendChatAction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: platformUserId, action: "typing" }),
      });
    } catch {
      // best-effort only — never let a failed typing indicator break the real reply
    }
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    try {
      await fetch(`https://api.telegram.org/bot${this.botToken}/answerCallbackQuery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          callback_query_id: callbackQueryId,
          text: text || "Processed",
        }),
      });
    } catch (err) {
      logger.debug({ err, callbackQueryId }, "Failed to answer Telegram callback query");
    }
  }

  verifyWebhookSignature(_rawBody: string, headers: Record<string, string | undefined>): boolean {
    const provided = headers["x-telegram-bot-api-secret-token"];
    if (!provided) return false;

    const expected = Buffer.from(this.webhookSecret);
    const actual = Buffer.from(provided);

    if (expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(expected, actual);
  }

  parseIncomingWebhook(payload: unknown): IncomingMessage | null {
    const body = payload as {
      update_id?: number;
      message?: { message_id?: number; chat?: { id?: number }; text?: string; date?: number };
    };

    const msg = body.message;
    if (!msg || !msg.chat?.id || typeof msg.text !== "string") {
      return null;
    }

    const updateId = body.update_id ? String(body.update_id) : (msg.message_id ? String(msg.message_id) : undefined);

    return {
      platformUserId: String(msg.chat.id),
      text: msg.text,
      timestamp: msg.date ? new Date(msg.date * 1000).toISOString() : new Date().toISOString(),
      updateId,
    };
  }

  parseIncomingCallbackQuery(payload: unknown): IncomingCallbackQuery | null {
    const body = payload as {
      update_id?: number;
      callback_query?: {
        id?: string;
        from?: { id?: number };
        data?: string;
        message?: { message_id?: number; date?: number };
      };
    };

    const cq = body.callback_query;
    if (!cq || !cq.id || !cq.from?.id || typeof cq.data !== "string") {
      return null;
    }

    return {
      id: cq.id,
      platformUserId: String(cq.from.id),
      data: cq.data,
      messageId: cq.message?.message_id ? String(cq.message.message_id) : undefined,
      timestamp: cq.message?.date ? new Date(cq.message.date * 1000).toISOString() : new Date().toISOString(),
    };
  }
}
