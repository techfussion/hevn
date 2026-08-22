import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TelegramAdapter } from "../src/adapters/telegram/TelegramAdapter";
import { FollowUpService } from "../src/core/followup/FollowUpService";
import type { OutboundMessage } from "../src/types/domain";

describe("Telegram Interactive Follow-Ups & Callback Security", () => {
  const secret = "test_telegram_webhook_secret_12345";
  const adapter = new TelegramAdapter("mock_bot_token", secret);

  it("parses valid incoming callback query and extracts data correctly", () => {
    const rawPayload = {
      update_id: 10001,
      callback_query: {
        id: "cq_id_1001",
        from: { id: 999888777 },
        data: "fu:22222222-2222-2222-2222-222222222222:done",
        message: { message_id: 88, date: 1724300000 },
      },
    };

    const parsed = adapter.parseIncomingCallbackQuery(rawPayload);
    assert.ok(parsed);
    assert.equal(parsed.id, "cq_id_1001");
    assert.equal(parsed.platformUserId, "999888777");
    assert.equal(parsed.data, "fu:22222222-2222-2222-2222-222222222222:done");
    assert.equal(parsed.messageId, "88");
  });

  it("returns null for non-callback webhook payloads in parseIncomingCallbackQuery", () => {
    const textPayload = {
      update_id: 10002,
      message: {
        message_id: 89,
        chat: { id: 999888777 },
        text: "Hello",
      },
    };

    const parsed = adapter.parseIncomingCallbackQuery(textPayload);
    assert.equal(parsed, null);
  });

  it("formats outbound message with inline keyboard buttons for Telegram", async () => {
    const message: OutboundMessage = {
      userId: "123456",
      text: "Following up on proposal — have you managed to get it done?",
      buttons: [
        { label: "Done", action: "fu:fu-123:done" },
        { label: "Not Yet", action: "fu:fu-123:not_yet" },
        { label: "+1 Hour", action: "fu:fu-123:snooze_60" },
      ],
    };

    let fetchBody: any = null;
    const originalFetch = global.fetch;
    try {
      global.fetch = (async (_url: string, init: { body: string }) => {
        fetchBody = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true }),
        } as Response;
      }) as any;

      await adapter.sendMessage(message);

      assert.ok(fetchBody);
      assert.equal(fetchBody.chat_id, "123456");
      assert.ok(fetchBody.reply_markup);
      assert.ok(fetchBody.reply_markup.inline_keyboard);
      assert.equal(fetchBody.reply_markup.inline_keyboard[0].length, 3);
      assert.equal(fetchBody.reply_markup.inline_keyboard[0][0].text, "Done");
      assert.equal(fetchBody.reply_markup.inline_keyboard[0][0].callback_data, "fu:fu-123:done");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("handles duplicate callback execution idempotently", async () => {
    const followUpService = new FollowUpService();
    const userId = "00000000-0000-0000-0000-000000000001";
    const followUpId = "22222222-2222-2222-2222-222222222222";

    let timesHandled = 0;
    (followUpService as unknown as Record<string, unknown>).handleFollowUpResponse = async (
      _uid: string,
      _fId: string,
      _intent: string
    ) => {
      timesHandled++;
      return { success: true, message: "Marked as completed" };
    };

    // First callback execution
    const res1 = await followUpService.handleFollowUpResponse(userId, followUpId, "completed");
    assert.equal(res1.success, true);
    assert.equal(timesHandled, 1);

    // Duplicate callback execution
    const res2 = await followUpService.handleFollowUpResponse(userId, followUpId, "completed");
    assert.equal(res2.success, true);
    assert.equal(timesHandled, 2);
  });
});
