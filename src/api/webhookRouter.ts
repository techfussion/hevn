import express, { Request, Response, Router } from "express";
import crypto from "crypto";
import type { MessagingAdapter } from "../adapters/MessagingAdapter";
import { ConversationOrchestrator } from "../orchestrator/ConversationOrchestrator";
import { UserService } from "../core/tasks/UserService";
import { logger } from "../utils/logger";

/**
 * Builds the webhook router for a given adapter. Every request goes
 * through: rate limiting (applied in index.ts) -> raw body capture
 * (needed for signature verification) -> signature check -> parse ->
 * deduplication -> orchestrate -> reply. Any failure at the signature
 * step returns 401 and the payload is never touched by business logic.
 */
export function buildWebhookRouter(
  adapter: MessagingAdapter,
  orchestrator: ConversationOrchestrator,
  userService: UserService
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
      const incoming = adapter.parseIncomingWebhook(req.body);
      if (!incoming) return; // not a text message we care about (receipt, sticker, etc.)

      // Check deduplication if updateId is present
      if (incoming.updateId) {
        const updateKey = `${adapter.platformName}:${incoming.updateId}`;
        const acquired = await userService.tryAcquireUpdate(updateKey, adapter.platformName);
        if (!acquired) {
          logger.info({ correlationId, updateKey, platform: adapter.platformName }, "Skipping duplicate webhook update");
          return;
        }
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

