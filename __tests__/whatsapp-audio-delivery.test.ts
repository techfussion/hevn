import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WhatsAppAdapter } from "../src/adapters/whatsapp/WhatsAppAdapter";
import type { OutboundAudio } from "../src/adapters/MessagingAdapter";

describe("WhatsApp Adapter — Audio & Voice Delivery", () => {
  it("exposes capabilities reflecting WhatsApp platform features", () => {
    const adapter = new WhatsAppAdapter(
      "mock_access_token",
      "phone_num_123",
      "app_secret_456",
      "verify_token_789"
    );
    assert.deepEqual(adapter.capabilities, {
      textInput: true,
      audioInput: true,
      textOutput: true,
      audioOutput: true,
      interactiveButtons: false,
    });
  });

  it("uploads audio media then dispatches WhatsApp audio message", async () => {
    const requests: Array<{ url: string; method: string; body: any; headers: any }> = [];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      requests.push({
        url: urlStr,
        method: init?.method || "GET",
        body: init?.body,
        headers: init?.headers,
      });

      if (urlStr.includes("/media")) {
        return new Response(JSON.stringify({ id: "meta_media_id_999" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (urlStr.includes("/messages")) {
        return new Response(
          JSON.stringify({ messaging_product: "whatsapp", contacts: [], messages: [{ id: "wam_123" }] }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        );
      }

      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    try {
      const adapter = new WhatsAppAdapter(
        "test_access_token",
        "10001234",
        "test_secret",
        "verify_token"
      );

      const audio: OutboundAudio = {
        userId: "+15551234567",
        buffer: Buffer.from("WHATSAPP_AUDIO_BUFFER"),
        mimeType: "audio/ogg",
      };

      await adapter.sendAudio(audio);

      assert.equal(requests.length, 2);

      // 1. Media upload
      assert.equal(requests[0].url, "https://graph.facebook.com/v20.0/10001234/media");
      assert.equal(requests[0].method, "POST");
      assert.ok(requests[0].body instanceof FormData);

      // 2. Message send
      assert.equal(requests[1].url, "https://graph.facebook.com/v20.0/10001234/messages");
      assert.equal(requests[1].method, "POST");
      const parsedBody = JSON.parse(requests[1].body);
      assert.equal(parsedBody.messaging_product, "whatsapp");
      assert.equal(parsedBody.to, "+15551234567");
      assert.equal(parsedBody.type, "audio");
      assert.equal(parsedBody.audio.id, "meta_media_id_999");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("handles media upload failure gracefully and throws descriptive error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ error: { message: "Invalid OAuth access token" } }), {
        status: 401,
      });
    }) as typeof fetch;

    try {
      const adapter = new WhatsAppAdapter(
        "bad_token",
        "10001234",
        "test_secret",
        "verify_token"
      );

      const audio: OutboundAudio = {
        userId: "+15551234567",
        buffer: Buffer.from("WHATSAPP_AUDIO_BUFFER"),
        mimeType: "audio/ogg",
      };

      await assert.rejects(
        () => adapter.sendAudio(audio),
        /WhatsApp media upload failed \(401\)/
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
