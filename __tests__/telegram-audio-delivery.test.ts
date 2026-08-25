import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { TelegramAdapter } from "../src/adapters/telegram/TelegramAdapter";
import type { OutboundAudio } from "../src/adapters/MessagingAdapter";

describe("Telegram Adapter — Audio & Voice Delivery", () => {
  it("exposes full channel capabilities including audioInput and audioOutput", () => {
    const adapter = new TelegramAdapter("mock_bot_token", "mock_webhook_secret");
    assert.deepEqual(adapter.capabilities, {
      textInput: true,
      audioInput: true,
      textOutput: true,
      audioOutput: true,
      interactiveButtons: true,
    });
  });

  it("successfully formats and delivers audio with caption and inline buttons to Telegram sendVoice", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedBody: any;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = url.toString();
      capturedMethod = init?.method || "GET";
      capturedBody = init?.body;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 999 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    try {
      const adapter = new TelegramAdapter("test_token_123", "secret_456");

      const audioPayload: OutboundAudio = {
        userId: "chat_789",
        buffer: Buffer.from("OGG_VOICE_BUFFER_BYTES"),
        mimeType: "audio/ogg",
        filename: "voice.ogg",
        caption: "Following up on your proposal.",
        buttons: [
          { label: "Done", action: "fu:123:done" },
          { label: "Not Yet", action: "fu:123:not_yet" },
          { label: "+1 Hour", action: "fu:123:snooze_60" },
        ],
      };

      await adapter.sendAudio(audioPayload);

      assert.equal(capturedUrl, "https://api.telegram.org/bottest_token_123/sendVoice");
      assert.equal(capturedMethod, "POST");
      assert.ok(capturedBody instanceof FormData);

      assert.equal(capturedBody.get("chat_id"), "chat_789");
      assert.equal(capturedBody.get("caption"), "Following up on your proposal.");

      const markupJson = capturedBody.get("reply_markup");
      assert.ok(typeof markupJson === "string");
      const parsedMarkup = JSON.parse(markupJson as string);
      assert.equal(parsedMarkup.inline_keyboard[0].length, 3);
      assert.equal(parsedMarkup.inline_keyboard[0][0].text, "Done");
      assert.equal(parsedMarkup.inline_keyboard[0][0].callback_data, "fu:123:done");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("retries on transient failure and throws on persistent error", async () => {
    let callCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      callCount++;
      return new Response("Internal Gateway Error", { status: 502 });
    }) as typeof fetch;

    try {
      const adapter = new TelegramAdapter("test_token_123", "secret_456");

      const audioPayload: OutboundAudio = {
        userId: "chat_789",
        buffer: Buffer.from("AUDIO_BYTES"),
        mimeType: "audio/ogg",
      };

      await assert.rejects(
        () => adapter.sendAudio(audioPayload),
        /Telegram sendVoice failed \(502\)/
      );

      // maxRetries = 2 -> 3 total calls (initial + 2 retries)
      assert.equal(callCount, 3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
