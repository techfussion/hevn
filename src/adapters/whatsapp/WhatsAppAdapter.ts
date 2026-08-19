import crypto from "crypto";
import type { MessagingAdapter, IncomingMessage } from "../MessagingAdapter";
import type { OutboundMessage } from "../../types/domain";

/**
 * WhatsApp Cloud API adapter — scaffolded, not yet wired to a live
 * WhatsApp Business number. Fill in phoneNumberId/accessToken via env
 * vars when ready; the orchestrator and everything else needs zero
 * changes since both adapters satisfy the same MessagingAdapter contract.
 *
 * IMPORTANT: WhatsApp only allows free-form sendMessage within a 24h
 * window of the user's last message. Outside that window you MUST use
 * sendTemplate with a Meta-approved template — see class comment on
 * MessagingAdapter.ts.
 */
export class WhatsAppAdapter implements MessagingAdapter {
  readonly platformName = "whatsapp" as const;

  constructor(
    private accessToken: string,
    private phoneNumberId: string,
    private appSecret: string,
    private verifyToken: string
  ) {}

  async sendMessage(message: OutboundMessage): Promise<void> {
    const url = `https://graph.facebook.com/v20.0/${this.phoneNumberId}/messages`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: message.userId,
        type: "text",
        text: { body: message.text },
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`WhatsApp sendMessage failed (${res.status}): ${body}`);
    }
  }

  async sendTemplate(
    platformUserId: string,
    templateName: string,
    params: Record<string, string>
  ): Promise<void> {
    const url = `https://graph.facebook.com/v20.0/${this.phoneNumberId}/messages`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: platformUserId,
        type: "template",
        template: {
          name: templateName,
          language: { code: "en_US" },
          components: [
            {
              type: "body",
              parameters: Object.values(params).map((v) => ({ type: "text", text: v })),
            },
          ],
        },
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`WhatsApp sendTemplate failed (${res.status}): ${body}`);
    }
  }

  /**
   * Meta signs webhook payloads with HMAC-SHA256 using your App Secret,
   * sent in the X-Hub-Signature-256 header as "sha256=<hex>".
   */
  verifyWebhookSignature(rawBody: string, headers: Record<string, string | undefined>): boolean {
    const signatureHeader = headers["x-hub-signature-256"];
    if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;

    const expectedHex = crypto
      .createHmac("sha256", this.appSecret)
      .update(rawBody, "utf8")
      .digest("hex");

    const provided = Buffer.from(signatureHeader.slice("sha256=".length));
    const expected = Buffer.from(expectedHex);

    if (provided.length !== expected.length) return false;
    return crypto.timingSafeEqual(provided, expected);
  }

  /** Used only for the initial GET webhook subscription handshake with Meta. */
  verifySubscription(mode: string, token: string): boolean {
    return mode === "subscribe" && token === this.verifyToken;
  }

  parseIncomingWebhook(payload: unknown): IncomingMessage | null {
    const body = payload as {
      entry?: Array<{
        changes?: Array<{
          value?: {
            messages?: Array<{ from?: string; text?: { body?: string }; timestamp?: string }>;
          };
        }>;
      }>;
    };

    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0] as
      | { from?: string; text?: { body?: string }; timestamp?: string; id?: string }
      | undefined;
    if (!message?.from || !message.text?.body) return null;

    return {
      platformUserId: message.from,
      text: message.text.body,
      timestamp: message.timestamp
        ? new Date(Number(message.timestamp) * 1000).toISOString()
        : new Date().toISOString(),
      updateId: message.id,
    };
  }
}
