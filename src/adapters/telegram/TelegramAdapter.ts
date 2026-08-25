import crypto from "crypto";
import type { MessagingAdapter, IncomingMessage, IncomingCallbackQuery, ChannelCapabilities, OutboundAudio } from "../MessagingAdapter";
import type { OutboundMessage } from "../../types/domain";
import { logger } from "../../utils/logger";

/**
 * Telegram adapter.
 * Supports free-form text messages, voice notes, audio files, inline keyboard buttons,
 * callback queries, typing indicators, and timing-safe webhook verification.
 */
export class TelegramAdapter implements MessagingAdapter {
  readonly platformName = "telegram" as const;
  readonly capabilities: ChannelCapabilities = {
    textInput: true,
    audioInput: true,
    textOutput: true,
    audioOutput: true,
    interactiveButtons: true,
  };

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

  async sendAudio(audio: OutboundAudio): Promise<void> {
    const url = `https://api.telegram.org/bot${this.botToken}/sendVoice`;
    const maxRetries = 2;

    const formData = new FormData();
    formData.append("chat_id", audio.userId);

    const blob = new Blob([audio.buffer], { type: audio.mimeType || "audio/ogg" });
    const filename = audio.filename || (audio.mimeType.includes("mp3") ? "voice.mp3" : "voice.ogg");
    formData.append("voice", blob, filename);

    if (audio.caption) {
      formData.append("caption", audio.caption.slice(0, 1024));
    }

    if (audio.buttons && audio.buttons.length > 0) {
      formData.append(
        "reply_markup",
        JSON.stringify({
          inline_keyboard: [
            audio.buttons.map((btn) => ({
              text: btn.label,
              callback_data: btn.action,
            })),
          ],
        })
      );
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetch(url, {
          method: "POST",
          body: formData,
        });

        if (!res.ok) {
          const body = await res.text();
          throw new Error(`Telegram sendVoice failed (${res.status}): ${body}`);
        }
        return;
      } catch (err) {
        if (attempt === maxRetries) throw err;
        logger.warn({ err, attempt: attempt + 1, maxRetries }, "Telegram sendVoice network error, retrying");
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

  /**
   * Securely downloads an audio or voice file from Telegram's media API.
   * Enforces provider-authenticated retrieval to prevent arbitrary URL fetching (SSRF).
   */
  async downloadAudio(mediaId: string): Promise<{ buffer: Buffer; mimeType: string }> {
    const getFileUrl = `https://api.telegram.org/bot${this.botToken}/getFile?file_id=${encodeURIComponent(mediaId)}`;
    const fileRes = await fetch(getFileUrl);
    if (!fileRes.ok) {
      const errBody = await fileRes.text();
      throw new Error(`Telegram getFile failed (${fileRes.status}): ${errBody}`);
    }

    const fileData = (await fileRes.json()) as { ok: boolean; result?: { file_path?: string } };
    if (!fileData.ok || !fileData.result?.file_path) {
      throw new Error("Telegram getFile returned invalid result");
    }

    const filePath = fileData.result.file_path;
    if (filePath.includes("..") || filePath.includes("://")) {
      throw new Error("Invalid Telegram file path");
    }

    const downloadUrl = `https://api.telegram.org/file/bot${this.botToken}/${filePath}`;
    const downloadRes = await fetch(downloadUrl);
    if (!downloadRes.ok) {
      throw new Error(`Telegram file download failed (${downloadRes.status})`);
    }

    const arrayBuffer = await downloadRes.arrayBuffer();
    const mimeType =
      filePath.endsWith(".oga") || filePath.endsWith(".ogg")
        ? "audio/ogg"
        : filePath.endsWith(".mp3")
        ? "audio/mpeg"
        : "audio/ogg";

    return {
      buffer: Buffer.from(arrayBuffer),
      mimeType,
    };
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
      message?: {
        message_id?: number;
        chat?: { id?: number };
        text?: string;
        voice?: { file_id?: string; duration?: number; mime_type?: string; file_size?: number };
        audio?: { file_id?: string; duration?: number; mime_type?: string; file_size?: number };
        date?: number;
      };
    };

    const msg = body.message;
    if (!msg || !msg.chat?.id) {
      return null;
    }

    const updateId = body.update_id ? String(body.update_id) : (msg.message_id ? String(msg.message_id) : undefined);
    const timestamp = msg.date ? new Date(msg.date * 1000).toISOString() : new Date().toISOString();

    if (typeof msg.text === "string") {
      return {
        platformUserId: String(msg.chat.id),
        text: msg.text,
        timestamp,
        updateId,
      };
    }

    if (msg.voice && msg.voice.file_id) {
      return {
        platformUserId: String(msg.chat.id),
        audio: {
          mediaId: msg.voice.file_id,
          mimeType: msg.voice.mime_type || "audio/ogg",
          durationSeconds: msg.voice.duration,
          fileSizeBytes: msg.voice.file_size,
        },
        timestamp,
        updateId,
      };
    }

    if (msg.audio && msg.audio.file_id) {
      return {
        platformUserId: String(msg.chat.id),
        audio: {
          mediaId: msg.audio.file_id,
          mimeType: msg.audio.mime_type || "audio/mpeg",
          durationSeconds: msg.audio.duration,
          fileSizeBytes: msg.audio.file_size,
        },
        timestamp,
        updateId,
      };
    }

    return null;
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
