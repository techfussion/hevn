import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { TelegramAdapter } from "../src/adapters/telegram/TelegramAdapter";
import { WhatsAppAdapter } from "../src/adapters/whatsapp/WhatsAppAdapter";

describe("Webhook Security & Adapter Normalization", () => {
  const TELEGRAM_SECRET = "super_secret_telegram_token_12345";
  const telegramAdapter = new TelegramAdapter("bot12345:ABCDE", TELEGRAM_SECRET);

  const WHATSAPP_SECRET = "whatsapp_meta_app_secret_67890";
  const whatsappAdapter = new WhatsAppAdapter("mock_token", "123456789", WHATSAPP_SECRET, "my_verify_token");

  it("verifies Telegram secret token using timing-safe comparison", () => {
    const validHeaders = { "x-telegram-bot-api-secret-token": TELEGRAM_SECRET };
    const invalidHeaders = { "x-telegram-bot-api-secret-token": "wrong_token" };
    const missingHeaders = {};

    assert.equal(telegramAdapter.verifyWebhookSignature("", validHeaders), true);
    assert.equal(telegramAdapter.verifyWebhookSignature("", invalidHeaders), false);
    assert.equal(telegramAdapter.verifyWebhookSignature("", missingHeaders), false);
  });

  it("parses valid Telegram message payload and extracts updateId", () => {
    const payload = {
      update_id: 987654,
      message: {
        message_id: 42,
        chat: { id: 11223344 },
        text: "Remind me to finish homework",
        date: 1724036400,
      },
    };

    const parsed = telegramAdapter.parseIncomingWebhook(payload);
    assert.ok(parsed !== null);
    assert.equal(parsed.platformUserId, "11223344");
    assert.equal(parsed.text, "Remind me to finish homework");
    assert.equal(parsed.updateId, "987654");
  });

  it("returns null for non-text Telegram updates (stickers/reactions)", () => {
    const stickerPayload = {
      update_id: 987655,
      message: {
        message_id: 43,
        chat: { id: 11223344 },
        sticker: { file_id: "abc" },
      },
    };

    assert.equal(telegramAdapter.parseIncomingWebhook(stickerPayload), null);
  });

  it("verifies WhatsApp HMAC-SHA256 signature and rejects tampered bodies", () => {
    const rawBody = JSON.stringify({ object: "whatsapp_business_account" });
    const signatureHex = crypto.createHmac("sha256", WHATSAPP_SECRET).update(rawBody, "utf8").digest("hex");

    const validHeaders = { "x-hub-signature-256": `sha256=${signatureHex}` };
    const tamperedHeaders = { "x-hub-signature-256": `sha256=${signatureHex}ff` };
    const invalidSignature = { "x-hub-signature-256": `sha256=0000000000000000000000000000000000000000000000000000000000000000` };

    assert.equal(whatsappAdapter.verifyWebhookSignature(rawBody, validHeaders), true);
    assert.equal(whatsappAdapter.verifyWebhookSignature(rawBody, tamperedHeaders), false);
    assert.equal(whatsappAdapter.verifyWebhookSignature(rawBody, invalidSignature), false);
    assert.equal(whatsappAdapter.verifyWebhookSignature("tampered raw body", validHeaders), false);
  });

  it("verifies WhatsApp subscription challenge", () => {
    assert.equal(whatsappAdapter.verifySubscription("subscribe", "my_verify_token"), true);
    assert.equal(whatsappAdapter.verifySubscription("subscribe", "wrong_token"), false);
    assert.equal(whatsappAdapter.verifySubscription("other_mode", "my_verify_token"), false);
  });
});
