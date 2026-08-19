import crypto from "crypto";
import type { MessagingAdapter, IncomingMessage } from "../MessagingAdapter";
import type { OutboundMessage } from "../../types/domain";
import { logger } from "../../utils/logger";

/**
 * Telegram adapter. Telegram has no 24h-session restriction, so
 * sendTemplate is just a thin pass-through to sendMessage with the
 * params interpolated — kept for interface parity with WhatsApp.
 *
 * Webhook verification: Telegram lets you set a secret token that it
 * echoes back in the `X-Telegram-Bot-Api-Secret-Token` header on every
 * webhook call. We compare it with a constant-time check.
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

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: message.userId, text: message.text }),
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
    // Telegram has no template system — just render the params into
    // a plain message. templateName is used purely for logging/clarity.
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

  verifyWebhookSignature(_rawBody: string, headers: Record<string, string | undefined>): boolean {
    const provided = headers["x-telegram-bot-api-secret-token"];
    if (!provided) return false;

    const expected = Buffer.from(this.webhookSecret);
    const actual = Buffer.from(provided);

    // Lengths must match before timingSafeEqual (it throws on mismatched length).
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
      return null; // not a plain text message (could be a sticker, edit, etc.)
    }

    const updateId = body.update_id ? String(body.update_id) : (msg.message_id ? String(msg.message_id) : undefined);

    return {
      platformUserId: String(msg.chat.id),
      text: msg.text,
      timestamp: msg.date ? new Date(msg.date * 1000).toISOString() : new Date().toISOString(),
      updateId,
    };
  }
}
