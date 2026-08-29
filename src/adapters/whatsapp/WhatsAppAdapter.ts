import crypto from "crypto";
import type { MessagingAdapter, IncomingMessage, ChannelCapabilities, OutboundAudio } from "../MessagingAdapter";
import type { OutboundMessage } from "../../types/domain";
import { logger } from "../../utils/logger";

/**
 * WhatsApp Cloud API adapter.
 * Supports text messages, voice/audio messages, templates, typing indicators,
 * and Meta HMAC-SHA256 signature verification.
 */
export class WhatsAppAdapter implements MessagingAdapter {
  readonly platformName = "whatsapp" as const;
  readonly capabilities: ChannelCapabilities = {
    textInput: true,
    audioInput: true,
    textOutput: true,
    audioOutput: true,
    interactiveButtons: false,
  };

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

  async sendAudio(audio: OutboundAudio): Promise<void> {
    // 1. Upload audio media to WhatsApp
    const uploadUrl = `https://graph.facebook.com/v20.0/${this.phoneNumberId}/media`;
    const formData = new FormData();
    formData.append("messaging_product", "whatsapp");
    const mime = audio.mimeType || "audio/ogg";
    const filename = audio.filename || (mime.includes("mp3") ? "audio.mp3" : "audio.ogg");
    formData.append("file", new Blob([audio.buffer], { type: mime }), filename);
    formData.append("type", mime);

    const uploadRes = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
      },
      body: formData,
    });

    if (!uploadRes.ok) {
      const body = await uploadRes.text();
      logger.error({ status: uploadRes.status, body }, "WhatsApp media upload failed");
      throw new Error(`WhatsApp media upload failed (${uploadRes.status}): ${body}`);
    }

    const uploadData = (await uploadRes.json()) as { id?: string };
    if (!uploadData.id) {
      throw new Error("WhatsApp media upload did not return a media ID");
    }

    // 2. Send the uploaded media as an audio message
    const sendUrl = `https://graph.facebook.com/v20.0/${this.phoneNumberId}/messages`;
    const sendRes = await fetch(sendUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: audio.userId,
        type: "audio",
        audio: { id: uploadData.id },
      }),
    });

    if (!sendRes.ok) {
      const body = await sendRes.text();
      throw new Error(`WhatsApp sendAudio failed (${sendRes.status}): ${body}`);
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
              voice?: { id?: string; mime_type?: string };
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

    // Support native WhatsApp voice notes (message.type === 'voice')
    if (message.voice?.id) {
      return {
        platformUserId: message.from,
        audio: {
          mediaId: message.voice.id,
          mimeType: message.voice.mime_type || "audio/ogg; codecs=opus",
        },
        timestamp,
        updateId: message.id,
      };
    }

    // Support uploaded audio media (message.type === 'audio')
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
