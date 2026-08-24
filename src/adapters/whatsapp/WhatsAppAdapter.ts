import crypto from "crypto";
import type { MessagingAdapter, IncomingMessage } from "../MessagingAdapter";
import type { OutboundMessage } from "../../types/domain";

/**
 * WhatsApp Cloud API adapter.
 * Supports text messages, voice/audio messages, templates, typing indicators,
 * and Meta HMAC-SHA256 signature verification.
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
   * Securely downloads an audio or voice file from WhatsApp Cloud API.
   * Enforces provider-authenticated retrieval to prevent arbitrary URL fetching (SSRF).
   */
  async downloadAudio(mediaId: string): Promise<{ buffer: Buffer; mimeType: string }> {
    // 1. Retrieve the media URL from Meta Graph API
    const metaUrl = `https://graph.facebook.com/v20.0/${encodeURIComponent(mediaId)}`;
    const metaRes = await fetch(metaUrl, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    if (!metaRes.ok) {
      const errBody = await metaRes.text();
      throw new Error(`WhatsApp getMedia failed (${metaRes.status}): ${errBody}`);
    }

    const mediaData = (await metaRes.json()) as { url?: string; mime_type?: string };
    if (!mediaData.url) {
      throw new Error("WhatsApp getMedia returned no media URL");
    }

    // SSRF Check: Ensure the download URL belongs to Meta's verified CDN domains
    const parsedUrl = new URL(mediaData.url);
    const validHostPatterns = [
      /\.fbsbx\.com$/,
      /\.fbcdn\.net$/,
      /\.facebook\.com$/,
      /\.whatsapp\.net$/,
    ];
    const isMetaHost = validHostPatterns.some((p) => p.test(parsedUrl.hostname));
    if (!isMetaHost) {
      throw new Error(`Untrusted WhatsApp media download host: ${parsedUrl.hostname}`);
    }

    // 2. Fetch the binary audio content with the access token
    const downloadRes = await fetch(mediaData.url, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    if (!downloadRes.ok) {
      throw new Error(`WhatsApp media download failed (${downloadRes.status})`);
    }

    const arrayBuffer = await downloadRes.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuffer),
      mimeType: mediaData.mime_type || "audio/ogg",
    };
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
            messages?: Array<{
              from?: string;
              type?: string;
              text?: { body?: string };
              audio?: { id?: string; mime_type?: string; voice?: boolean };
              timestamp?: string;
              id?: string;
            }>;
          };
        }>;
      }>;
    };

    const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message?.from) return null;

    const timestamp = message.timestamp
      ? new Date(Number(message.timestamp) * 1000).toISOString()
      : new Date().toISOString();

    if (message.text?.body) {
      return {
        platformUserId: message.from,
        text: message.text.body,
        timestamp,
        updateId: message.id,
      };
    }

    if (message.audio?.id) {
      return {
        platformUserId: message.from,
        audio: {
          mediaId: message.audio.id,
          mimeType: message.audio.mime_type || "audio/ogg",
        },
        timestamp,
        updateId: message.id,
      };
    }

    return null;
  }
}
