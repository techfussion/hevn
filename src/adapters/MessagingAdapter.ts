import type { OutboundMessage } from "../types/domain";
import type { IncomingAudio } from "../core/voice/types";

export type { IncomingAudio };

/**
 * Every messaging platform (Telegram, WhatsApp, ...) implements this
 * interface. The orchestrator and business logic never import a
 * platform-specific SDK directly — they only depend on this contract.
 *
 * To add a new platform: implement this interface, register it in
 * src/adapters/registry.ts, and nothing else in the app changes.
 */
export interface IncomingMessage {
  platformUserId: string;
  text?: string;
  audio?: IncomingAudio;
  timestamp: string;
  updateId?: string;
}

export interface IncomingCallbackQuery {
  id: string;
  platformUserId: string;
  data: string;
  messageId?: string;
  timestamp: string;
}

export interface MessagingAdapter {
  readonly platformName: "telegram" | "whatsapp";

  /**
   * Send a free-form conversational message.
   * NOTE: on WhatsApp this only works within the 24h customer-service
   * window. Callers that need to message outside that window must use
   * sendTemplate instead.
   */
  sendMessage(message: OutboundMessage): Promise<void>;

  /**
   * Send a pre-approved template message. Required for WhatsApp
   * business-initiated messages outside the 24h session window.
   * Telegram implementations can treat this as a no-op wrapper around
   * sendMessage since Telegram has no such restriction.
   */
  sendTemplate(
    platformUserId: string,
    templateName: string,
    params: Record<string, string>
  ): Promise<void>;

  sendTypingIndicator?(platformUserId: string): Promise<void>;

  /**
   * Answer a button callback interaction (e.g. Telegram callback_query).
   */
  answerCallbackQuery?(callbackQueryId: string, text?: string): Promise<void>;

  /**
   * Downloads an audio media file securely using provider-authenticated retrieval.
   * Prevents SSRF by strictly fetching from authorized provider endpoints.
   */
  downloadAudio?(mediaId: string): Promise<{ buffer: Buffer; mimeType: string }>;

  /**
   * Verify that an incoming webhook request actually came from the
   * platform (signature/secret check). MUST be called before processing
   * any webhook payload. Throwing/returning false should result in the
   * request being rejected with 401, not silently ignored.
   */
  verifyWebhookSignature(rawBody: string, headers: Record<string, string | undefined>): boolean;

  /**
   * Parse a raw webhook payload into our normalized IncomingMessage shape (text or voice).
   * Returns null for payloads that aren't user messages we care about (receipts, stickers, etc.).
   */
  parseIncomingWebhook(payload: unknown): IncomingMessage | null;

  /**
   * Parse a raw webhook payload into an interactive callback query if present.
   */
  parseIncomingCallbackQuery?(payload: unknown): IncomingCallbackQuery | null;
}
