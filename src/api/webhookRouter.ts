import express, { Request, Response, Router } from "express";
import crypto from "crypto";
import type { MessagingAdapter } from "../adapters/MessagingAdapter";
import { ConversationOrchestrator } from "../orchestrator/ConversationOrchestrator";
import { UserService } from "../core/tasks/UserService";
import { FollowUpService } from "../core/followup/FollowUpService";
import { AudioIngestionService } from "../core/voice/AudioIngestionService";
import { GeminiTranscriptionProvider } from "../core/voice/GeminiTranscriptionProvider";
import { logger } from "../utils/logger";

/**
 * Builds the webhook router for a given adapter. Every request goes
 * through: rate limiting (applied in index.ts) -> raw body capture
 * (needed for signature verification) -> signature check -> parse ->
 * deduplication -> audio normalization (if voice) -> orchestrate -> reply.
 * Any failure at the signature step returns 401.
 */
export function buildWebhookRouter(
  adapter: MessagingAdapter,
  orchestrator: ConversationOrchestrator,
  userService: UserService,
  followUpService: FollowUpService = new FollowUpService(),
  audioIngestionService?: AudioIngestionService
): Router {
  const router = Router();

  // Capture raw body for HMAC verification — express.json() alone discards it.
  router.use(
    express.json({
      verify: (req: Request & { rawBody?: string }, _res, buf) => {
        req.rawBody = buf.toString("utf8");
      },
    })
  );

  router.post("/", async (req: Request & { rawBody?: string }, res: Response) => {
    const rawBody = req.rawBody ?? "";
    const headers = Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])
    );

    if (!adapter.verifyWebhookSignature(rawBody, headers)) {
      logger.warn({ platform: adapter.platformName }, "Webhook signature verification failed");
      res.status(401).json({ error: "invalid signature" });
      return;
    }

    // Respond fast — messaging platforms expect a quick 200 and will
    // retry aggressively on timeout. Process asynchronously.
    res.status(200).json({ ok: true });

    const correlationId = crypto.randomUUID();

    try {
      // 1. Check if payload is an interactive callback query (e.g. Telegram inline button click)
      const incomingCb = adapter.parseIncomingCallbackQuery?.(req.body);
      if (incomingCb) {
        if (incomingCb.id) {
          const cbKey = `${adapter.platformName}:cb:${incomingCb.id}`;
          const acquired = await userService.tryAcquireUpdate(cbKey, adapter.platformName);
          if (!acquired) {
            logger.info({ correlationId, cbKey, platform: adapter.platformName }, "Skipping duplicate callback update");
            await adapter.answerCallbackQuery?.(incomingCb.id, "Already processed");
            return;
          }
        }

        const user = await userService.getOrCreate(adapter.platformName, incomingCb.platformUserId);

        // Parse callback data: "fu:<followup_id>:<action>"
        const parts = incomingCb.data.split(":");
        if (parts[0] === "fu" && parts.length === 3) {
          const followUpId = parts[1];
          const action = parts[2];

          let intent: "completed" | "not_yet" | "snooze" | "cancelled" = "completed";
          let snoozeMins: number | undefined;
          let feedback = "Done!";

          if (action === "done") {
            intent = "completed";
            feedback = "Marked as done!";
          } else if (action === "not_yet") {
            intent = "not_yet";
            feedback = "Got it, not done yet.";
          } else if (action.startsWith("snooze_")) {
            intent = "snooze";
            snoozeMins = parseInt(action.replace("snooze_", ""), 10) || 60;
            feedback = `Snoozed for ${snoozeMins}m`;
          }

          const result = await followUpService.handleFollowUpResponse(
            user.id,
            followUpId,
            intent,
            undefined,
            snoozeMins
          );

          await adapter.answerCallbackQuery?.(incomingCb.id, feedback);

          let replyText = "";
          if (intent === "completed") {
            replyText = "Great job! I've marked this commitment as completed.";
          } else if (intent === "not_yet") {
            replyText = "Understood. Let me know when you'd like to reschedule or if you need assistance.";
          } else if (intent === "snooze") {
            replyText = `Understood. I will check back in ${snoozeMins} minutes.`;
          }

          if (replyText && result.success) {
            await adapter.sendMessage({ userId: user.platformUserId, text: replyText });
          }
        } else {
          await adapter.answerCallbackQuery?.(incomingCb.id, "Acknowledged");
        }
        return;
      }

      // 2. Otherwise parse standard incoming message (text or voice)
      const incoming = adapter.parseIncomingWebhook(req.body);
      if (!incoming) return; // not a message we care about (receipt, sticker, etc.)

      // Check deduplication if updateId is present
      if (incoming.updateId) {
        const updateKey = `${adapter.platformName}:${incoming.updateId}`;
        const acquired = await userService.tryAcquireUpdate(updateKey, adapter.platformName);
        if (!acquired) {
          logger.info({ correlationId, updateKey, platform: adapter.platformName }, "Skipping duplicate webhook update");
          return;
        }
      }

      // 3. Handle voice/audio ingestion if incoming message contains audio
      if (incoming.audio) {
        const effectiveAudioService =
          audioIngestionService ??
          (process.env.GEMMA_API_KEY
            ? new AudioIngestionService(new GeminiTranscriptionProvider(process.env.GEMMA_API_KEY))
            : undefined);

        if (!effectiveAudioService) {
          logger.warn({ correlationId, platform: adapter.platformName }, "Audio message received but audio ingestion is not configured");
          await adapter.sendMessage({
            userId: incoming.platformUserId,
            text: "Voice message processing is currently unavailable.",
          });
          return;
        }

        const audioResult = await effectiveAudioService.processAudioMessage(adapter, incoming.audio);
        if (!audioResult.success || !audioResult.transcript) {
          await adapter.sendMessage({
            userId: incoming.platformUserId,
            text: audioResult.userMessage || "I couldn't make out that voice note. Could you try sending it again?",
          });
          return;
        }

        // Normalize transcribed audio directly into incoming text
        incoming.text = audioResult.transcript;
      }

      if (!incoming.text) {
        return;
      }

      await adapter.sendTypingIndicator?.(incoming.platformUserId);

      const user = await userService.getOrCreate(adapter.platformName, incoming.platformUserId);
      const reply = await orchestrator.handleMessage(user, incoming.text, correlationId);
      await adapter.sendMessage({ userId: user.platformUserId, text: reply });
    } catch (err) {
      logger.error({ err, correlationId, platform: adapter.platformName }, "Failed to process webhook message");
      // Deliberately don't leak error details back to the messaging platform.
    }
  });

  return router;
}
